import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Scanner } from '../src/scanner';
import { Rewriter } from '../src/rewriter';
import { bumpSdkDependency } from '../src/bump';
import { TRACKS, resolveTrackForRepo } from '../src/rules';
import { Finding, ApiVersionRule, MethodRenameRule, MigrationTrack, ParamRenameRule } from '../src/types';

const track: MigrationTrack = TRACKS[0]; // stripe-v12-to-v13

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migratepr-'));
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

describe('rule registry', () => {
  it('has unique rule ids across all tracks', () => {
    const ids = TRACKS.flatMap(t => t.rules.map(r => r.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('auto-detects the v12→v13 track from package.json', () => {
    write('package.json', JSON.stringify({ dependencies: { stripe: '^12.18.0' } }));
    expect(resolveTrackForRepo(tmp).id).toBe('stripe-v12-to-v13');
  });
});

describe('scanner', () => {
  it('finds method renames, param renames through aliases, and api-version pins', () => {
    write(
      'src/billing.js',
      `
const Stripe = require('stripe');
const stripe = new Stripe('sk_test', { apiVersion: '2022-11-15' });
const createSession = stripe.checkout.sessions.create;

async function go(rateId, subId) {
  await createSession({ mode: 'payment', shipping_rates: [rateId] });
  await stripe.subscriptions.del(subId);
}
`,
    );
    const res = new Scanner().scan(tmp, track);

    const ruleIds = res.findings.map(f => f.ruleId).sort();
    expect(ruleIds).toContain('stripe-v12-to-v13:subscriptions-del-cancel');
    expect(ruleIds).toContain('stripe-v12-to-v13:checkout-shipping-options');
    expect(ruleIds).toContain('stripe-v12-to-v13:api-version-2023-08-16');
    expect(res.filesScanned).toBe(1);
  });

  it('ignores unrelated calls and wrong api versions', () => {
    write(
      'src/other.js',
      `
const Stripe = require('stripe');
const stripe = new Stripe('sk', { apiVersion: '2099-01-01' });
stripe.subscriptions.cancel('sub_1');
stripe.invoices.retrieveUpcoming();
`,
    );
    const res = new Scanner().scan(tmp, track);
    expect(res.findings).toHaveLength(0);
  });
});

describe('rewriter', () => {
  it('renames subscriptions.del to subscriptions.cancel', () => {
    write('src/billing.js', `const Stripe = require('stripe');
const stripe = new Stripe('sk');
const s = stripe.subscriptions.del('sub_1');`);
    const scan = new Scanner().scan(tmp, track);
    const finding = scan.findings.find(f => f.ruleId.endsWith('subscriptions-del-cancel'))!;
    expect(finding).toBeTruthy();

    const rule = track.rules.find(
      (r): r is MethodRenameRule => r.kind === 'method-rename' && r.from === 'del',
    )!;
    const result = new Rewriter().apply(rule, finding, tmp);
    expect(result?.after).toContain('.cancel(');
    expect(fs.readFileSync(path.join(tmp, 'src/billing.js'), 'utf8')).toContain(
      'stripe.subscriptions.cancel',
    );
  });

  it('renames shipping_rates and reshapes values into shipping_options', () => {
    write('src/s.js', `const Stripe = require('stripe');
const stripe = new Stripe('sk');
const s = stripe.checkout.sessions.create({ shipping_rates: ['sr_1', 'sr_2'] });`);
    const scan = new Scanner().scan(tmp, track);
    const finding = scan.findings.find(f => f.ruleId.endsWith('checkout-shipping-options'))!;
    expect(finding).toBeTruthy();

    const rule = track.rules.find(
      (r): r is ParamRenameRule => r.kind === 'param-rename' && r.from === 'shipping_rates',
    )!;
    const result = new Rewriter().apply(rule, finding, tmp);
    expect(result?.after).toContain("shipping_options: [{ shipping_rate: 'sr_1' }, { shipping_rate: 'sr_2' }]");
  });

  it('updates a pinned apiVersion string', () => {
    write('src/c.js', `const Stripe = require('stripe');
const stripe = new Stripe('sk', { apiVersion: '2022-11-15' });`);
    const scan = new Scanner().scan(tmp, track);
    const finding = scan.findings.find(f => f.ruleId.endsWith('api-version-2023-08-16'))!;
    expect(finding).toBeTruthy();

    const rule = track.rules.find((r): r is ApiVersionRule => r.kind === 'api-version')!;
    new Rewriter().apply(rule, finding, tmp);
    expect(fs.readFileSync(path.join(tmp, 'src/c.js'), 'utf8')).toContain("apiVersion: '2023-08-16'");
  });
});

describe('bump', () => {
  it('bumps the stripe dependency range', () => {
    write('package.json', JSON.stringify({ dependencies: { stripe: '^12.18.0' } }, null, 2));
    const rule = track.rules.find(r => r.kind === 'sdk-bump')!;
    const result = bumpSdkDependency(rule, tmp);
    expect(result?.after).toContain('^13');
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
    expect(pkg.dependencies.stripe).toBe('^13.11.0');
  });
});
