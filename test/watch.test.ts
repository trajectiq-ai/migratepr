import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeFingerprint, watchCycle, WatchOptions } from '../src/watch';
import { getTrack } from '../src/rules';
import { MigrateReport, MigrateStatus } from '../src/types';

function fakeMigrate(calls: { n: number }, fail = false): NonNullable<WatchOptions['migrateFn']> {
  return (async () => {
    calls.n++;
    if (fail) throw new Error('boom');
    const report = {
      status: 'migrated' as MigrateStatus,
      findings: [],
      rewrites: [],
      skipped: [],
      baseline: null,
      post: null,
      diff: null,
      pr: null,
      logs: [],
    } as unknown as MigrateReport;
    return report;
  }) as NonNullable<WatchOptions['migrateFn']>;
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  delete process.env.MIGRATEPR_DATA_DIR;
});

function makeRepo(withFinding = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'watch-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'watch-test',
        dependencies: { stripe: '^12.18.0' },
        scripts: { test: 'node -e "process.exit(0)"' },
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    join(dir, 'src', 'pay.js'),
    withFinding
      ? [
          "const { stripe } = require('./client');",
          'async function cancelSub(id) {',
          '  return stripe.subscriptions.del(id);',
          '}',
          'module.exports = { cancelSub };',
          '',
        ].join('\n')
      : ['module.exports = { ok: true };', ''].join('\n'),
    'utf8',
  );
  return dir;
}

function makeTrackRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'watch-track-'));
  tmpDirs.push(dir);
  // Real track rule fixture: uses the actual stripe track against a real repo shape.
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'track', dependencies: { stripe: '^12.18.0' } }, null, 2),
    'utf8',
  );
  writeFileSync(join(dir, 'client.js'), "const Stripe = require('stripe');\nconst stripe = new Stripe('sk_x', { apiVersion: '2022-11-15' });\nmodule.exports = { stripe };\n", 'utf8');
  return dir;
}

function makeClient(dir: string): void {
  // pay.js lives in src/ and requires './client' → src/client.js
  writeFileSync(join(dir, 'src', 'client.js'), "const Stripe = require('stripe');\nconst stripe = new Stripe('sk_x', { apiVersion: '2022-11-15' });\nmodule.exports = { stripe };\n", 'utf8');
}

describe('computeFingerprint', () => {
  it('is stable for unchanged repos and differs when a call site changes', () => {
    const dir = makeRepo();
    makeClient(dir);
    const a = computeFingerprint(dir).fp;
    const b = computeFingerprint(dir).fp;
    expect(b).toBe(a);

    // New call site → fingerprint changes.
    writeFileSync(
      join(dir, 'src', 'pay.js'),
      [
        "const { stripe } = require('./client');",
        'async function cancelSub(id) {',
        '  return stripe.subscriptions.del(id);',
        '}',
        'async function renewSub(id) {',
        '  return stripe.subscriptions.del(id);', // second (duplicate) site
        '}',
        'module.exports = { cancelSub, renewSub };',
        '',
      ].join('\n'),
      'utf8',
    );
    const c = computeFingerprint(dir).fp;
    expect(c).not.toBe(a);
  });

  it('detects the sdk-bump dimension (pin still on old major)', () => {
    const dir = makeTrackRepo();
    const before = computeFingerprint(dir);
    expect(before.bumpPending).toBe(true);
    expect(before.findings).toBeGreaterThan(0);
  });
});

describe('watchCycle', () => {
  it('runs the pipeline on the first cycle and skips unchanged repos after', async () => {
    const dir = makeRepo();
    makeClient(dir);
    process.env.MIGRATEPR_DATA_DIR = dir + '-data';
    const calls = { n: 0 };
    const fn = fakeMigrate(calls);

    const first = await watchCycle({ repos: [{ repoPath: dir }], migrateFn: fn });
    expect(first[0].skipped).toBe(false);
    expect(calls.n).toBe(1);

    const second = await watchCycle({ repos: [{ repoPath: dir }], migrateFn: fn });
    expect(second[0].skipped).toBe(true);
    expect(calls.n).toBe(1); // no re-run
  });

  it('does not run the pipeline for repos with nothing to migrate', async () => {
    const dir = makeRepo(false);
    makeClient(dir);
    // Rewrite the pin to the target major so nothing is pending.
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { stripe: '^13.11.0' } }, null, 2),
      'utf8',
    );
    const calls = { n: 0 };
    const fn = fakeMigrate(calls);
    const results = await watchCycle({ repos: [{ repoPath: dir }], migrateFn: fn });
    expect(results[0].skipped).toBe(true);
    expect(calls.n).toBe(0);
  });

  it('persists state so a fresh runner resumes without re-running', async () => {
    const dir = makeRepo();
    makeClient(dir);
    const dataDir = dir + '-data';
    process.env.MIGRATEPR_DATA_DIR = dataDir;
    const calls = { n: 0 };
    const fn = fakeMigrate(calls);

    await watchCycle({ repos: [{ repoPath: dir }], migrateFn: fn });
    expect(calls.n).toBe(1);

    // A brand-new runner (same data dir) must skip: state came from disk.
    const again = await watchCycle({ repos: [{ repoPath: dir }], migrateFn: fn });
    expect(again[0].skipped).toBe(true);
    expect(calls.n).toBe(1);
  });

  it('re-runs after the repo changes post-delivery (new call site)', async () => {
    const dir = makeRepo();
    makeClient(dir);
    process.env.MIGRATEPR_DATA_DIR = dir + '-data';
    const calls = { n: 0 };
    const fn = fakeMigrate(calls);

    await watchCycle({ repos: [{ repoPath: dir }], migrateFn: fn });
    expect(calls.n).toBe(1);

    // Simulate the migration landing: source now uses the new API.
    writeFileSync(
      join(dir, 'src', 'pay.js'),
      [
        "const { stripe } = require('./client');",
        'async function cancelSub(id) {',
        '  return stripe.subscriptions.cancel(id);',
        '}',
        'module.exports = { cancelSub };',
        '',
      ].join('\n'),
      'utf8',
    );
    const results = await watchCycle({ repos: [{ repoPath: dir }], migrateFn: fn });
    expect(results[0].skipped).toBe(false);
    expect(calls.n).toBe(2);
  });

  it('handles repos with no applicable track gracefully', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-nomig-'));
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'plain' }, null, 2), 'utf8');
    const results = await watchCycle({ repos: [{ repoPath: dir }] });
    expect(results[0].skipped).toBe(true);
    expect(results[0].outcome).toBe('clean');
  });
});

describe('watch with the real stripe track', () => {
  it('detects findings for a pinned old SDK and reports bump pending', () => {
    const dir = makeTrackRepo();
    const track = getTrack('stripe-v12-to-v13');
    const scan = computeFingerprint(dir);
    expect(scan.bumpPending).toBe(true);
    expect(track.id).toBe('stripe-v12-to-v13');
  });
});