import { LlmProvider, MigrationTrack } from './types';
import { parseTrack, RULE_KINDS } from './config';
import { Scanner } from './scanner';

/**
 * AI rule generation (P1): feed an official vendor migration guide (markdown)
 * and get a validated MigrationTrack back. The LLM's output is treated as an
 * untrusted draft — it must pass the exact same structural validation as a
 * hand-written .migratepr.json track (parseTrack), and every rule must carry
 * its source URL. Nothing is ever executed or merged without validation.
 */

export interface RulegenInput {
  /** Full text of the official migration guide (markdown). */
  guideText: string;
  vendor: string;
  sdkModule: string;
  sdkFrom: number;
  sdkTo: number;
  apiFrom: string;
  apiTo: string;
  trackId?: string;
  guideUrl?: string;
  provider: LlmProvider;
  /** Cap on generated rules (LLMs love to over-generate). */
  maxRules?: number;
}

export interface RulegenOutput {
  track: MigrationTrack;
  /** Raw LLM response (for debugging). */
  raw: string;
  warnings: string[];
}

const RULE_SCHEMA = `
You extract migration rules from an official SDK upgrade guide. The output is a JSON object
with a single key "rules": an array of rule objects. Every rule object has these common fields:

  - "id": string, unique, namespaced like "<vendor>-v<from>-to-v<to>:<kebab-name>"
  - "kind": one of the kinds below
  - "summary": string, one sentence describing the breaking change
  - "guideUrl": string, URL of the source section (or the guide URL given to you)
  - "guideExcerpt": string (optional), a short verbatim quote from the guide
  - "risk": "mechanical" | "review-recommended" | "semantic"
  - "needsLlm": true only when the change CANNOT be expressed by the deterministic
    kinds below (e.g. reshaping object shapes, inlining a config class).

Rule kinds (deterministic, no LLM needed):
  1. method-rename   { resource, from, to }
     Renames a method on a resource chain, e.g. resource "subscriptions", from "del", to "cancel".
     resource "" means the method hangs directly off the client object.
  2. method-move     { fromResource, from, to }
     Moves a client-level method into a namespaced resource, e.g. fromResource "", from
     "createCompletion", to "completions.create". "to" is a full dotted chain.
  3. param-rename    { resource, method?, from, to, wrapTemplate? }
     Renames a key inside an object-literal argument of a call, e.g. resource
     "checkout.sessions", method "create", from "shipping_rates", to "shipping_options".
     "wrapTemplate" (optional) reshapes an array value: "$0" is replaced by each element,
     e.g. "{ shipping_rate: $0 }" turns shipping_rates: [a, b] into shipping_options: [{ shipping_rate: a }, { shipping_rate: b }].
  4. api-version     { from, to }
     The pinned API version string changed, e.g. from "2022-11-15" to "2023-08-16".
  5. mock-method-key { resource, from, to }
     A test mock object imitating the SDK must rename a method key, e.g. resource
     "subscriptions", from "del", to "cancel". resource "" = the mock object itself.
  6. client-constructor { from, to, needsLlm: true }
     The client constructor changed shape (e.g. new OpenAIApi(config) -> new OpenAI({ apiKey })).
     ALWAYS needsLlm: true for this kind.
  7. sdk-bump        { packageName, to }
     The npm dependency must be bumped, e.g. packageName "stripe", to "^13.11.0".

Rules of conduct:
  - ONLY extract changes that are actually described in the guide. Never invent rules.
  - Prefer the deterministic kinds whenever the change is mechanical.
  - Do NOT create rules for APIs that were merely removed without an equivalent —
    those are semantic decisions, skip them.
  - Each rule needs an "id" unique within this track and a "summary".
  - EVERY field listed for a rule kind is required (except those marked optional).
    Never omit "from" or "to": put the old name in "from" and the new name in "to".
  - Reply with ONLY the JSON object — no markdown fences, no commentary.

Worked example (for a guide saying "widgets.destroy was renamed to widgets.remove"):
{
  "rules": [
    {
      "id": "acme-v1-to-v2:widgets-destroy",
      "kind": "method-rename",
      "resource": "widgets",
      "from": "destroy",
      "to": "remove",
      "summary": "widgets.destroy() was renamed to widgets.remove().",
      "guideUrl": "https://example.com/acme/v2-migration",
      "guideExcerpt": "widgets.destroy was renamed to widgets.remove",
      "risk": "mechanical"
    },
    {
      "id": "acme-v1-to-v2:sdk-bump",
      "kind": "sdk-bump",
      "packageName": "acme",
      "to": "^2.0.0",
      "summary": "Bump the acme SDK to v2.",
      "guideUrl": "https://example.com/acme/v2-migration",
      "risk": "mechanical"
    }
  ]
}
`.trim();

export function buildRulegenPrompt(input: RulegenInput): { system: string; user: string } {
  const trackId = input.trackId ?? `${input.vendor}-v${input.sdkFrom}-to-v${input.sdkTo}`;
  const user = [
    `Migration track metadata:`,
    `  id:        ${trackId}`,
    `  vendor:    ${input.vendor}`,
    `  sdkModule: ${input.sdkModule} (npm package)`,
    `  sdkFrom:   ${input.sdkFrom}`,
    `  sdkTo:     ${input.sdkTo}`,
    `  apiFrom:   ${input.apiFrom}`,
    `  apiTo:     ${input.apiTo}`,
    input.guideUrl ? `  guideUrl:  ${input.guideUrl}` : '',
    `  maxRules:  ${input.maxRules ?? 25}`,
    '',
    `=== OFFICIAL MIGRATION GUIDE (markdown) ===`,
    input.guideText,
    '',
    'Return the rules JSON now.',
  ]
    .filter(line => line !== '')
    .join('\n');
  return { system: RULE_SCHEMA, user };
}

/** Unwrap a single markdown fence if the model added one anyway. */
function unwrapFences(text: string): string {
  const m = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  return (m ? m[1] : text).trim();
}

/**
 * Find the outermost JSON value in the response, object or array, tolerating
 * prose around it. Weaker models like to answer with a bare `rules` array or a
 * full track envelope, so both shapes must survive extraction.
 */
function extractJsonValue(text: string): string {
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  const asArray = arrStart >= 0 && (objStart < 0 || arrStart < objStart);
  const start = asArray ? arrStart : objStart;
  const end = asArray ? text.lastIndexOf(']') : text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('LLM response contained no JSON object or array');
  return text.slice(start, end + 1);
}

/**
 * Generate a validated migration track from an official guide. Throws on any
 * structural invalidity — an LLM draft never ships unvalidated.
 */
export async function generateRulesFromGuide(input: RulegenInput): Promise<RulegenOutput> {
  const warnings: string[] = [];
  const { system, user } = buildRulegenPrompt(input);
  const raw = await input.provider.complete(system, user);
  const cleaned = unwrapFences(raw);
  const rawForDebug = cleaned.length > 600 ? cleaned.slice(0, 600) + '…' : cleaned;
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonValue(cleaned));
  } catch (err) {
    throw new Error(
      `rulegen: LLM output was not valid JSON — ${(err as Error).message}. Raw response:\n${rawForDebug}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`rulegen: LLM output was not JSON. Raw response:\n${rawForDebug}`);
  }
  // Tolerate every reasonable shape: { "rules": [...] }, a bare array, or a
  // full track envelope the model echoed back.
  const root = parsed as Record<string, unknown> | unknown[];
  const rulesField = Array.isArray(root) ? root : (root as Record<string, unknown>).rules;
  if (!Array.isArray(rulesField) || rulesField.length === 0) {
    throw new Error(`rulegen: LLM output had no "rules" array. Raw response:\n${rawForDebug}`);
  }
  let rulesRaw = rulesField as unknown[];
  const maxRules = input.maxRules ?? 25;
  if (rulesRaw.length > maxRules) {
    warnings.push(`LLM produced ${rulesRaw.length} rules — capped at ${maxRules} (raise --max-rules if needed)`);
    rulesRaw = rulesRaw.slice(0, maxRules);
  }

  // Weaker models invent rule kinds (e.g. "removed-method"). Those cannot be
  // executed deterministically, so drop them with a warning rather than
  // failing the whole draft — the surviving rules still validate strictly.
  const known = rulesRaw.filter(r => {
    const kind = r !== null && typeof r === 'object' && !Array.isArray(r)
      ? (r as Record<string, unknown>).kind
      : undefined;
    return typeof kind === 'string' && RULE_KINDS.has(kind);
  });
  const dropped = rulesRaw.length - known.length;
  if (dropped > 0) {
    const kinds = [
      ...new Set(
        rulesRaw
          .filter(r => !known.includes(r))
          .map(r => String((r as Record<string, unknown>)?.kind ?? '<missing kind>')),
      ),
    ];
    warnings.push(`dropped ${dropped} rule(s) with unsupported kinds: ${kinds.join(', ')}`);
  }
  if (known.length === 0) {
    throw new Error(
      `rulegen: no generated rule used a supported kind (${[...RULE_KINDS].join(', ')}). Raw response:\n${rawForDebug}`,
    );
  }
  rulesRaw = known;

  const trackId = input.trackId ?? `${input.vendor}-v${input.sdkFrom}-to-v${input.sdkTo}`;
  // Reuse the exact same structural validation as .migratepr.json tracks.
  let track: MigrationTrack;
  try {
    track = parseTrack(
      {
        id: trackId,
        vendor: input.vendor,
        sdkModule: input.sdkModule,
        sdkFrom: input.sdkFrom,
        sdkTo: input.sdkTo,
        apiFrom: input.apiFrom,
        apiTo: input.apiTo,
        guideUrls: input.guideUrl ? [input.guideUrl] : ['<local migration guide>'],
        rules: rulesRaw,
      },
      0,
    );
  } catch (err) {
    throw new Error(
      `rulegen: generated rules failed validation: ${(err as Error).message}. Raw response:\n${rawForDebug}`,
    );
  }

  // Sanity: sdk-bump rule must target the track's own module.
  const badBumps = track.rules.filter(
    (r): r is Extract<typeof r, { kind: 'sdk-bump' }> =>
      r.kind === 'sdk-bump' && r.packageName !== input.sdkModule,
  );
  if (badBumps.length > 0) {
    warnings.push(
      `dropped ${badBumps.length} sdk-bump rule(s) targeting '${badBumps[0].packageName}' — ` +
        `the track migrates '${input.sdkModule}'`,
    );
    track.rules = track.rules.filter(
      r => r.kind !== 'sdk-bump' || r.packageName === input.sdkModule,
    );
  }
  const hasBump = track.rules.some(r => r.kind === 'sdk-bump');
  if (!hasBump) {
    warnings.push('no sdk-bump rule generated — add one so the dependency is actually upgraded');
  }

  return { track, raw, warnings };
}

/**
 * Smoke-test a generated (or hand-written) track against a real repo: scan it
 * and report how many findings each rule fires. This is the "does the rule
 * actually match real code" check — cheap, deterministic, no LLM.
 */
export function smokeTestTrack(
  track: MigrationTrack,
  repoPath: string,
): Array<{ ruleId: string; findings: number; sampleFile?: string }> {
  const scan = new Scanner().scan(repoPath, track);
  const counts = new Map<string, { findings: number; sampleFile?: string }>();
  for (const f of scan.findings) {
    const prev = counts.get(f.ruleId) ?? { findings: 0 };
    counts.set(f.ruleId, {
      findings: prev.findings + 1,
      sampleFile: prev.sampleFile ?? f.file,
    });
  }
  return [...counts.entries()]
    .map(([ruleId, v]) => ({ ruleId, ...v }))
    .sort((a, b) => b.findings - a.findings);
}