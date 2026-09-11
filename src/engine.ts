import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { Project } from 'ts-morph';
import {
  Finding,
  LlmProvider,
  MigrationRule,
  MigrationTrack,
  RewriteResult,
} from './types';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAiProvider } from './providers/openai';
import { GroqProvider } from './providers/groq';
import { MistralProvider } from './providers/mistral';
import { DeepSeekProvider } from './providers/deepseek';
import { OpenRouterProvider } from './providers/openrouter';
import { OllamaProvider, isOllamaAvailable } from './providers/ollama';
import { OpenAiCompatibleProvider } from './providers/openai-compatible';
import { readDefaultProvider } from './doctor';

/** All supported providers, in priority order for auto-detection. */
export const SUPPORTED_LLM_PROVIDERS = [
  'anthropic',
  'openai',
  'groq',
  'mistral',
  'deepseek',
  'openrouter',
  'ollama',
] as const;

export type SupportedLlmProvider = (typeof SUPPORTED_LLM_PROVIDERS)[number];

/** Env vars that activate a cloud provider, in priority order. */
const PROVIDER_ENV_KEYS: Array<[SupportedLlmProvider, string]> = [
  ['anthropic', 'ANTHROPIC_API_KEY'],
  ['openai', 'OPENAI_API_KEY'],
  ['groq', 'GROQ_API_KEY'],
  ['mistral', 'MISTRAL_API_KEY'],
  ['deepseek', 'DEEPSEEK_API_KEY'],
  ['openrouter', 'OPENROUTER_API_KEY'],
];

export const NO_PROVIDER_HINT =
  'no LLM provider configured (set ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, '
  + 'MISTRAL_API_KEY, DEEPSEEK_API_KEY or OPENROUTER_API_KEY, point MIGRATEPR_BASE_URL at any '
  + 'OpenAI-compatible endpoint, or start Ollama for fully-local rewrites — run "migratepr doctor" '
  + 'to detect local runtimes automatically; force a provider with MIGRATEPR_LLM_PROVIDER)';

function buildProvider(name: string): LlmProvider | null {
  switch (name) {
    case 'anthropic': return new AnthropicProvider();
    case 'openai': return new OpenAiProvider();
    case 'groq': return new GroqProvider();
    case 'mistral': return new MistralProvider();
    case 'deepseek': return new DeepSeekProvider();
    case 'openrouter': return new OpenRouterProvider();
    case 'ollama': return new OllamaProvider();
    default: return null;
  }
}

/**
 * Generic OpenAI-compatible endpoint — LM Studio, llama.cpp, vLLM, LocalAI,
 * Jan, KoboldCpp, LiteLLM, Azure OpenAI, or a company gateway. Anything that
 * speaks /v1/chat/completions works with no code changes. Configured by env
 * (MIGRATEPR_BASE_URL / MIGRATEPR_MODEL / MIGRATEPR_API_KEY) or by a default
 * saved from `migratepr doctor`. Not part of the named registry because it has
 * no key or signup of its own.
 */
export function buildCustomProvider(
  opts: { baseUrl?: string; model?: string; apiKey?: string } = {},
): LlmProvider | null {
  const raw = (opts.baseUrl ?? process.env.MIGRATEPR_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  // Accept both "http://host:port" and "http://host:port/v1".
  const baseUrl = /\/v\d+$/.test(raw) ? `${raw}/chat/completions` : `${raw}/v1/chat/completions`;
  return new OpenAiCompatibleProvider({
    name: 'custom',
    baseUrl,
    apiKey: opts.apiKey ?? process.env.MIGRATEPR_API_KEY,
    defaultModel: (opts.model ?? process.env.MIGRATEPR_MODEL ?? '').trim() || 'local-model',
    timeoutMs: 300_000,
    attempts: 1,
  });
}

/**
 * Pick the LLM provider for this run.
 *
 * Priority:
 *   1. explicit MIGRATEPR_LLM_PROVIDER (validated — fails loudly)
 *   2. a cloud API key present in the environment
 *   3. MIGRATEPR_BASE_URL (any OpenAI-compatible endpoint)
 *   4. the default saved by `migratepr doctor` at install time
 *   5. a reachable local Ollama (zero-config)
 *   6. null — rules engine only, which needs no LLM
 */
export async function makeLlmProvider(): Promise<LlmProvider | null> {
  const forced = process.env.MIGRATEPR_LLM_PROVIDER?.trim().toLowerCase();
  if (forced) {
    if (forced === 'custom') {
      const custom = buildCustomProvider();
      if (!custom) {
        throw new Error(
          'MIGRATEPR_LLM_PROVIDER=custom needs MIGRATEPR_BASE_URL (e.g. http://127.0.0.1:1234/v1)',
        );
      }
      return custom;
    }
    const provider = buildProvider(forced);
    if (!provider) {
      throw new Error(
        `Unknown MIGRATEPR_LLM_PROVIDER '${forced}' — supported: ${SUPPORTED_LLM_PROVIDERS.join(', ')}, `
        + `or 'custom' with MIGRATEPR_BASE_URL`,
      );
    }
    if (forced === 'ollama' && !(await isOllamaAvailable())) {
      const host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
      throw new Error(`Ollama is not reachable at ${host} — is "ollama serve" running?`);
    }
    return provider;
  }

  for (const [name, envVar] of PROVIDER_ENV_KEYS) {
    if (process.env[envVar]) return buildProvider(name);
  }

  // Explicit generic endpoint beats a saved default (same specificity as a key).
  const fromEnv = buildCustomProvider();
  if (fromEnv) return fromEnv;

  // A default saved by `migratepr doctor` (install-time discovery).
  const saved = readDefaultProvider();
  if (saved) {
    if (saved.provider === 'custom') {
      const custom = buildCustomProvider({ baseUrl: saved.baseUrl, model: saved.model });
      if (custom) return custom;
    } else if (saved.provider === 'ollama') {
      if (await isOllamaAvailable()) return new OllamaProvider(saved.model);
    } else {
      const named = buildProvider(saved.provider);
      if (named) return named;
    }
  }

  // Zero-config local fallback: a running Ollama counts as configured.
  if (await isOllamaAvailable()) return new OllamaProvider();
  return null;
}

export function buildLlmPrompt(
  track: MigrationTrack,
  rule: MigrationRule,
  finding: Finding,
  source: string,
): { system: string; user: string } {
  const system = [
    'You are a precise code migration agent for third-party API upgrades.',
    'You will be given ONE file, ONE official migration rule, and the affected call site.',
    'Apply exactly that rule. Change nothing else: preserve formatting, comments,',
    'imports, and all unrelated code byte-for-byte wherever possible.',
    'Respond with ONLY the complete updated file content — no markdown fences, no commentary.',
  ].join(' ');

  const guidePart = [
    `Vendor: ${track.vendor}`,
    `Migration guide(s): ${track.guideUrls.join(', ')}`,
    `Rule: ${rule.id}`,
    `What changed: ${rule.summary}`,
    rule.guideExcerpt ? `Official guide excerpt:\n"""\n${rule.guideExcerpt}\n"""` : '',
    `Rule source: ${rule.guideUrl}`,
  ]
    .filter(Boolean)
    .join('\n');

  const user = [
    guidePart,
    '',
    `Affected call site in ${finding.file} at line ${finding.line}:`,
    finding.snippet,
    '',
    `=== FILE: ${finding.file} ===`,
    source,
    '',
    'Return the complete updated file now.',
  ].join('\n');

  return { system, user };
}

/** Unwrap a single markdown code fence if the model added one anyway. */
function unwrapFences(text: string): string {
  const m = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  return (m ? m[1] : text).trim();
}

function looksLikeValidCode(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * LLM rewrite for rules that cannot be expressed deterministically
 * (needsLlm) or when the operator forces the llm engine. The output is
 * validated before it is written; invalid output becomes a skipped finding,
 * never a silent guess.
 */
export async function llmRewrite(
  provider: LlmProvider,
  track: MigrationTrack,
  rule: MigrationRule,
  finding: Finding,
  repoPath: string,
): Promise<RewriteResult> {
  const absPath = path.join(repoPath, finding.file);
  const before = fs.readFileSync(absPath, 'utf8');
  const { system, user } = buildLlmPrompt(track, rule, finding, before);

  const raw = await provider.complete(system, user);
  // Tolerate a single wrapper fence; reject everything else that smells like prose.
  const code = unwrapFences(raw);
  if (!looksLikeValidCode(code)) {
    throw new Error(`LLM output rejected (empty) for ${finding.file}:${finding.line}`);
  }

  // Validate that the required change actually happened before writing.
  const required: string[] = [];
  if (rule.kind === 'method-rename') required.push(`.${rule.to}(`);
  if (rule.kind === 'method-move') required.push(`.${rule.to}(`);
  if (rule.kind === 'param-rename') required.push(rule.to);
  if (rule.kind === 'api-version') required.push(`'${rule.to}'`);
  if (rule.kind === 'client-constructor') required.push(`new ${rule.to}(`);
  if (required.some(token => !code.includes(token))) {
    throw new Error(
      `LLM output rejected (missing expected change) for ${finding.file}:${finding.line}`,
    );
  }

  // Syntax sanity check: transpileModule reports syntax diagnostics only
  // (no type-checking or module resolution), which is exactly the gate we want.
  const { diagnostics } = ts.transpileModule(code, {
    fileName: 'candidate.ts',
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  });
  if (diagnostics && diagnostics.length > 0) {
    const first = diagnostics[0];
    const line = first.file
      ? ts.getLineAndCharacterOfPosition(first.file, first.start ?? 0).line + 1
      : '?';
    throw new Error(
      `LLM output rejected (syntax error at line ${line}) for ${finding.file}:${finding.line}`,
    );
  }

  fs.writeFileSync(absPath, code, 'utf8');
  return {
    ruleId: rule.id,
    file: finding.file,
    line: finding.line,
    before: finding.snippet,
    after: `(whole-file rewrite by ${provider.name})`,
    engine: 'llm',
  };
}
