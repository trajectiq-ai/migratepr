import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, validateConfig } from '../src/config';
import { globToRegExp } from '../src/glob';
import { Scanner } from '../src/scanner';
import { Rewriter } from '../src/rewriter';
import { bumpSdkDependencies } from '../src/bump';
import { NoTestScriptError, resolveVerifyCommand, runTests } from '../src/verify';
import { migrate, runMigrate } from '../src/migrate';
import { llmRewrite } from '../src/engine';
import { TRACKS } from '../src/rules';
import {
  Finding,
  LlmProvider,
  MigrateOptions,
  SdkBumpRule,
  VerifyFnInput,
  VerifyResult,
} from '../src/types';

const track = TRACKS[0]; // stripe-v12-to-v13

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migratepr-ship-'));
});

afterEach(() => {
  // Windows can hold directory locks briefly after a killed child exits.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
});

function write(rel: string, content: string): string {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

const BILLING_JS = `const Stripe = require('stripe');
const stripe = new Stripe('sk_test', { apiVersion: '2022-11-15' });
async function cancel(id) {
  return stripe.subscriptions.del(id);
}
module.exports = { cancel };
`;

function seedRepo(dir: string, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  // Hermetic: an empty node_modules keeps ensureDependencies from npm-installing.
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      scripts: { test: 'node tests/run.js' },
      dependencies: { stripe: '^12.18.0' },
      ...extra,
    }),
  );
  fs.writeFileSync(path.join(dir, 'src', 'billing.js'), BILLING_JS);
  fs.writeFileSync(path.join(dir, 'tests', 'run.js'), 'console.log("ok")');
}

function okVerify(): (o: VerifyFnInput) => VerifyResult {
  return (o: VerifyFnInput) => ({
    ok: true,
    stage: o.stage,
    command: o.command,
    exitCode: 0,
    output: 'ok',
    durationMs: 1,
  });
}

const baseOpts = (repo: string): MigrateOptions => ({
  repoPath: repo,
  engine: 'rules',
  dryRun: true,
  verifyFn: okVerify(),
});

describe('config', () => {
  it('accepts a valid config', () => {
    const cfg = validateConfig({
      track: 'stripe-v12-to-v13',
      engine: 'rules',
      exclude: ['generated/'],
      skipRules: ['a'],
      verifyCommand: 'make test',
      verifyTimeoutMs: 5000,
      install: true,
      prBase: 'develop',
    });
    expect(cfg.track).toBe('stripe-v12-to-v13');
    expect(cfg.verifyTimeoutMs).toBe(5000);
  });

  it('rejects invalid values precisely', () => {
    expect(() => validateConfig({ engine: 'magic' })).toThrow(/engine/);
    expect(() => validateConfig({ verifyTimeoutMs: -1 })).toThrow(/verifyTimeoutMs/);
    expect(() => validateConfig({ exclude: 'src' })).toThrow(/exclude/);
    expect(() => validateConfig([])).toThrow(/JSON object/);
  });

  it('returns empty config when no file exists, and an error for invalid JSON', () => {
    expect(loadConfig(tmp).config).toEqual({});
    write('.migratepr.json', '{ nope');
    const res = loadConfig(tmp);
    expect(res.error).toMatch(/invalid config/);
    expect(res.file).toBe('.migratepr.json');
  });

  it('config drives track + skipRules end-to-end (precedence check)', async () => {
    seedRepo(tmp);
    write(
      '.migratepr.json',
      JSON.stringify({
        track: 'stripe-v17-to-v18',
        skipRules: ['stripe-v17-to-v18:sdk-bump-v18'],
      }),
    );
    const report = await migrate(baseOpts(tmp));
    expect(report.track.id).toBe('stripe-v17-to-v18');
    expect(report.findings).toHaveLength(0);
    expect(report.rewrites).toHaveLength(0);
  });

  it('runMigrate fails loudly on an invalid config file', async () => {
    seedRepo(tmp);
    write('.migratepr.json', JSON.stringify({ engine: 'bogus' }));
    await expect(runMigrate(baseOpts(tmp))).rejects.toThrow(/invalid config/);
  });
});

describe('glob exclusions', () => {
  it('directory prefix with trailing slash excludes contents', () => {
    const re = globToRegExp('generated/**');
    expect(re.test('generated/x.ts')).toBe(true);
    expect(re.test('src/x.ts')).toBe(false);
  });

  it('supports *, ?, and {a,b} alternation', () => {
    expect(globToRegExp('src/*.gen.ts').test('src/a.gen.ts')).toBe(true);
    expect(globToRegExp('src/*.gen.ts').test('src/sub/a.gen.ts')).toBe(false);
    expect(globToRegExp('test?.ts').test('test1.ts')).toBe(true);
    expect(globToRegExp('*.{ts,js}').test('a.js')).toBe(true);
    expect(globToRegExp('*.{ts,js}').test('a.py')).toBe(false);
  });

  it('scanner honors excludePatterns', async () => {
    seedRepo(tmp);
    const report = await migrate({ ...baseOpts(tmp), excludePatterns: ['src/**'] });
    expect(report.findings).toHaveLength(0);
    // only the sdk bump remains
    expect(report.rewrites).toHaveLength(1);
    expect(report.rewrites[0].engine).toBe('package-json');
  });
});

describe('scanner hardening', () => {
  it('detects destructured default imports and class-property clients', () => {
    write(
      'src/a.ts',
      `
import { default as Stripe } from 'stripe';
class Payments {
  client = new Stripe('sk');
  async go(id: string) {
    await this.client.subscriptions.del(id);
  }
}
`,
    );
    const res = new Scanner().scan(tmp, track);
    expect(res.findings.map(f => f.ruleId)).toContain(
      'stripe-v12-to-v13:subscriptions-del-cancel',
    );
  });

  it('skips dot-directories during the walk', () => {
    write('.hidden/keep.js', "const Stripe = require('stripe'); const s = new Stripe('k'); s.subscriptions.del('x');");
    const res = new Scanner().scan(tmp, track);
    expect(res.filesScanned).toBe(0);
  });
});

describe('verify', () => {
  it('treats npm placeholder test scripts as absent', () => {
    write('package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(resolveVerifyCommand(tmp).isPlaceholder).toBe(true);
    expect(() => runTests(tmp, 'baseline')).toThrow(NoTestScriptError);
  });

  it('honors a custom verify command', () => {
    write('package.json', JSON.stringify({ scripts: { test: 'echo placeholder && exit 1' } }));
    write('check.js', 'console.log("custom ok")');
    const res = runTests(tmp, 'baseline', { verifyCommand: 'node check.js' });
    expect(res.ok).toBe(true);
    expect(res.command).toBe('node check.js');
  });

  it('reports exit 124 on verify timeout', () => {
    write('package.json', JSON.stringify({ scripts: { test: 'node -e "setTimeout(()=>{},3000)"' } }));
    const res = runTests(tmp, 'baseline', { timeoutMs: 200 });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(124);
  }, 10_000);
});

describe('safety guards', () => {
  it('rewriter refuses paths outside the repo and package.json', () => {
    const finding: Finding = {
      id: 'f1',
      ruleId: 'stripe-v12-to-v13:subscriptions-del-cancel',
      ruleKind: 'method-rename',
      file: '../outside.js',
      line: 1,
      column: 1,
      snippet: "stripe.subscriptions.del('x')",
    };
    const rule = track.rules.find(
      (r): r is Extract<typeof r, { kind: 'method-rename' }> => r.kind === 'method-rename',
    )!;
    expect(new Rewriter().apply(rule, finding, tmp)).toBeNull();

    finding.file = 'package.json';
    expect(new Rewriter().apply(rule, finding, tmp)).toBeNull();
  });

  it('refuses --push outside a git checkout', async () => {
    seedRepo(tmp);
    await expect(migrate({ ...baseOpts(tmp), dryRun: false })).rejects.toThrow(
      /not a git checkout/,
    );
  });

  it('refuses --push on a dirty tree', async () => {
    seedRepo(tmp);
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init'], { cwd: tmp });
    // untracked files => dirty
    await expect(migrate({ ...baseOpts(tmp), dryRun: false })).rejects.toThrow(/dirty/);
  });

  it('require-git refuses non-checkouts even in dry-run', async () => {
    seedRepo(tmp);
    await expect(migrate({ ...baseOpts(tmp), requireGit: true })).rejects.toThrow(
      /not a git checkout/,
    );
  });
});

describe('bump + engine hardening', () => {
  it('applies multiple SDK bumps in one package.json pass', () => {
    write(
      'package.json',
      JSON.stringify({ dependencies: { stripe: '^12.18.0', '@stripe/stripe-js': '^1.0.0' } }, null, 2),
    );
    const rules: SdkBumpRule[] = [
      {
        id: 't:stripe',
        kind: 'sdk-bump',
        packageName: 'stripe',
        to: '^13.11.0',
        summary: 'bump stripe',
        guideUrl: 'https://example.com',
        risk: 'mechanical',
      },
      {
        id: 't:stripe-js',
        kind: 'sdk-bump',
        packageName: '@stripe/stripe-js',
        to: '^2.0.0',
        summary: 'bump stripe-js',
        guideUrl: 'https://example.com',
        risk: 'mechanical',
      },
    ];
    const results = bumpSdkDependencies(rules, tmp);
    expect(results).toHaveLength(2);
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
    expect(pkg.dependencies.stripe).toBe('^13.11.0');
    expect(pkg.dependencies['@stripe/stripe-js']).toBe('^2.0.0');
  });

  it('accepts an LLM rewrite that arrives wrapped in a single code fence', async () => {
    seedRepo(tmp);
    const rewritten = BILLING_JS.replace('subscriptions.del', 'subscriptions.cancel');
    const provider: LlmProvider = {
      name: 'fake',
      complete: async () => '```js\n' + rewritten + '\n```',
    };
    const finding: Finding = {
      id: 'f1',
      ruleId: 'stripe-v12-to-v13:subscriptions-del-cancel',
      ruleKind: 'method-rename',
      file: 'src/billing.js',
      line: 4,
      column: 1,
      snippet: 'stripe.subscriptions.del(id)',
    };
    const result = await llmRewrite(provider, track, track.rules[0], finding, tmp);
    expect(result.engine).toBe('llm');
    expect(fs.readFileSync(path.join(tmp, 'src', 'billing.js'), 'utf8')).toContain('.cancel(');
  });
});
