import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';

/**
 * End-to-end tests for the web app: register → login → add key →
 * invalid-key test → queue migration → poll → inspect report.
 *
 * The suite runs the real HTTP server on an ephemeral port with an isolated
 * data directory. Key live-testing hits the network and is skipped unless
 * MIGRATEPR_WEB_TEST_LIVE_KEYS=1.
 */

const tmpDirs: string[] = [];
let server: Server | null = null;
let baseUrl = '';

afterEach(() => {
  if (server) {
    server.close();
    server = null;
  }
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* Windows file-lock races: ignore */
    }
  }
});

async function startApp(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'migratepr-web-'));
  tmpDirs.push(dir);
  process.env.MIGRATEPR_DATA_DIR = dir;
  const { startServer } = await import('../src/web/server');
  server = startServer();
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const addr = server.address();
  if (typeof addr !== 'object' || !addr) throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

interface R {
  status: number;
  body: Record<string, unknown>;
  setCookie?: string;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
): Promise<R> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      'Connection': 'close', // avoid undici keep-alive races with per-test servers
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  const setCookie = res.headers.get('set-cookie') ?? undefined;
  return { status: res.status, body: parsed, setCookie };
}

function cookieFrom(setCookie?: string): string | undefined {
  return setCookie?.split(';')[0];
}

/** A tiny but real repo: no test script → diff-review (no test-suite needed). */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'migratepr-repo-'));
  tmpDirs.push(dir);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'tiny', version: '1.0.0', dependencies: { stripe: '^12.18.0' } }),
    'utf8',
  );
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'index.js'),
    "const Stripe = require('stripe');\nconst s = new Stripe('sk_test', { apiVersion: '2022-11-15' });\nmodule.exports = s;\n",
    'utf8',
  );
  return dir;
}

describe('web app', () => {
  it('serves the frontend at /', async () => {
    await startApp();
    const res = await fetch(baseUrl + '/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('MigratePR');
  });

  it('registers, sessions persist, and /api/me works', async () => {
    await startApp();
    const reg = await call('POST', '/api/register', { email: 'a@b.co', password: 'longenough1', name: 'Ada' });
    expect(reg.status).toBe(201);
    expect(reg.body.user).toMatchObject({ email: 'a@b.co', name: 'Ada' });
    const cookie = cookieFrom(reg.setCookie);
    expect(cookie).toBeDefined();

    const me = await call('GET', '/api/me', undefined, cookie);
    expect(me.status).toBe(200);
    expect((me.body.user as { email: string }).email).toBe('a@b.co');
  });

  it('rejects duplicate registration and weak passwords', async () => {
    await startApp();
    await call('POST', '/api/register', { email: 'a@b.co', password: 'longenough1' });
    const dup = await call('POST', '/api/register', { email: 'A@B.co', password: 'longenough1' });
    expect(dup.status).toBe(400);
    expect(String(dup.body.error)).toMatch(/already exists/i);
    const weak = await call('POST', '/api/register', { email: 'c@d.co', password: 'short' });
    expect(weak.status).toBe(400);
    expect(String(weak.body.error)).toMatch(/8 characters/i);
  });

  it('logs in with correct credentials and rejects wrong ones', async () => {
    await startApp();
    await call('POST', '/api/register', { email: 'a@b.co', password: 'longenough1' });
    const bad = await call('POST', '/api/login', { email: 'a@b.co', password: 'wrongpassword' });
    expect(bad.status).toBe(400);
    const good = await call('POST', '/api/login', { email: 'a@b.co', password: 'longenough1' });
    expect(good.status).toBe(200);
    expect(cookieFrom(good.setCookie)).toBeDefined();
  });

  it('requires auth for keys and jobs', async () => {
    await startApp();
    expect((await call('GET', '/api/keys')).status).toBe(401);
    expect((await call('GET', '/api/jobs')).status).toBe(401);
    expect((await call('POST', '/api/migrate', { repoPath: '.' })).status).toBe(401);
  });

  it('adds and lists keys with masked hints only', async () => {
    await startApp();
    const reg = await call('POST', '/api/register', { email: 'a@b.co', password: 'longenough1' });
    const cookie = cookieFrom(reg.setCookie)!;
    const add = await call('POST', '/api/keys', { provider: 'openai', key: 'sk-test-abcdef1234567890abcdef', label: 'test' }, cookie);
    expect(add.status).toBe(201);
    const view = add.body.key as Record<string, unknown>;
    expect(view.hint).toMatch(/^sk-test…/);
    expect(JSON.stringify(view)).not.toContain('abcdef1234567890abcdef');
    const list = await call('GET', '/api/keys', undefined, cookie);
    expect((list.body.keys as unknown[]).length).toBe(1);
  });

  it('rejects malformed keys', async () => {
    await startApp();
    const reg = await call('POST', '/api/register', { email: 'a@b.co', password: 'longenough1' });
    const cookie = cookieFrom(reg.setCookie)!;
    const bad = await call('POST', '/api/keys', { provider: 'anthropic', key: 'not-a-key' }, cookie);
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/sk-ant-/);
  });

  it('deletes keys', async () => {
    await startApp();
    const reg = await call('POST', '/api/register', { email: 'a@b.co', password: 'longenough1' });
    const cookie = cookieFrom(reg.setCookie)!;
    const add = await call('POST', '/api/keys', { provider: 'openai', key: 'sk-test-abcdef1234567890abcdef' }, cookie);
    const id = (add.body.key as { id: string }).id;
    const del = await call('DELETE', `/api/keys/${id}`, {}, cookie);
    expect(del.status).toBe(200);
    const list = await call('GET', '/api/keys', undefined, cookie);
    expect((list.body.keys as unknown[]).length).toBe(0);
  });

  it('live key test reports invalid keys as invalid', async () => {
    if (process.env.MIGRATEPR_WEB_TEST_LIVE_KEYS !== '1') return;
    await startApp();
    const reg = await call('POST', '/api/register', { email: 'a@b.co', password: 'longenough1' });
    const cookie = cookieFrom(reg.setCookie)!;
    const add = await call('POST', '/api/keys', { provider: 'openai', key: 'sk-test-abcdef1234567890abcdef' }, cookie);
    const id = (add.body.key as { id: string }).id;
    const test = await call('POST', `/api/keys/${id}/test`, {}, cookie);
    expect(test.status).toBe(200);
    expect(test.body.ok).toBe(false);
    expect(String(test.body.message)).toMatch(/invalid/i);
  });

  it('runs a migration end-to-end and exposes the report', async () => {
    await startApp();
    const reg = await call('POST', '/api/register', { email: 'a@b.co', password: 'longenough1' });
    const cookie = cookieFrom(reg.setCookie)!;
    const repo = makeRepo();
    const start = await call('POST', '/api/migrate', { repoPath: repo, engine: 'rules' }, cookie);
    expect(start.status).toBe(202);
    const id = (start.body.job as { id: string }).id;

    // Poll until done (diff-review resolves quickly — no test suite).
    let job: Record<string, unknown> | undefined;
    for (let i = 0; i < 50; i++) {
      const r = await call('GET', `/api/jobs/${id}`, undefined, cookie);
      expect(r.status).toBe(200);
      job = r.body.job as Record<string, unknown>;
      if (job.status === 'done' || job.status === 'error') break;
      await new Promise(res => setTimeout(res, 100));
    }
    expect(job).toBeDefined();
    expect(job!.status).toBe('done');
    expect((job!.report as { status: string }).status).toBe('diff-review');
  });

  it('rejects unknown repo paths', async () => {
    await startApp();
    const reg = await call('POST', '/api/register', { email: 'a@b.co', password: 'longenough1' });
    const cookie = cookieFrom(reg.setCookie)!;
    const bad = await call('POST', '/api/migrate', { repoPath: 'Z:/definitely/not/real' }, cookie);
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/not found/i);
  });

  it('jobs are scoped per user', async () => {
    await startApp();
    const regA = await call('POST', '/api/register', { email: 'a@b.co', password: 'longenough1' });
    const regB = await call('POST', '/api/register', { email: 'b@b.co', password: 'longenough1' });
    const cookieA = cookieFrom(regA.setCookie)!;
    const cookieB = cookieFrom(regB.setCookie)!;
    const repo = makeRepo();
    const start = await call('POST', '/api/migrate', { repoPath: repo, engine: 'rules' }, cookieA);
    const id = (start.body.job as { id: string }).id;
    const asB = await call('GET', `/api/jobs/${id}`, undefined, cookieB);
    expect(asB.status).toBe(404);
  });
});
