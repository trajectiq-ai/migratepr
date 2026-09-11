/**
 * Local model provisioning — the engine behind `migratepr model`.
 *
 * `migratepr doctor` answers "what LLM is on this machine?". This module
 * answers the follow-up question — "then get me one" — with a single command,
 * so a customer with nothing installed never has to leave the tool:
 *
 *   migratepr model list          # what local models are usable right now
 *   migratepr model pull          # download the model MigratePR prefers
 *   migratepr model pull <tag>    # …or any other Ollama tag
 *
 * Why Ollama and not a bundled model: Ollama is a single cross-platform binary
 * with an HTTP API, and its models are shared with the rest of the user's
 * machine. Bundling weights in the npm package would add gigabytes and native
 * build steps to a tool whose core is deterministic and whose LLM use is
 * optional — a bad trade. Everything here is HTTP, so it is fully testable
 * against a fake server and never needs a native toolchain.
 *
 * Deliberately imports nothing from `./doctor` — doctor imports this module, so
 * that direction stays acyclic.
 */
import { bold, cyan, dim, green, red, yellow } from './ansi';
import { OLLAMA_DEFAULT_MODEL, pickPreferredOllamaModel } from './providers/ollama';

/** The tag MigratePR downloads by default: the one the engine prefers. */
export const DEFAULT_PULL_MODEL = OLLAMA_DEFAULT_MODEL;

/** A small, fast alternative for modest laptops (≈1 GB instead of ≈4.7 GB). */
export const SMALL_PULL_MODEL = 'qwen2.5-coder:1.5b';

/** Kept in sync with `LOCAL_RUNTIMES` in doctor.ts (Ollama is spec #0). */
export const OLLAMA_INSTALL = {
  windows: 'winget install Ollama.Ollama',
  macOS: 'brew install ollama',
  linux: 'curl -fsSL https://ollama.com/install.sh | sh',
} as const;

/** Ollama's host, honoring `OLLAMA_HOST` exactly like the adapter does. */
export function ollamaHost(override?: string): string {
  return (override ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
}

/** The command a recommendation should print — our own, not raw `ollama pull`. */
export function pullCommandFor(model: string = DEFAULT_PULL_MODEL): string {
  return `migratepr model pull${model === DEFAULT_PULL_MODEL ? '' : ` ${model}`}`;
}

export interface InstallHint {
  /** Exact command for this platform. */
  command: string;
  docsUrl: string;
  /** One line telling the user what to do after installing. */
  next: string;
}

export function installHint(platform: NodeJS.Platform = process.platform): InstallHint {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macOS' : 'linux';
  return {
    command: OLLAMA_INSTALL[os as keyof typeof OLLAMA_INSTALL],
    docsUrl: 'https://ollama.com/download',
    next: pullCommandFor(),
  };
}

/* ------------------------------- model listing ------------------------------ */

export interface LocalModel {
  name: string;
  sizeBytes?: number;
}

interface OllamaTagsBody {
  models?: Array<{ name?: string; model?: string; size?: number }>;
}

export class OllamaUnavailableError extends Error {
  constructor(host: string, cause?: unknown) {
    super(`no Ollama server answered at ${host} — install it, or start it with "ollama serve"`);
    this.name = 'OllamaUnavailableError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** Installed local models, newest listing straight from Ollama. */
export async function listLocalModels(
  opts: { host?: string; timeoutMs?: number } = {},
): Promise<LocalModel[]> {
  const host = ollamaHost(opts.host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await fetch(`${host}/api/tags`, { signal: controller.signal });
    if (!res.ok) throw new OllamaUnavailableError(host);
    const body = (await res.json()) as OllamaTagsBody;
    return (body.models ?? [])
      .map(m => ({ name: m.name ?? m.model ?? '', sizeBytes: m.size }))
      .filter(m => m.name.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    if (err instanceof OllamaUnavailableError) throw err;
    throw new OllamaUnavailableError(host, err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The model the engine would actually pick for this list.
 *
 * Reuses the adapter's own ranking so `model list` can never claim a model the
 * next migration would not actually use — the same rule `doctor` follows.
 */
export function preferredLocalModel(models: LocalModel[]): string {
  if (models.length === 0) return DEFAULT_PULL_MODEL;
  return pickPreferredOllamaModel(models.map(m => m.name));
}

/**
 * Is the requested tag already installed? Ollama treats a bare name as
 * `:latest`, so `qwen2.5-coder` and `qwen2.5-coder:latest` are the same model
 * and must not trigger a redundant download.
 */
export function isInstalled(models: LocalModel[], requested: string): boolean {
  const norm = (n: string): string => (n.includes(':') ? n : `${n}:latest`);
  const want = norm(requested.trim());
  return models.some(m => norm(m.name) === want);
}

/* --------------------------------- pulling ---------------------------------- */

export interface PullProgress {
  /** Ollama's own status line ("pulling manifest", "downloading", "success"). */
  status: string;
  completed?: number;
  total?: number;
  /** 0–100 when total bytes are known. */
  percent?: number;
}

export interface PullResult {
  model: string;
  /** False when the tag was already present — no download happened. */
  downloaded: boolean;
  /** Status lines observed, in order (useful for tests and `--json`). */
  events: PullProgress[];
}

interface OllamaPullLine {
  status?: string;
  error?: string;
  total?: number;
  completed?: number;
}

/**
 * Download a model through Ollama's streaming pull API.
 *
 * Resolves once Ollama reports success; rejects with Ollama's own message when
 * the tag does not exist. `onProgress` is called for every NDJSON event so a
 * CLI can render a live bar (and tests can assert the full sequence).
 */
export async function pullModel(
  name: string,
  opts: { host?: string; onProgress?: (p: PullProgress) => void; signal?: AbortSignal } = {},
): Promise<PullResult> {
  const host = ollamaHost(opts.host);
  const model = name.trim() || DEFAULT_PULL_MODEL;

  let res: Response;
  try {
    res = await fetch(`${host}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: opts.signal,
    });
  } catch (err) {
    throw new OllamaUnavailableError(host, err);
  }

  if (!res.ok || !res.body) {
    // Ollama reports "model not found" in the body, not in the status text.
    const detail = await readErrorBody(res);
    throw new Error(
      detail ?? `Ollama returned HTTP ${res.status} for model '${model}'${res.status === 404 ? ' — check the tag spelling at https://ollama.com/library' : ''}`,
    );
  }

  const events: PullProgress[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  const body = res.body as unknown as AsyncIterable<Uint8Array>;
  let streamError: string | null = null;

  // Returns an error message when the line is an error; progress is emitted
  // through the callback. Kept as a pure helper so the `streamError` assignment
  // stays visible to the type checker.
  const consume = (line: string): string | null => {
    const parsed = parsePullLine(line);
    if (parsed === null) return null;
    if (parsed.kind === 'error') return parsed.message;
    events.push(parsed.event);
    opts.onProgress?.(parsed.event);
    return null;
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const failure = consume(line);
      if (failure !== null) streamError = failure;
    }
  }
  const trailingFailure = consume(buffer);
  if (trailingFailure !== null) streamError = trailingFailure;

  if (streamError) {
    throw new Error(
      streamError.includes('not found')
        ? `${streamError} — check the tag at https://ollama.com/library`
        : streamError,
    );
  }
  return { model, downloaded: true, events };
}

type PullLine = { kind: 'event'; event: PullProgress } | { kind: 'error'; message: string };

/** One NDJSON line from Ollama: a progress event, an error, or noise. */
function parsePullLine(line: string): PullLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: OllamaPullLine;
  try {
    parsed = JSON.parse(trimmed) as OllamaPullLine;
  } catch {
    return null; // a partial or non-JSON line is not fatal
  }
  if (typeof parsed.error === 'string' && parsed.error.length > 0) {
    return { kind: 'error', message: parsed.error };
  }
  const status = parsed.status ?? '';
  if (status.length === 0) return null;
  const event: PullProgress = { status };
  if (typeof parsed.completed === 'number') event.completed = parsed.completed;
  if (typeof parsed.total === 'number') event.total = parsed.total;
  if (parsed.total && typeof parsed.completed === 'number') {
    event.percent = Math.min(100, Math.round((parsed.completed / parsed.total) * 100));
  }
  return { kind: 'event', event };
}

/** Separate readers so an error body never throws a parse error of its own. */
async function readErrorBody(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as { error?: string };
    return parsed.error ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------- formatting -------------------------------- */

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** Human-readable `migratepr model list` output. */
export function formatModelList(
  models: LocalModel[],
  opts: { host?: string; preferred?: string } = {},
): string {
  const out: string[] = [];
  out.push(bold('Local models (Ollama)') + dim(`  ${ollamaHost(opts.host)}`));
  if (models.length === 0) {
    out.push(yellow('  ! no models installed'));
    out.push(`  Get one:  ${cyan(pullCommandFor())}`);
    return out.join('\n');
  }
  for (const m of models) {
    const size = formatBytes(m.sizeBytes);
    const preferred = m.name === opts.preferred;
    out.push(
      `  ${green('✔')} ${m.name.padEnd(28)} ${dim(size.padEnd(9))}${preferred ? dim('  ← preferred by MigratePR') : ''}`,
    );
  }
  return out.join('\n');
}

/** A single progress line, safe to print with `\r` or as a plain line. */
export function formatPullProgress(p: PullProgress): string {
  if (p.total && p.percent !== undefined) {
    return `${p.status} ${p.percent}% (${formatBytes(p.completed)} / ${formatBytes(p.total)})`;
  }
  return p.status;
}

/** The message shown when `migratepr model` finds no Ollama at all. */
export function formatMissingOllama(
  platform: NodeJS.Platform = process.platform,
): string {
  const hint = installHint(platform);
  return [
    bold('Ollama is not installed on this machine.'),
    '',
    `  Install:  ${cyan(hint.command)}`,
    `  Docs:     ${dim(hint.docsUrl)}`,
    `  Then:     ${cyan(hint.next)}`,
    '',
    dim('  No Ollama? Every other option still works — run "migratepr doctor" to see them,'),
    dim('  or skip the LLM entirely: the deterministic rules engine needs no model.'),
  ].join('\n');
}

/** Final line after a successful pull. */
export function formatPullDone(model: string): string {
  return (
    `\n${green('✔')} ${bold(model)} is ready.\n` +
    dim('  MigratePR will find it automatically on the next run (or run "migratepr doctor").')
  );
}

/** Re-exported so the CLI can color the "model not found" error consistently. */
export function formatError(err: unknown): string {
  return red(err instanceof Error ? err.message : String(err));
}
