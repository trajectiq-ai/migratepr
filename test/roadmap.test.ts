import { createHmac } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Scanner } from '../src/scanner';
import { Rewriter } from '../src/rewriter';
import { resolveTrackForRepo, TRACKS } from '../src/rules';
import { migrate } from '../src/migrate';
import { generateRulesFromGuide, smokeTestTrack } from '../src/rulegen';
import { buildAppManifest, decideWebhookAction, verifyWebhookSignature } from '../src/github-app';
import { LlmProvider, MigrationTrack, VerifyFnInput } from '../src/types';

const openaiTrack: MigrationTrack = TRACKS.find(t => t.id === 'openai-v3-to-v4')!;

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migratepr-roadmap-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

const OPENAI_V3_JS = `const { Configuration, OpenAIApi } = require('openai');
const configuration = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
const openai = new OpenAIApi(configuration);

async function chat(messages) {
  const r = await openai.createChatCompletion({ model: 'gpt-4', messages });
  return r.data.choices[0].message;
}
async function embed(input) {
  return openai.createEmbedding({ model: 'text-embedding-ada-002', input });
}
const listModels = openai.listModels;
module.exports = { chat, embed, listModels };
`;

describe('openai v3 → v4 track', () => {
  it('auto-detects from package.json', () => {
    write('package.json', JSON.stringify({ dependencies: { openai: '^3.3.0' } }));
    expect(resolveTrackForRepo(tmp).id).toBe('openai-v3-to-v4');
  });

  it('scans flat-method calls, bindings, and the constructor', () => {
    write('src/client.js', OPENAI_V3_JS);
    const res = new Scanner().scan(tmp, openaiTrack);
    const ruleIds = res.findings.map(f => f.ruleId);
    expect(ruleIds).toContain('openai-v3-to-v4:create-chat-completion');
    expect(ruleIds).toContain('openai-v3-to-v4:create-embedding');
    expect(ruleIds).toContain('openai-v3-to-v4:list-models');
    expect(ruleIds).toContain('openai-v3-to-v4:client-constructor');
  });

  it('rewrites flat methods into namespaced resources', () => {
    write('src/client.js', OPENAI_V3_JS);
    const scan = new Scanner().scan(tmp, openaiTrack);
    const rules = new Map(openaiTrack.rules.map(r => [r.id, r]));

    for (const f of scan.findings) {
      const rule = rules.get(f.ruleId);
      if (!rule) continue;
      if (rule.kind === 'method-move') {
        expect(new Rewriter().apply(rule, f, tmp)).not.toBeNull();
      }
    }
    const out = fs.readFileSync(path.join(tmp, 'src', 'client.js'), 'utf8');
    expect(out).toContain('openai.chat.completions.create({');
    expect(out).toContain('openai.embeddings.create({');
    expect(out).toContain('const listModels = openai.models.list;');
    // The constructor rule is needsLlm — the deterministic engine refuses it.
    const ctorFinding = scan.findings.find(f => f.ruleId.endsWith('client-constructor'))!;
    const ctorRule = rules.get(ctorFinding.ruleId)!;
    expect(ctorRule.kind).toBe('client-constructor');
    expect(new Rewriter().apply(ctorRule, ctorFinding, tmp)).toBeNull();
  });

  it('runs the full pipeline (rules engine, fake verify)', async () => {
    write('package.json', JSON.stringify({
      name: 'fixture',
      scripts: { test: 'node tests/run.js' },
      dependencies: { openai: '^3.3.0' },
    }));
    write('src/client.js', OPENAI_V3_JS);
    write('tests/run.js', 'console.log("ok")');
    fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });

    const verifyFn = (o: VerifyFnInput) => ({
      ok: true, stage: o.stage, command: o.command, exitCode: 0, output: 'ok', durationMs: 1,
    });
    const report = await migrate({ repoPath: tmp, engine: 'rules', dryRun: true, verifyFn });
    expect(report.status).toBe('migrated');
    expect(report.track.id).toBe('openai-v3-to-v4');
    expect(report.rewrites.some(r => r.ruleId === 'openai-v3-to-v4:create-chat-completion')).toBe(true);
    expect(report.rewrites.some(r => r.ruleId === 'openai-v3-to-v4:sdk-bump-v4')).toBe(true);
    // constructor change needs the LLM — rules engine skips it, never guesses
    expect(report.skipped.some(s => s.ruleId === 'openai-v3-to-v4:client-constructor')).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
    expect(pkg.dependencies.openai).toBe('^4.0.0');
  });
});

/* --------------------------------- verify gates --------------------------------- */

function seedGateRepo(extraScripts: Record<string, string>): void {
  write('package.json', JSON.stringify({
    name: 'fixture',
    scripts: { test: 'node tests/run.js', ...extraScripts },
    dependencies: { stripe: '^12.18.0' },
  }));
  write('src/billing.js', `const Stripe = require('stripe');
const stripe = new Stripe('sk');
const s = stripe.subscriptions.del('sub_1');`);
  write('tests/run.js', 'console.log("ok")');
  fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
}

describe('verify gates (typecheck/build/lint)', () => {
  it('records passing gates at both stages', async () => {
    seedGateRepo({ typecheck: 'node -e "process.exit(0)"' });
    const report = await migrate({ repoPath: tmp, engine: 'rules', dryRun: true, verifyGates: ['typecheck'] });
    expect(report.status).toBe('migrated');
    expect(report.gates).toHaveLength(1);
    expect(report.gates![0].name).toBe('typecheck');
    expect(report.gates![0].baseline.ok).toBe(true);
    expect(report.gates![0].post.ok).toBe(true);
  });

  it('aborts when a baseline gate fails', async () => {
    seedGateRepo({ lint: 'node -e "process.exit(1)"' });
    const report = await migrate({ repoPath: tmp, engine: 'rules', dryRun: true, verifyGates: ['lint'] });
    expect(report.status).toBe('aborted');
    expect(report.reason).toMatch(/Baseline gate 'lint' failed/);
    // nothing was rewritten
    expect(report.rewrites).toHaveLength(0);
  });

  it('reverts everything when a post-migration gate fails', async () => {
    // A gate that passes only while the pin is still ^12 — fails after the bump.
    seedGateRepo({
      pincheck: 'node -e "const p=require(\'./package.json\');process.exit(p.dependencies.stripe.startsWith(\'^12\')?0:1)"',
    });
    const report = await migrate({ repoPath: tmp, engine: 'rules', dryRun: true, verifyGates: ['pincheck'] });
    expect(report.status).toBe('aborted');
    expect(report.reason).toMatch(/Post-migration gate 'pincheck' failed/);
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
    expect(pkg.dependencies.stripe).toBe('^12.18.0'); // reverted
    const src = fs.readFileSync(path.join(tmp, 'src', 'billing.js'), 'utf8');
    expect(src).toContain('subscriptions.del'); // reverted
  });

  it('skips gates whose npm script does not exist (with a log note)', async () => {
    seedGateRepo({});
    const report = await migrate({ repoPath: tmp, engine: 'rules', dryRun: true, verifyGates: ['build'] });
    expect(report.status).toBe('migrated');
    expect(report.gates).toHaveLength(0);
    expect(report.logs?.some(l => /gate 'build' has no npm script/.test(l))).toBe(true);
  });
});

/* ----------------------------------- rulegen ----------------------------------- */

const fakeProvider = (reply: string): LlmProvider => ({
  name: 'fake',
  complete: async () => reply,
});

const VALID_RULES_JSON = JSON.stringify({
  rules: [
    {
      id: 'acme-v1-to-v2:widget-rename',
      kind: 'method-rename',
      resource: 'widgets',
      from: 'destroy',
      to: 'remove',
      summary: 'widgets.destroy was renamed to widgets.remove',
      guideUrl: 'https://example.com/guide',
      risk: 'mechanical',
    },
    {
      id: 'acme-v1-to-v2:sdk-bump',
      kind: 'sdk-bump',
      packageName: 'acme',
      to: '^2.0.0',
      summary: 'bump the acme SDK',
      guideUrl: 'https://example.com/guide',
      risk: 'mechanical',
    },
  ],
});

describe('rulegen (AI rule generation)', () => {
  const base = {
    guideText: '# Acme v2 guide\nwidgets.destroy is now widgets.remove.',
    vendor: 'acme',
    sdkModule: 'acme',
    sdkFrom: 1,
    sdkTo: 2,
    apiFrom: 'v1',
    apiTo: 'v2',
  };

  it('validates LLM output into a real track (same schema as .migratepr.json)', async () => {
    const out = await generateRulesFromGuide({ ...base, provider: fakeProvider(VALID_RULES_JSON) });
    expect(out.track.id).toBe('acme-v1-to-v2');
    expect(out.track.rules).toHaveLength(2);
    expect(out.track.rules[0].kind).toBe('method-rename');
    expect(out.track.rules[1].kind).toBe('sdk-bump');
    // The track round-trips through the config validator.
    expect(out.track.rules[0].guideUrl).toBe('https://example.com/guide');
  });

  it('accepts a fence-wrapped response', async () => {
    const out = await generateRulesFromGuide({
      ...base,
      provider: fakeProvider('```json\n' + VALID_RULES_JSON + '\n```'),
    });
    expect(out.track.rules).toHaveLength(2);
  });

  it('rejects invalid JSON and rule-less output loudly', async () => {
    await expect(
      generateRulesFromGuide({ ...base, provider: fakeProvider('I do not understand.') }),
    ).rejects.toThrow(/not valid JSON/);
    await expect(
      generateRulesFromGuide({ ...base, provider: fakeProvider('{"nope": 1}') }),
    ).rejects.toThrow(/no "rules" array/);
  });

  it('drops sdk-bump rules for the wrong package with a warning', async () => {
    const wrong = JSON.stringify({
      rules: [
        {
          id: 'acme-v1-to-v2:bad-bump',
          kind: 'sdk-bump',
          packageName: 'some-other-pkg',
          to: '^9.0.0',
          summary: 'bump',
          guideUrl: 'https://example.com',
          risk: 'mechanical',
        },
      ],
    });
    const out = await generateRulesFromGuide({ ...base, provider: fakeProvider(wrong) });
    expect(out.track.rules.filter(r => r.kind === 'sdk-bump')).toHaveLength(0);
    expect(out.warnings.some(w => /dropped 1 sdk-bump/.test(w))).toBe(true);
  });

  it('accepts a bare rules array and a full track envelope', async () => {
    const bare = await generateRulesFromGuide({
      ...base,
      provider: fakeProvider(JSON.stringify(JSON.parse(VALID_RULES_JSON).rules)),
    });
    expect(bare.track.rules).toHaveLength(2);

    const envelope = await generateRulesFromGuide({
      ...base,
      provider: fakeProvider(JSON.stringify({ id: 'acme-v1-to-v2', vendor: 'acme', rules: JSON.parse(VALID_RULES_JSON).rules })),
    });
    expect(envelope.track.rules).toHaveLength(2);
  });

  it('drops rules with unsupported kinds and keeps the valid ones', async () => {
    const mixed = JSON.stringify({
      rules: [
        { id: 'x:invented', kind: 'removed-method', summary: 'invented', guideUrl: 'u', risk: 'semantic' },
        ...JSON.parse(VALID_RULES_JSON).rules,
      ],
    });
    const out = await generateRulesFromGuide({ ...base, provider: fakeProvider(mixed) });
    expect(out.track.rules).toHaveLength(2);
    expect(out.warnings.some(w => /dropped 1 rule\(s\).*removed-method/.test(w))).toBe(true);
  });

  it('errors when no generated rule uses a supported kind', async () => {
    const allBad = JSON.stringify({
      rules: [{ id: 'x:invented', kind: 'removed-method', summary: 'invented', guideUrl: 'u', risk: 'semantic' }],
    });
    await expect(
      generateRulesFromGuide({ ...base, provider: fakeProvider(allBad) }),
    ).rejects.toThrow(/no generated rule used a supported kind/);
  });

  it('smoke-tests generated rules against a real repo', async () => {
    write('package.json', JSON.stringify({ dependencies: { acme: '^1.0.0' } }));
    write('src/a.js', `const acme = require('acme');\nacme.widgets.destroy('w_1');`);
    const out = await generateRulesFromGuide({ ...base, provider: fakeProvider(VALID_RULES_JSON) });
    const hits = smokeTestTrack(out.track, tmp);
    expect(hits.some(h => h.ruleId === 'acme-v1-to-v2:widget-rename' && h.findings === 1)).toBe(true);
  });
});

/* ---------------------------------- github app ---------------------------------- */

describe('github-app', () => {
  it('builds a minimal-scope manifest', () => {
    const m = buildAppManifest({ name: 'migratepr', url: 'https://github.com/trajectiq-ai/migratepr' });
    expect(m.name).toBe('migratepr');
    expect((m.default_permissions as Record<string, string>).pull_requests).toBe('write');
    expect(m.default_events).toEqual(['push', 'pull_request']);
  });

  it('verifies webhook signatures (timing-safe, sha256= prefix)', () => {
    const payload = '{"action":"pushed"}';
    const secret = 'whsec_123';
    const sig = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    expect(verifyWebhookSignature(payload, sig, secret)).toBe(true);
    expect(verifyWebhookSignature(payload, 'sha256=' + '0'.repeat(64), secret)).toBe(false);
    expect(verifyWebhookSignature(payload, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(payload, sig, '')).toBe(false);
  });

  it('triggers on dependency pushes to the default branch', () => {
    const push = {
      ref: 'refs/heads/main',
      repository: { full_name: 'acme/app', default_branch: 'main' },
      commits: [{ modified: ['package.json'] }],
    };
    const d = decideWebhookAction('push', push);
    expect(d.migrate).toBe(true);
    expect(d.repoFullName).toBe('acme/app');
  });

  it('ignores non-default pushes, dep-less pushes, and PR events', () => {
    const repo = { full_name: 'acme/app', default_branch: 'main' };
    expect(
      decideWebhookAction('push', { ref: 'refs/heads/feature-x', repository: repo }).migrate,
    ).toBe(false);
    expect(
      decideWebhookAction('push', { ref: 'refs/heads/main', repository: repo, commits: [{ modified: ['src/a.js'] }] }).migrate,
    ).toBe(false);
    expect(
      decideWebhookAction('pull_request', { repository: repo, action: 'opened' }).migrate,
    ).toBe(false);
    expect(decideWebhookAction('schedule', { repository: repo }).migrate).toBe(true);
  });
});