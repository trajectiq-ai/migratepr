import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Scanner } from '../src/scanner';
import { Rewriter } from '../src/rewriter';
import { getTrack } from '../src/rules';
import { Finding, MigrationRule, SdkBumpRule } from '../src/types';

const track = getTrack('stripe-v12-to-v13');

/** Findings never carry sdk-bump rules; narrow for the rewriter. */
function ruleOf(id: string): Exclude<MigrationRule, SdkBumpRule> {
  const rule = track.rules.find(r => r.id === id)!;
  if (rule.kind === 'sdk-bump') throw new Error(`unexpected sdk-bump finding: ${id}`);
  return rule;
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Windows may hold locks briefly; the temp dir is disposable.
    }
  }
});

function makeRepo(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), 'migratepr-real-'));
  tmpDirs.push(repo);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return repo;
}

function findingsFor(repo: string): Finding[] {
  return new Scanner().scan(repo, track).findings;
}

describe('real-world scanner: cross-file wrappers', () => {
  it('follows destructured require() from a wrapper module to call sites', () => {
    const repo = makeRepo({
      'src/stripeClient.js': [
        "const Stripe = require('stripe');",
        "const stripe = new Stripe('sk_test', { apiVersion: '2022-11-15' });",
        'module.exports = { stripe };',
        '',
      ].join('\n'),
      'src/billing.js': [
        "const { stripe } = require('./stripeClient');",
        'async function cancel(id) {',
        '  return stripe.subscriptions.del(id);',
        '}',
        'module.exports = { cancel };',
        '',
      ].join('\n'),
    });
    const f = findingsFor(repo);
    expect(f.some(x => x.ruleId.endsWith('subscriptions-del-cancel') && x.file === 'src/billing.js')).toBe(true);
    expect(f.some(x => x.ruleId.endsWith('api-version-2023-08-16'))).toBe(true);
  });

  it('follows named ES imports from a wrapper module', () => {
    const repo = makeRepo({
      'src/stripe.js': [
        "import Stripe from 'stripe';",
        'export const stripe = new Stripe("sk_test");',
        '',
      ].join('\n'),
      'src/billing.ts': [
        "import { stripe } from './stripe';",
        'export const delSub = stripe.subscriptions.del;',
        '',
      ].join('\n'),
    });
    const f = findingsFor(repo);
    expect(f.some(x => x.file === 'src/billing.ts')).toBe(true);
  });

  it('resolves class clients built from an imported wrapper (this.client chains)', () => {
    const repo = makeRepo({
      'src/stripeClient.js': [
        "const Stripe = require('stripe');",
        "const stripe = new Stripe('sk');",
        'module.exports = { stripe };',
        '',
      ].join('\n'),
      'src/svc.js': [
        "const { stripe } = require('./stripeClient');",
        'class Svc {',
        '  constructor(client = stripe) { this.client = client; }',
        '  go(id) { return this.client.subscriptions.del(id); }',
        '}',
        '',
      ].join('\n'),
    });
    const f = findingsFor(repo);
    expect(f.some(x => x.file === 'src/svc.js' && x.snippet.includes('this.client.subscriptions.del'))).toBe(true);
  });

  it('reports value-position method references (mock setup, assertions, bindings)', () => {
    const repo = makeRepo({
      'src/a.js': [
        "const Stripe = require('stripe');",
        "const stripe = new Stripe('sk');",
        "stripe.subscriptions.del.mockResolvedValue({ status: 'canceled' });",
        'const bound = stripe.subscriptions.del;',
        '',
      ].join('\n'),
    });
    const f = findingsFor(repo);
    const valueRefs = f.filter(x => x.ruleId.endsWith('subscriptions-del-cancel'));
    expect(valueRefs.length).toBe(2); // .del.mockResolvedValue + const bound
  });
});

describe('real-world scanner: test doubles', () => {
  it('finds removed method keys in hand-written mocks', () => {
    const repo = makeRepo({
      '__mocks__/stripe.js': [
        'const instance = {',
        '  subscriptions: {',
        '    del: jest.fn(),',
        '  },',
        '};',
        'module.exports = jest.fn(() => instance);',
        '',
      ].join('\n'),
    });
    const f = findingsFor(repo);
    expect(f.some(x => x.ruleKind === 'mock-method-key' && x.snippet.includes('del:'))).toBe(true);
  });

  it('never rewrites objects passed to a real SDK construction', () => {
    const repo = makeRepo({
      'src/client.js': [
        "const Stripe = require('stripe');",
        'const stripe = new Stripe("sk", {',
        '  apiVersion: "2022-11-15",',
        '  subscriptions: { del: true },',
        '});',
        '',
      ].join('\n'),
    });
    const f = findingsFor(repo);
    expect(f.some(x => x.ruleKind === 'mock-method-key')).toBe(false);
  });
});

describe('real-world rewriter', () => {
  it('rewrites the wrapper call, the mock key, and the assertion contract', () => {
    const repo = makeRepo({
      'src/stripeClient.js': [
        "const Stripe = require('stripe');",
        "const stripe = new Stripe('sk');",
        'module.exports = { stripe };',
        '',
      ].join('\n'),
      'src/billing.js': [
        "const { stripe } = require('./stripeClient');",
        'const create = stripe.checkout.sessions.create;',
        'export async function go(rateId) {',
        '  return create({ shipping_rates: [rateId] });',
        '}',
        '',
      ].join('\n'),
      '__mocks__/stripe.js': [
        'const instance = { subscriptions: { del: jest.fn() } };',
        'module.exports = jest.fn(() => instance);',
        '',
      ].join('\n'),
      '__tests__/b.test.js': [
        "test('contract', () => {",
        '  expect(create).toHaveBeenCalledWith(',
        "    expect.objectContaining({ shipping_rates: ['sr_1'] }),",
        '  );',
        '});',
        '',
      ].join('\n'),
      'package.json': '{"name":"t","version":"1.0.0"}',
    });

    const scanner = new Scanner();
    const scan = scanner.scan(repo, track);
    const rewriter = new Rewriter();
    let rewrote = 0;
    for (const finding of scan.findings) {
      const result = rewriter.apply(ruleOf(finding.ruleId), finding, repo);
      if (result) rewrote++;
    }
    expect(rewrote).toBe(scan.findings.length);

    const billing = readFileSync(join(repo, 'src/billing.js'), 'utf8');
    expect(billing).toContain('shipping_options: [{ shipping_rate: rateId }]');
    const mock = readFileSync(join(repo, '__mocks__/stripe.js'), 'utf8');
    expect(mock).toContain('cancel: jest.fn()');
    const testFile = readFileSync(join(repo, '__tests__/b.test.js'), 'utf8');
    expect(testFile).toContain("shipping_options: [{ shipping_rate: 'sr_1' }]");
  });

  it('rewrites value-position references in place', () => {
    const repo = makeRepo({
      'src/a.js': [
        "const Stripe = require('stripe');",
        "const stripe = new Stripe('sk');",
        "stripe.subscriptions.del.mockResolvedValue({ status: 'canceled' });",
        '',
      ].join('\n'),
    });
    const f = findingsFor(repo).find(x => x.ruleId.endsWith('subscriptions-del-cancel'))!;
    const result = new Rewriter().apply(ruleOf(f.ruleId), f, repo);
    expect(result).not.toBeNull();
    const after = readFileSync(join(repo, 'src/a.js'), 'utf8');
    expect(after).toContain('stripe.subscriptions.cancel.mockResolvedValue');
  });
});
