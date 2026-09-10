import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { VerifyFnInput, VerifyResult, VerifyStage } from './types';

const TAIL_CHARS = 4000;

export class NoTestScriptError extends Error {
  constructor() {
    super("package.json has no 'test' script — diff-review mode required");
  }
}

const DEFAULT_VERIFY_TIMEOUT_MS = 600_000;

export function resolveVerifyCommand(
  repoPath: string,
  verifyCommand?: string,
): { command: string; isPlaceholder: boolean } {
  const pkgPath = path.join(repoPath, 'package.json');
  if (verifyCommand && verifyCommand.trim().length > 0) {
    return { command: verifyCommand.trim(), isPlaceholder: false };
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const script = pkg.scripts?.test;
  if (typeof script === 'string' && script.trim().length > 0) {
    // Common placeholders like "echo \"Error: no test specified\" && exit 1"
    // are not a real suite: treat them as absent (diff-review mode).
    const isPlaceholder = /echo\b/i.test(script) && /exit\b/i.test(script);
    return { command: 'npm test', isPlaceholder };
  }
  throw new NoTestScriptError();
}

/**
 * Install dependencies only when they are required and missing (or when the
 * caller explicitly asks for a post-bump install). The demo repo ships a
 * committed stub under node_modules, so this is a no-op there.
 */
export function ensureDependencies(repoPath: string, force = false): void {
  const pkgPath = path.join(repoPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const depCount =
    Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
  if (depCount === 0) return;
  if (!force && fs.existsSync(path.join(repoPath, 'node_modules'))) return;
  // Single-string command avoids Node's DEP0190 args+shell deprecation.
  spawnSync('npm install --no-audit --no-fund', {
    cwd: repoPath,
    encoding: 'utf8',
    shell: true,
    timeout: 180_000,
  });
}

/**
 * The verification gate: run the repository's own test suite. `verifyFn` is a
 * test seam so unit tests can inject a fake verifier.
 */
export function runTests(
  repoPath: string,
  stage: VerifyStage,
  opts?: {
    verifyFn?: (o: VerifyFnInput) => VerifyResult;
    verifyCommand?: string;
    timeoutMs?: number;
  },
): VerifyResult {
  const { verifyFn, verifyCommand, timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS } = opts ?? {};
  if (verifyFn) return verifyFn({ cwd: repoPath, command: verifyCommand ?? 'npm test', stage });
  const { command, isPlaceholder } = resolveVerifyCommand(repoPath, verifyCommand);
  if (isPlaceholder) throw new NoTestScriptError();

  const started = Date.now();
  const res = spawnSync(command, {
    cwd: repoPath,
    encoding: 'utf8',
    shell: true,
    timeout: timeoutMs,
    env: { ...process.env, MIGRATEPR_VERIFY: stage },
  });
  const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  const tail = combined.length > TAIL_CHARS ? `…${combined.slice(-TAIL_CHARS)}` : combined;
  // spawn-level failure (timeout kills with SIGTERM) or command not found.
  const timedOut =
    res.signal === 'SIGTERM' ||
    (res.error !== undefined && /timed ?out|ETIMEDOUT/i.test(res.error.message));
  if (res.error) {
    return {
      ok: false,
      stage,
      command,
      exitCode: timedOut ? 124 : null,
      output: `verify failed: ${res.error.message}\n${tail}`,
      durationMs: Date.now() - started,
    };
  }
  return {
    ok: res.status === 0,
    stage,
    command,
    exitCode: timedOut ? 124 : res.status,
    output: tail,
    durationMs: Date.now() - started,
  };
}
