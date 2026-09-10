import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { migrate } from './migrate';
import { MigrateReport } from './types';
import { resolveTrackForRepo, majorOf } from './rules';
import { loadConfig } from './config';
import { Scanner } from './scanner';

/**
 * Self-maintaining watch loop.
 *
 * The promise behind MigratePR is that code stays migrated without anyone
 * remembering to run the tool. `watch` makes that real:
 *
 *   - A cheap fingerprint pre-scan (AST scan only — no test runs, no writes)
 *     decides whether a repo's migration-relevant state changed.
 *   - If nothing changed since the last attempt, the repo is skipped — so
 *     the loop never re-opens duplicate PRs and never re-runs failing
 *     migrations against the same code.
 *   - If something changed, the full detect → rewrite → verify → deliver
 *     pipeline runs against that repo.
 *
 * State is persisted to data/watch.json (atomic write), so restarts resume
 * cleanly. With --push, a delivered PR records its URL and stays "delivered"
 * until the code changes again (e.g. the PR merges, or new call sites appear).
 */

export interface WatchRepo {
  repoPath: string;
  trackId?: string;
  engine?: 'rules' | 'llm' | 'auto';
  excludes?: string[];
  skipRuleIds?: string[];
  prBase?: string;
  install?: boolean;
}

export interface WatchOptions {
  repos: WatchRepo[];
  /** Seconds between cycles; 0 = single cycle (--once). */
  intervalSeconds?: number;
  push?: boolean;
  /** Internal: injectable pipeline for tests. */
  migrateFn?: typeof migrate;
}

export interface WatchResult {
  repoPath: string;
  skipped: boolean;
  outcome: 'migrated' | 'aborted' | 'diff-review' | 'error' | 'clean';
  findings?: number;
  rewrites?: number;
  prUrl?: string;
  message?: string;
}

interface RepoState {
  fingerprint: string;
  outcome: string;
  lastRunAt: string;
  findings?: number;
  rewrites?: number;
  prUrl?: string;
  message?: string;
}

interface WatchState {
  repos: Record<string, RepoState>;
}

/* ------------------------------- persistence ------------------------------- */

function dataDir(): string {
  return process.env.MIGRATEPR_DATA_DIR ?? path.join(__dirname, '..', '..', 'data');
}

function statePath(): string {
  return path.join(dataDir(), 'watch.json');
}

function loadState(): WatchState {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as WatchState;
    return { repos: s.repos ?? {} };
  } catch {
    return { repos: {} };
  }
}

function saveState(state: WatchState): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = statePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, statePath());
  } catch {
    /* non-fatal: watch still runs, it just won't resume cleanly */
  }
}

/* -------------------------------- fingerprint ------------------------------- */

interface FingerprintData {
  fp: string;
  findings: number;
  bumpPending: boolean;
}

/**
 * Migration-relevant fingerprint: resolved track + SDK pin + every finding
 * (rule/file/line/snippet). Any of these changing invalidates the fingerprint,
 * which is exactly what "something changed" means for a migration.
 */
export function computeFingerprint(
  repoPath: string,
  trackId?: string,
  excludes: string[] = [],
): FingerprintData {
  // Custom tracks from .migratepr.json participate in detection too.
  const { config } = loadConfig(repoPath);
  const track = resolveTrackForRepo(repoPath, trackId, config.tracks);
  const scan = new Scanner().scan(repoPath, track, excludes);
  const findings = scan.findings
    .map(f => `${f.ruleId}|${f.file}|${f.line}|${f.snippet}`)
    .sort();

  // SDK bump eligibility: the pin is still on the "from" major and the track
  // has a bump rule. (sdk-bump rules never produce scanner findings.)
  let spec = '';
  let bumpPending = false;
  const hasBump = track.rules.some(r => r.kind === 'sdk-bump');
  if (hasBump) {
    const pkgPath = path.join(repoPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        spec = pkg.dependencies?.stripe ?? pkg.devDependencies?.stripe ?? '';
        if (spec) {
          try {
            bumpPending = majorOf(spec) === track.sdkFrom;
          } catch {
            bumpPending = false;
          }
        }
      } catch {
        /* unparseable package.json → treated as unchanged */
      }
    }
  }

  const fp = crypto
    .createHash('sha256')
    .update(JSON.stringify({ track: track.id, spec, findings, bumpPending }))
    .digest('hex');
  return { fp, findings: scan.findings.length, bumpPending };
}

/* ---------------------------------- cycle ---------------------------------- */

/** Run one watch cycle across all repos. Returns per-repo results. */
export async function watchCycle(opts: WatchOptions): Promise<WatchResult[]> {
  const state = loadState();
  const runMigrate = opts.migrateFn ?? migrate;
  const results: WatchResult[] = [];
  const now = new Date().toISOString();

  for (const repo of opts.repos) {
    const abs = path.resolve(repo.repoPath);
    const prev = state.repos[abs];

    let fpData: FingerprintData;
    try {
      fpData = computeFingerprint(abs, repo.trackId, repo.excludes);
    } catch (err) {
      // Not a migratable repo (no package.json / no track / scan failed).
      // Don't store a fingerprint — if it becomes migratable later, run then.
      results.push({
        repoPath: abs,
        skipped: true,
        outcome: 'clean',
        message: (err as Error).message,
      });
      continue;
    }

    if (prev && prev.fingerprint === fpData.fp) {
      results.push({
        repoPath: abs,
        skipped: true,
        outcome: (prev.outcome as WatchResult['outcome']) || 'clean',
        findings: prev.findings,
        rewrites: prev.rewrites,
        prUrl: prev.prUrl,
        message: prev.message,
      });
      continue;
    }

    // Something changed (or first run): run the real pipeline.
    let report: MigrateReport;
    try {
      report = await runMigrate({
        repoPath: abs,
        trackId: repo.trackId,
        engine: repo.engine,
        dryRun: !opts.push,
        excludePatterns: repo.excludes,
        skipRuleIds: repo.skipRuleIds,
        prBase: repo.prBase,
        install: repo.install,
        requireGit: opts.push,
      });
    } catch (err) {
      const message = (err as Error).message;
      state.repos[abs] = { fingerprint: fpData.fp, outcome: 'error', lastRunAt: now, message };
      results.push({ repoPath: abs, skipped: false, outcome: 'error', message });
      continue;
    }

    state.repos[abs] = {
      fingerprint: fpData.fp,
      outcome: report.status,
      lastRunAt: now,
      findings: report.findings.length,
      rewrites: report.rewrites.length,
      prUrl: report.git?.prUrl,
      message: report.reason,
    };
    results.push({
      repoPath: abs,
      skipped: false,
      outcome: report.status,
      findings: report.findings.length,
      rewrites: report.rewrites.length,
      prUrl: report.git?.prUrl,
      message: report.reason,
    });
  }

  saveState(state);
  return results;
}

/** Loop mode: run cycles forever, honoring the interval. */
export async function watchLoop(opts: WatchOptions, onCycle?: (results: WatchResult[]) => void): Promise<void> {
  const intervalMs = (opts.intervalSeconds ?? 3600) * 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const results = await watchCycle(opts);
    if (onCycle) onCycle(results);
    if (intervalMs <= 0) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
