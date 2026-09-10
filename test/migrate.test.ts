import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate';
import { buildLlmPrompt, llmRewrite } from '../src/engine';
import { TRACKS } from '../src/rules';
import { Finding, LlmProvider, MigrateOptions, VerifyFnInput, VerifyResult } from '../src/types';

const track = TRACKS[0]; // stripe-v12-to-v13

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migratepr-e2e-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const BILLING_JS = `const Stripe = require('stripe');
const stripe = new Stripe('sk_test_demo', { apiVersion: '2022-11-15' });
const createSession = stripe.checkout.sessions.create;

async function checkout(cents, rateId) {
  return createSession({ mode: 'payment', shipping_rates: [rateId], line_items: [] });
}

async function cancel(subId) {
  return stripe.subscriptions.del(subId);
}

module.exports = { checkout, cancel };
`;

function seedDemoRepo(dir: string, testScript = 'node tests/run.js'): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fixture',
    scripts: { test: testScript },
    dependencies: { stripe: '^12.18.0' },
  }));
  fs.writeFileSync(path.join(dir, 'src', 'billing.js'), BILLING_JS);
  fs.writeFileSync(path.join(dir, 'tests', 'run.js'), 'console.log("ok")');
}

function fakeVerify(ok = true): (o: VerifyFnInput) => VerifyResult {
  return (o: VerifyFnInput) => ({
    ok: o.stage === 'baseline' ? ok : ok,
    stage: o.stage,
    command: o.command,
    exitCode: ok ? 0 : 1,
    output: 'fake',
    durationMs: 1,
  });
}

const baseOpts = (repo: string): MigrateOptions => ({
  repoPath: repo,
  engine: 'rules',
  dryRun: true,
  verifyFn: fakeVerify(true),
});

describe('migrate pipeline', () => {
  it('produces a migrated report with PR payload when tests pass', async () => {
    seedDemoRepo(tmp);
    const report = await migrate(baseOpts(tmp));

    expect(report.status).toBe('migrated');
    expect(report.findings.length).toBeGreaterThanOrEqual(3);
    expect(report.rewrites.map(r => r.ruleId)).toContain('stripe-v12-to-v13:subscriptions-del-cancel');
    expect(report.rewrites.map(r => r.ruleId)).toContain('stripe-v12-to-v13:sdk-bump-v13');
    expect(report.pr?.title).toContain('v12 → v13');
    expect(report.pr?.body).toContain('Post-migration test run: green');
    // rewritten on disk
    expect(fs.readFileSync(path.join(tmp, 'src', 'billing.js'), 'utf8')).toContain('.cancel(');
  });

  it('aborts and reverts everything when post-migration tests fail', async () => {
    seedDemoRepo(tmp);
    const before = fs.readFileSync(path.join(tmp, 'src', 'billing.js'), 'utf8');
    const opts = baseOpts(tmp);
    opts.verifyFn = (o: VerifyFnInput) =>
      o.stage === 'post-migration'
        ? { ok: false, stage: o.stage, command: o.command, exitCode: 1, output: 'boom', durationMs: 1 }
        : { ok: true, stage: o.stage, command: o.command, exitCode: 0, output: 'ok', durationMs: 1 };

    const report = await migrate(opts);
    expect(report.status).toBe('aborted');
    expect(report.pr).toBeNull();
    // files restored byte-for-byte
    expect(fs.readFileSync(path.join(tmp, 'src', 'billing.js'), 'utf8')).toBe(before);
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
    expect(pkg.dependencies.stripe).toBe('^12.18.0');
  });

  it('aborts when the baseline is red — before touching any file', async () => {
    seedDemoRepo(tmp);
    const opts = baseOpts(tmp);
    opts.verifyFn = (o: VerifyFnInput) =>
      o.stage === 'baseline'
        ? { ok: false, stage: o.stage, command: o.command, exitCode: 1, output: 'pre-existing failure', durationMs: 1 }
        : { ok: true, stage: o.stage, command: o.command, exitCode: 0, output: 'ok', durationMs: 1 };

    const report = await migrate(opts);
    expect(report.status).toBe('aborted');
    expect(report.reason).toContain('Baseline');
    expect(fs.readFileSync(path.join(tmp, 'src', 'billing.js'), 'utf8')).toBe(BILLING_JS);
  });

  it('refuses repos without a test script (diff-review mode)', async () => {
    seedDemoRepo(tmp, undefined);
    fs.rmSync(path.join(tmp, 'tests'), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: { stripe: '^12.18.0' } }),
    );
    const report = await migrate(baseOpts(tmp));
    expect(report.status).toBe('diff-review');
    expect(report.rewrites).toHaveLength(0);
  });
});

describe('llm engine', () => {
  const finding = (file: string, line: number): Finding => ({
    id: 'f1',
    ruleId: 'stripe-v12-to-v13:subscriptions-del-cancel',
    ruleKind: 'method-rename',
    file,
    line,
    column: 1,
    snippet: "stripe.subscriptions.del('sub_1')",
  });

  const provider = (reply: string): LlmProvider => ({
    name: 'fake',
    complete: async () => reply,
  });

  it('builds a guide-constrained prompt', () => {
    const source = "const x = stripe.subscriptions.del('sub_1');";
    const { system, user } = buildLlmPrompt(
      track,
      track.rules[0],
      finding('src/a.ts', 1),
      source,
    );
    expect(system).toContain('migration agent');
    expect(user).toContain('Migration guide(s)');
    expect(user).toContain(source);
  });

  it('accepts a valid whole-file rewrite', async () => {
    seedDemoRepo(tmp);
    const rewritten = BILLING_JS.replace('subscriptions.del', 'subscriptions.cancel');
    const result = await llmRewrite(
      provider(rewritten),
      track,
      track.rules[0],
      finding('src/billing.js', 10),
      tmp,
    );
    expect(result.engine).toBe('llm');
    expect(fs.readFileSync(path.join(tmp, 'src', 'billing.js'), 'utf8')).toContain('.cancel(');
  });

  it('rejects fenced or wrong output without writing', async () => {
    seedDemoRepo(tmp);
    const before = fs.readFileSync(path.join(tmp, 'src', 'billing.js'), 'utf8');
    await expect(
      llmRewrite(
        provider('```js\nnope\n```'),
        track,
        track.rules[0],
        finding('src/billing.js', 10),
        tmp,
      ),
    ).rejects.toThrow('rejected');
    expect(fs.readFileSync(path.join(tmp, 'src', 'billing.js'), 'utf8')).toBe(before);
  });
});
