import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Web-app auth + secrets storage. Zero dependencies: Node crypto only.
 *
 * Storage is a single JSON file (data/store.json) with atomic writes:
 *   - users:    email → record with salted scrypt password hash
 *   - sessions: token → record (signed cookie; HMAC-SHA256 with a local secret)
 *   - apiKeys:  email → keyId → { provider, AES-256-GCM ciphertext, hint }
 * API keys never touch the client unencrypted; only a masked hint is shown.
 */

export interface UserRecord {
  email: string; // lowercased, primary key
  name: string;
  createdAt: string;
  salt: string;
  hash: string; // scrypt(password, salt)
}

export interface SessionRecord {
  token: string;
  userId: string; // email
  createdAt: string;
  expiresAt: string;
}

export type KeyProvider = 'anthropic' | 'openai';

export interface ApiKeyRecord {
  id: string;
  provider: KeyProvider;
  keyEnc: string; // base64 AES-256-GCM ciphertext
  iv: string; // base64
  tag: string; // base64 auth tag
  hint: string; // e.g. "sk-ant-…9f2c" (never the full key)
  label: string;
  createdAt: string;
  lastCheckedAt?: string;
  lastStatus?: 'valid' | 'invalid';
}

export interface StoreShape {
  users: Record<string, UserRecord>;
  sessions: Record<string, SessionRecord>;
  apiKeys: Record<string, Record<string, ApiKeyRecord>>;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_PASSWORD_LEN = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let store: StoreShape | null = null;
let storeDir: string | null = null;

/**
 * Data root: alongside the installed package by default (stable no matter
 * where the command is launched from), overridable via MIGRATEPR_DATA_DIR.
 */
export function dataDir(): string {
  return process.env.MIGRATEPR_DATA_DIR ?? path.join(__dirname, '..', '..', '..', 'data');
}

function storePath(): string {
  return path.join(dataDir(), 'store.json');
}

function loadStore(): StoreShape {
  const dir = dataDir();
  if (store && storeDir === dir) return store;
  try {
    store = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as StoreShape;
  } catch {
    store = { users: {}, sessions: {}, apiKeys: {} };
  }
  storeDir = dir;
  return store!;
}

function saveStore(): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = storePath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, storePath());
}

/* --------------------------------- passwords -------------------------------- */

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

/* --------------------------------- sessions --------------------------------- */

function appSecret(): Buffer {
  const f = path.join(dataDir(), '.secret');
  try {
    return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
  } catch {
    fs.mkdirSync(dataDir(), { recursive: true });
    const s = randomBytes(32).toString('hex');
    fs.writeFileSync(f, s, 'utf8');
    return Buffer.from(s, 'hex');
  }
}

function sign(value: string): string {
  return createHmac('sha256', appSecret()).update(value).digest('base64url');
}

/** Signed cookie value: <token>.<hmac> */
export function sessionCookieValue(token: string): string {
  return `${token}.${sign(token)}`;
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionTokenFromRequest(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const cookies = parseCookieHeader(req.headers['cookie'] as string | undefined);
  const raw = cookies['migratepr_session'];
  if (!raw) return null;
  const i = raw.lastIndexOf('.');
  if (i <= 0) return null;
  const token = raw.slice(0, i);
  const mac = raw.slice(i + 1);
  const expected = Buffer.from(sign(token));
  let given: Buffer;
  try {
    given = Buffer.from(mac);
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return token;
}

/* ------------------------------- registration ------------------------------- */

export function registerUser(email: string, password: string, name: string): UserRecord {
  const e = email.trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new AuthError('Please enter a valid email address');
  if (password.length < MIN_PASSWORD_LEN) {
    throw new AuthError(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
  const db = loadStore();
  if (db.users[e]) throw new AuthError('An account with this email already exists');
  const salt = randomBytes(16).toString('hex');
  const rec: UserRecord = {
    email: e,
    name: (name.trim() || e.split('@')[0]).slice(0, 80),
    createdAt: new Date().toISOString(),
    salt,
    hash: hashPassword(password, salt),
  };
  db.users[e] = rec;
  saveStore();
  return rec;
}

export function loginUser(email: string, password: string): SessionRecord {
  const e = email.trim().toLowerCase();
  const db = loadStore();
  const user = db.users[e];
  const fail = () => new AuthError('Invalid email or password');
  if (!user) throw fail();
  const expected = Buffer.from(user.hash, 'hex');
  const given = Buffer.from(hashPassword(password, user.salt), 'hex');
  if (expected.length !== given.length || !timingSafeEqual(given, expected)) throw fail();
  const now = Date.now();
  // Opportunistic cleanup of expired sessions.
  for (const [t, s] of Object.entries(db.sessions)) {
    if (new Date(s.expiresAt).getTime() < now) delete db.sessions[t];
  }
  const rec: SessionRecord = {
    token: randomBytes(32).toString('base64url'),
    userId: e,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  };
  db.sessions[rec.token] = rec;
  saveStore();
  return rec;
}

export function getUserForRequest(req: { headers: Record<string, string | string[] | undefined> }): UserRecord | null {
  const token = sessionTokenFromRequest(req);
  if (!token) return null;
  const db = loadStore();
  const s = db.sessions[token];
  if (!s) return null;
  if (new Date(s.expiresAt).getTime() < Date.now()) {
    delete db.sessions[token];
    saveStore();
    return null;
  }
  return db.users[s.userId] ?? null;
}

export function logoutToken(token: string | null): void {
  if (!token) return;
  const db = loadStore();
  if (db.sessions[token]) {
    delete db.sessions[token];
    saveStore();
  }
}

export function hashEmailForKeyId(email: string): string {
  return createHash('sha256').update(`${email}:${appSecret().toString('hex')}`).digest('hex').slice(0, 16);
}

/* ------------------------------- API key store ------------------------------ */

const KEY_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedKey: { enc: Buffer; at: number; dir: string } | null = null;

function encryptionKey(): Buffer {
  const dir = dataDir();
  if (cachedKey && cachedKey.dir === dir && Date.now() - cachedKey.at < KEY_CACHE_TTL_MS) return cachedKey.enc;
  // Keys are encrypted under scrypt(secret, 'migratepr-keys', 32).
  const enc = scryptSync(appSecret(), 'migratepr-keys', 32);
  cachedKey = { enc, at: Date.now(), dir };
  return enc;
}

export function maskKey(key: string): string {
  const tail = key.slice(-4);
  const head = key.slice(0, Math.min(7, key.length - 4));
  return `${head}…${tail}`;
}

export function saveApiKey(
  email: string,
  provider: KeyProvider,
  rawKey: string,
  label: string,
): ApiKeyRecord {
  const key = rawKey.trim();
  if (provider === 'anthropic' && !key.startsWith('sk-ant-')) {
    throw new AuthError('Anthropic keys start with "sk-ant-" — please check the key');
  }
  if (provider === 'openai' && !key.startsWith('sk-')) {
    throw new AuthError('OpenAI keys start with "sk-" — please check the key');
  }
  if (key.length < 20) throw new AuthError('That key looks too short to be valid');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const keyEnc = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]).toString('base64');
  const rec: ApiKeyRecord = {
    id: randomBytes(8).toString('hex'),
    provider,
    keyEnc,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    hint: maskKey(key),
    label: (label.trim() || provider).slice(0, 60),
    createdAt: new Date().toISOString(),
  };
  const db = loadStore();
  db.apiKeys[email] = db.apiKeys[email] ?? {};
  db.apiKeys[email][rec.id] = rec;
  saveStore();
  return rec;
}

export function listApiKeys(email: string): ApiKeyRecord[] {
  const db = loadStore();
  return Object.values(db.apiKeys[email] ?? {}).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function deleteApiKey(email: string, keyId: string): void {
  const db = loadStore();
  if (db.apiKeys[email]?.[keyId]) {
    delete db.apiKeys[email][keyId];
    saveStore();
  }
}

/** Decrypt for actual use by the LLM engine; never serialized to any client. */
export function getDecryptedApiKey(email: string, keyId: string): string | null {
  const rec = loadStore().apiKeys[email]?.[keyId];
  if (!rec) return null;
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(rec.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(rec.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(rec.keyEnc, 'base64')), decipher.final()]).toString('utf8');
}

export function updateApiKeyStatus(email: string, keyId: string, status: 'valid' | 'invalid'): void {
  const db = loadStore();
  const rec = db.apiKeys[email]?.[keyId];
  if (!rec) return;
  rec.lastStatus = status;
  rec.lastCheckedAt = new Date().toISOString();
  saveStore();
}

export class AuthError extends Error {}
