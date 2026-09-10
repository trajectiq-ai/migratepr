#!/usr/bin/env node
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import {
  ApiKeyRecord,
  AuthError,
  KeyProvider,
  deleteApiKey,
  getDecryptedApiKey,
  getUserForRequest,
  listApiKeys,
  loginUser,
  logoutToken,
  registerUser,
  saveApiKey,
  sessionCookieValue,
  UserRecord,
} from './auth';
import { testApiKey } from './keytester';
import { runMigrate } from '../migrate';
import { TRACKS } from '../rules';
import { MigrateReport } from '../types';

/**
 * MigratePR web app server — zero-dependency HTTP layer over the CLI engine.
 *
 *   register / login / logout  → signed HttpOnly session cookie
 *   API keys                   → stored AES-256-GCM encrypted, tested live
 *   migrations                 → queued jobs that run the real verify-gated
 *                                pipeline and keep the full report
 *
 * Binds to 127.0.0.1 by default (local single-user app). Override with
 * MIGRATEPR_WEB_HOST / MIGRATEPR_WEB_PORT.
 */

const PORT = Number(process.env.MIGRATEPR_WEB_PORT ?? 3777);
const HOST = process.env.MIGRATEPR_WEB_HOST ?? '127.0.0.1';
const VERSION = '1.0.0';
const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;

/* --------------------------------- helpers --------------------------------- */

function json(res: http.ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sessionCookie(token: string): string {
  return `migratepr_session=${encodeURIComponent(sessionCookieValue(token))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}`;
}
const CLEAR_COOKIE = 'migratepr_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

function readBody(req: http.IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function publicUser(u: UserRecord): { email: string; name: string; createdAt: string } {
  return { email: u.email, name: u.name, createdAt: u.createdAt };
}

function publicKeyView(rec: ApiKeyRecord): {
  id: string;
  provider: KeyProvider;
  hint: string;
  label: string;
  createdAt: string;
  lastCheckedAt?: string;
  lastStatus?: 'valid' | 'invalid';
} {
  // Deliberately omits all ciphertext fields — the raw key never leaves the server.
  return {
    id: rec.id,
    provider: rec.provider,
    hint: rec.hint,
    label: rec.label,
    createdAt: rec.createdAt,
    lastCheckedAt: rec.lastCheckedAt,
    lastStatus: rec.lastStatus,
  };
}

function userFrom(req: http.IncomingMessage): UserRecord | null {
  return getUserForRequest({ headers: req.headers as Record<string, string | string[] | undefined> });
}

/* ------------------------------ migration jobs ------------------------------ */

type JobStatus = 'queued' | 'running' | 'done' | 'error';

interface Job {
  id: string;
  userId: string;
  repoPath: string;
  engine: 'rules' | 'llm' | 'auto';
  trackId?: string;
  push: boolean;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  report?: MigrateReport;
  error?: string;
}

const jobs = new Map<string, Job>();

function dataRoot(): string {
  // Mirrors auth.dataDir(): stable location next to the installed package.
  return process.env.MIGRATEPR_DATA_DIR ?? path.join(__dirname, '..', '..', '..', 'data');
}

function jobsDir(): string {
  return path.join(dataRoot(), 'jobs');
}

function persistJob(job: Job): void {
  try {
    fs.mkdirSync(jobsDir(), { recursive: true });
    fs.writeFileSync(path.join(jobsDir(), `${job.id}.json`), JSON.stringify(job, null, 2), 'utf8');
  } catch {
    /* non-fatal */
  }
}

function loadPersistedJobs(): void {
  try {
    for (const f of fs.readdirSync(jobsDir())) {
      if (!f.endsWith('.json')) continue;
      try {
        const job = JSON.parse(fs.readFileSync(path.join(jobsDir(), f), 'utf8')) as Job;
        // Interrupted runs restart as errors so the UI never shows a phantom "running".
        if (job.status === 'queued' || job.status === 'running') {
          job.status = 'error';
          job.error = 'Interrupted by server restart';
        }
        jobs.set(job.id, job);
      } catch {
        /* skip corrupt job files */
      }
    }
  } catch {
    /* no jobs dir yet */
  }
}

/** Prefer a user key whose live test succeeded; skip keys known to be invalid. */
function pickProviderKey(email: string): { env: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY'; value: string } | null {
  for (const k of listApiKeys(email)) {
    if (k.lastStatus === 'invalid') continue;
    const raw = getDecryptedApiKey(email, k.id);
    if (!raw) continue;
    return k.provider === 'anthropic'
      ? { env: 'ANTHROPIC_API_KEY', value: raw }
      : { env: 'OPENAI_API_KEY', value: raw };
  }
  return null;
}

let queueTail: Promise<void> = Promise.resolve();

function enqueueJob(job: Job): void {
  queueTail = queueTail.then(() => executeJob(job)).catch(() => undefined);
}

async function executeJob(job: Job): Promise<void> {
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  persistJob(job);
  const injected = pickProviderKey(job.userId);
  const savedEnv = injected ? process.env[injected.env] : undefined;
  try {
    if (injected) process.env[injected.env] = injected.value;
    const report = await runMigrate({
      repoPath: job.repoPath,
      engine: job.engine,
      trackId: job.trackId,
      dryRun: !job.push,
      requireGit: job.push,
    });
    job.report = report;
    job.status = 'done';
  } catch (err) {
    job.status = 'error';
    job.error = (err as Error).message;
  } finally {
    if (injected) {
      if (savedEnv === undefined) delete process.env[injected.env];
      else process.env[injected.env] = savedEnv;
    }
    job.finishedAt = new Date().toISOString();
    persistJob(job);
  }
}

/* --------------------------------- static ---------------------------------- */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function staticDirCandidates(): string[] {
  // dist/src/web → project root is three levels up; also support running
  // from a source checkout or a custom static dir via MIGRATEPR_STATIC_DIR.
  return [
    process.env.MIGRATEPR_STATIC_DIR
      ? path.resolve(process.env.MIGRATEPR_STATIC_DIR)
      : path.join(__dirname, '..', '..', '..', 'static'),
    path.join(process.cwd(), 'static'),
  ];
}

function serveStatic(res: http.ServerResponse, rel: string): boolean {
  for (const base of staticDirCandidates()) {
    const abs = path.join(base, rel);
    if (!abs.startsWith(base) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(fs.readFileSync(abs));
    return true;
  }
  return false;
}

/* ---------------------------------- routes --------------------------------- */

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: unknown,
  match: RegExpMatchArray,
) => Promise<void> | void;

const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
function route(method: string, pattern: RegExp, handler: Handler): void {
  routes.push({ method, pattern, handler });
}

/* ---- auth ---- */

route('POST', /^\/api\/register$/, async (req, res, body) => {
  const { email, password, name } = body as { email?: string; password?: string; name?: string };
  const user = registerUser(email ?? '', password ?? '', name ?? '');
  const session = loginUser(email ?? '', password ?? '');
  res.setHeader('Set-Cookie', sessionCookie(session.token));
  json(res, 201, { user: publicUser(user) });
});

route('POST', /^\/api\/login$/, async (req, res, body) => {
  const { email, password } = body as { email?: string; password?: string };
  const session = loginUser(email ?? '', password ?? '');
  res.setHeader('Set-Cookie', sessionCookie(session.token));
  const user = getUserForRequest(req);
  json(res, 200, { user: user ? publicUser(user) : null });
});

route('POST', /^\/api\/logout$/, async (req, res) => {
  logoutToken(extractToken(req));
  res.setHeader('Set-Cookie', CLEAR_COOKIE);
  json(res, 200, { ok: true });
});

route('GET', /^\/api\/me$/, async (req, res) => {
  const user = userFrom(req);
  if (!user) return json(res, 401, { error: 'Not signed in' });
  json(res, 200, { user: publicUser(user) });
});

function extractToken(req: http.IncomingMessage): string | null {
  const cookie = (req.headers.cookie as string | undefined) ?? '';
  const raw = /(?:^|;\s*)migratepr_session=([^;]+)/.exec(cookie)?.[1];
  return raw ? decodeURIComponent(raw).split('.').slice(0, -1).join('.') : null;
}

/* ---- api keys ---- */

route('GET', /^\/api\/keys$/, async (req, res) => {
  const user = userFrom(req);
  if (!user) return json(res, 401, { error: 'Not signed in' });
  json(res, 200, { keys: listApiKeys(user.email).map(publicKeyView) });
});

route('POST', /^\/api\/keys$/, async (req, res, body) => {
  const user = userFrom(req);
  if (!user) return json(res, 401, { error: 'Not signed in' });
  const { provider, key, label } = body as { provider?: string; key?: string; label?: string };
  if (provider !== 'anthropic' && provider !== 'openai') {
    return json(res, 400, { error: "provider must be 'anthropic' or 'openai'" });
  }
  if (!key || typeof key !== 'string') return json(res, 400, { error: 'key is required' });
  const rec = saveApiKey(user.email, provider, key, label ?? '');
  json(res, 201, { key: publicKeyView(rec) });
});

route('DELETE', /^\/api\/keys\/([a-f0-9]+)$/, async (req, res, _body, match) => {
  const user = userFrom(req);
  if (!user) return json(res, 401, { error: 'Not signed in' });
  deleteApiKey(user.email, match[1]);
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/keys\/([a-f0-9]+)\/test$/, async (req, res, _body, match) => {
  const user = userFrom(req);
  if (!user) return json(res, 401, { error: 'Not signed in' });
  const outcome = await testApiKey(user.email, match[1]);
  json(res, 200, outcome);
});

/* ---- tracks + migrations ---- */

route('GET', /^\/api\/tracks$/, async (_req, res) => {
  json(res, 200, {
    tracks: TRACKS.map(t => ({
      id: t.id,
      vendor: t.vendor,
      sdkFrom: t.sdkFrom,
      sdkTo: t.sdkTo,
      apiFrom: t.apiFrom,
      apiTo: t.apiTo,
      guideUrls: t.guideUrls,
    })),
  });
});

route('GET', /^\/api\/jobs$/, async (req, res) => {
  const user = userFrom(req);
  if (!user) return json(res, 401, { error: 'Not signed in' });
  const mine = [...jobs.values()]
    .filter(j => j.userId === user.email)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(j => jobSummary(j));
  json(res, 200, { jobs: mine });
});

function jobSummary(j: Job) {
  return {
    id: j.id,
    repoPath: j.repoPath,
    engine: j.engine,
    trackId: j.trackId,
    push: j.push,
    status: j.status,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt,
    status2: j.report?.status,
    findings: j.report?.findings.length,
    rewrites: j.report?.rewrites.length,
    error: j.error,
  };
}

route('GET', /^\/api\/jobs\/([a-f0-9-]+)$/, async (req, res, _body, match) => {
  const user = userFrom(req);
  if (!user) return json(res, 401, { error: 'Not signed in' });
  const job = jobs.get(match[1]);
  if (!job || job.userId !== user.email) return json(res, 404, { error: 'Job not found' });
  json(res, 200, { job });
});

route('POST', /^\/api\/migrate$/, async (req, res, body) => {
  const user = userFrom(req);
  if (!user) return json(res, 401, { error: 'Not signed in' });
  const { repoPath, engine, trackId, push } = body as {
    repoPath?: string;
    engine?: string;
    trackId?: string;
    push?: boolean;
  };
  const repo = (repoPath ?? '').trim();
  if (repo.length === 0) return json(res, 400, { error: 'repoPath is required' });
  const abs = path.resolve(repo);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return json(res, 400, { error: `Repo path not found or not a directory: ${abs}` });
  }
  const eng = (engine ?? 'auto') as Job['engine'];
  if (!['rules', 'llm', 'auto'].includes(eng)) {
    return json(res, 400, { error: "engine must be 'rules' | 'llm' | 'auto'" });
  }
  const job: Job = {
    id: `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`,
    userId: user.email,
    repoPath: abs,
    engine: eng,
    trackId: trackId || undefined,
    push: push === true,
    status: 'queued',
    createdAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  persistJob(job);
  enqueueJob(job);
  json(res, 202, { job: jobSummary(job) });
});

/* ------------------------------- http server ------------------------------- */

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  // Static frontend.
  if (req.method === 'GET' && !pathname.startsWith('/api/')) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (serveStatic(res, rel)) return;
    // SPA fallback: unknown non-API paths get the app shell.
    if (serveStatic(res, 'index.html')) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('static assets missing — run from the project root');
    return;
  }

  // API: parse JSON body for methods that carry one.
  let body: unknown = {};
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
    const text = await readBody(req);
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return json(res, 400, { error: 'Invalid JSON body' });
      }
    }
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = pathname.match(r.pattern);
    if (!m) continue;
    await r.handler(req, res, body, m);
    return;
  }
  json(res, 404, { error: 'Not found' });
}

export function startServer(): http.Server {
  loadPersistedJobs();
  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (!res.headersSent) {
        const status = err instanceof AuthError ? 400 : 500;
        json(res, status, { error: err instanceof Error ? err.message : String(err) });
      } else {
        res.end();
      }
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`MigratePR web app: http://${HOST}:${PORT}`);
  });
  return server;
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--help' || arg === '-h') {
    console.log(`migratepr-web — MigratePR web app

Usage:
  migratepr-web [--port <n>] [--host <addr>]

Options:
  --port <n>     Port to listen on (default 3777; env MIGRATEPR_WEB_PORT)
  --host <addr>  Bind address (default 127.0.0.1; env MIGRATEPR_WEB_HOST)
  -h, --help     Show this help

The server runs in the foreground; Ctrl+C stops it. Data (accounts,
encrypted API keys, job history) is stored under ./data.
`);
    process.exit(0);
  }
  if (arg === '--version' || arg === '-v') {
    console.log(VERSION);
    process.exit(0);
  }
  const portFlag = process.argv.indexOf('--port');
  const hostFlag = process.argv.indexOf('--host');
  if (portFlag > 0) process.env.MIGRATEPR_WEB_PORT = process.argv[portFlag + 1];
  if (hostFlag > 0) process.env.MIGRATEPR_WEB_HOST = process.argv[hostFlag + 1];
  startServer();
}
