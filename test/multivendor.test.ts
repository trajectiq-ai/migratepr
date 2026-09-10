import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Scanner } from '../src/scanner';
import { Rewriter } from '../src/rewriter';
import { TRACKS, getTrack, resolveTrackForRepo, withCustomTracks } from '../src/rules';
import { validateConfig } from '../src/config';
import { migrate } from '../src/migrate';
import { Finding, MethodRenameRule, MigrationTrack, VerifyFnInput, VerifyResult } from '../src/types';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migratepr-mv-'));
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

const EXPRESS_TRACK = getTrack('express-v4-to-v5');

const customTrack: MigrationTrack = {
  id: 'acme-sdk-v1-to-v2',
  vendor: 'acme',
  sdkModule: '@acme/sdk',
  sdkFrom: 1,
  sdkTo: 2,
  apiFrom: '1',
  apiTo: '2',
  guideUrls: ['https://docs.acme.example/migration-v2'],
  rules: [
    {
      id: 'acme-sdk-v1-to-v2:widgets-destroy',
      kind: 'method-rename',
      resource: 'widgets',
      from: 'destroy',
      to: 'remove',
      summary: 'widgets.destroy() was renamed to widgets.remove() in v2.',
      guideUrl: 'https://docs.acme.example/migration-v2',
      risk: 'mechanical',
    },
    {
      id: 'acme-sdk-v1-to-v2:mock-widgets-destroy',
      kind: 'mock-method-key',
      resource: 'widgets',
      from: 'destroy',
      to: 'remove',
      summary: 'Test mocks imitating the SDK must drop widgets.destroy too.',
      guideUrl: 'https://docs.acme.example/migration-v2',
      risk: 'mechanical',
    },
    {
      id: 'acme-sdk-v1-to-v2:sdk-bump',
      kind: 'sdk-bump',
      packageName: '@acme/sdk',
      to: '^2.0.0',
      summary: 'Bump @acme/sdk to ^2.',
      guideUrl: 'https://docs.acme.example/migration-v2',
      risk: 'mechanical',
    },
  ],
};

describe('Express v4 → v5 track', () => {
  it('is registered and auto-detected from package.json', () => {
    write('package.json', JSON.stringify({ dependencies: { express: '^4.21.0' } }));
    expect(resolveTrackForRepo(tmp).id).toBe('express-v4-to-v5');
  });

  it('scanner catches app.del through a factory-call client binding', () => {
    write('package.json', JSON.stringify({ dependencies: { express: '^4.21.0' } }));
    write(
      'src/app.js',
      `const express = require('express');
const app = express();

app.del('/users/:id', (req, res) => res.send('ok'));
`,
    );
    const res = new Scanner().scan(tmp, EXPRESS_TRACK);
    const ids = res.findings.map(f => f.ruleId);
    expect(ids).toContain('express-v4-to-v5:app-del-delete');
  });

  it('scanner catches app.del with ESM imports', () => {
    write('package.json', JSON.stringify({ dependencies: { express: '^4.21.0' } }));
    write(
      'src/app.ts',
      `import express from 'express';
const app = express();
app.del('/x', handler);
`,
    );
    const res = new Scanner().scan(tmp, EXPRESS_TRACK);
    expect(res.findings.map(f => f.ruleId)).toContain('express-v4-to-v5:app-del-delete');
  });

  it('rewriter converts app.del to app.delete', () => {
    write('package.json', JSON.stringify({ dependencies: { express: '^4.21.0' } }));
    write(
      'src/app.js',
      `const express = require('express');
const app = express();
app.del('/users/:id', handler);
`,
    );
    const scan = new Scanner().scan(tmp, EXPRESS_TRACK);
    const finding = scan.findings.find(f => f.ruleId.endsWith('app-del-delete'))!;
    expect(finding).toBeTruthy();

    const rule = EXPRESS_TRACK.rules.find(
      (r): r is MethodRenameRule => r.kind === 'method-rename' && r.from === 'del',
    )!;
    const result = new Rewriter().apply(rule, finding, tmp);
    expect(result?.after).toContain('app.delete(');
    expect(fs.readFileSync(path.join(tmp, 'src/app.js'), 'utf8')).toContain('app.delete(');
  });

  it('scanner finds del keys in Express mock objects (resource-less mock)', () => {
    write('package.json', JSON.stringify({ dependencies: { express: '^4.21.0' } }));
    write(
      '__tests__/app.test.js',
      `const app = {
  del: jest.fn(),
  get: jest.fn(),
};
`,
    );
    const res = new Scanner().scan(tmp, EXPRESS_TRACK);
    expect(res.findings.map(f => f.ruleId)).toContain('express-v4-to-v5:mock-app-del-delete');
  });

  it('bump rewrites express to ^5', async () => {
    write('package.json', JSON.stringify({ dependencies: { express: '^4.21.0' } }, null, 2));
    const rule = EXPRESS_TRACK.rules.find(r => r.kind === 'sdk-bump')!;
    const { bumpSdkDependency } = await import('../src/bump');
    const result = bumpSdkDependency(rule, tmp);
    expect(result?.after).toContain('^5');
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
    expect(pkg.dependencies.express).toBe('^5.0.0');
  });

  it('does not fire on Express 5 repos (no false positives)', () => {
    write('package.json', JSON.stringify({ dependencies: { express: '^5.0.0' } }));
    write(
      'src/app.js',
      `const express = require('express');
const app = express();
app.delete('/users/:id', handler);
`,
    );
    const res = new Scanner().scan(tmp, EXPRESS_TRACK);
    expect(res.findings).toHaveLength(0);
  });
});

describe('JSON rule DSL (custom tracks in .migratepr.json)', () => {
  it('accepts a valid custom track through config validation', () => {
    const cfg = validateConfig({ tracks: [customTrack] });
    expect(cfg.tracks?.[0].id).toBe('acme-sdk-v1-to-v2');
    expect(cfg.tracks?.[0].rules[0].kind).toBe('method-rename');
  });

  it('rejects tracks with invalid rules', () => {
    expect(() =>
      validateConfig({
        tracks: [
          { ...customTrack, rules: [{ kind: 'method-rename', resource: 'x', from: 'a' }] },
        ],
      }),
    ).toThrow(/risk/);
    expect(() => validateConfig({ tracks: [{ ...customTrack, sdkFrom: '4.x' }] })).toThrow(/sdkFrom/);
  });

  it('custom tracks override built-ins with the same id', () => {
    const overridden = withCustomTracks([
      { ...customTrack, id: 'stripe-v12-to-v13' },
    ]);
    expect(overridden.find(t => t.id === 'stripe-v12-to-v13')?.sdkModule).toBe('@acme/sdk');
  });

  it('scanner runs a custom track against a custom SDK', () => {
    write('package.json', JSON.stringify({ dependencies: { '@acme/sdk': '^1.5.0' } }));
    write(
      'src/use.js',
      `const acme = require('@acme/sdk');
acme.widgets.destroy('w_1');
`,
    );
    const res = new Scanner().scan(tmp, customTrack);
    expect(res.findings.map(f => f.ruleId)).toContain('acme-sdk-v1-to-v2:widgets-destroy');
  });

  it('full pipeline: custom track migrates a repo via .migratepr.json', async () => {
    write(
      '.migratepr.json',
      JSON.stringify({
        tracks: [customTrack],
      }),
    );
    write('package.json', JSON.stringify({
      name: 'acme-app',
      scripts: { test: 'node tests/run.js' },
      dependencies: { '@acme/sdk': '^1.5.0' },
    }));
    write(
      'src/use.js',
      `const acme = require('@acme/sdk');
acme.widgets.destroy('w_1');
`,
    );
    write('tests/run.js', 'console.log("ok")');

    const verify = (o: VerifyFnInput): VerifyResult => ({
      ok: true,
      stage: o.stage,
      command: o.command,
      exitCode: 0,
      output: 'fake',
      durationMs: 1,
    });

    const report = await migrate({
      repoPath: tmp,
      engine: 'rules',
      dryRun: true,
      verifyFn: verify,
    });

    expect(report.status).toBe('migrated');
    expect(report.track.id).toBe('acme-sdk-v1-to-v2');
    expect(report.rewrites.map(r => r.ruleId)).toContain('acme-sdk-v1-to-v2:widgets-destroy');
    expect(fs.readFileSync(path.join(tmp, 'src/use.js'), 'utf8')).toContain('widgets.remove(');
  });

  it('full pipeline: custom track reaches the rewriter for mock keys', async () => {
    write(
      '.migratepr.json',
      JSON.stringify({
        tracks: [customTrack],
      }),
    );
    write('package.json', JSON.stringify({
      name: 'acme-app',
      scripts: { test: 'node tests/run.js' },
      dependencies: { '@acme/sdk': '^1.5.0' },
    }));
    write(
      '__tests__/x.test.js',
      `const acmeMock = {
  widgets: { destroy: jest.fn() },
};
`,
    );
    write('tests/run.js', 'console.log("ok")');

    const verify = (o: VerifyFnInput): VerifyResult => ({
      ok: true,
      stage: o.stage,
      command: o.command,
      exitCode: 0,
      output: 'fake',
      durationMs: 1,
    });

    const report = await migrate({
      repoPath: tmp,
      engine: 'rules',
      dryRun: true,
      verifyFn: verify,
    });
    expect(report.status).toBe('migrated');
    const text = fs.readFileSync(path.join(tmp, '__tests__/x.test.js'), 'utf8');
    expect(text).toContain('remove: jest.fn()');
  });
});

describe('registry coherence', () => {
  it('all tracks carry an sdkModule and unique ids', () => {
    expect(TRACKS.length).toBeGreaterThanOrEqual(3);
    const ids = new Set<string>();
    for (const t of TRACKS) {
      expect(t.sdkModule.length).toBeGreaterThan(0);
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
    }
    expect(TRACKS.some(t => t.id === 'stripe-v12-to-v13')).toBe(true);
    expect(TRACKS.some(t => t.id === 'express-v4-to-v5')).toBe(true);
  });

  it('watch fingerprint accepts custom tracks via config', async () => {
    const { computeFingerprint } = await import('../src/watch');
    write(
      '.migratepr.json',
      JSON.stringify({
        tracks: [customTrack],
      }),
    );
    write('package.json', JSON.stringify({ dependencies: { '@acme/sdk': '^1.5.0' } }));
    write(
      'src/use.js',
      `const acme = require('@acme/sdk');
acme.widgets.destroy('w_1');
`,
    );
    const fp = computeFingerprint(tmp);
    expect(fp.findings).toBeGreaterThan(0);
  });
});