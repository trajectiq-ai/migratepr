import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MigrateOptions,
  MigrateReport,
  MigrateprConfig,
  PrPayload,
  SkippedFinding,
} from './types';
import { resolveTrackForRepo } from './rules';
import { loadConfig } from './config';
import { Scanner } from './scanner';
import { Rewriter } from './rewriter';
import { bumpSdkDependencies } from './bump';
import { ensureDependencies, resolveVerifyCommand, runTests } from './verify';
import { makeLlmProvider, llmRewrite } from './engine';

const BRANCH_PREFIX = 'migratepr';
const DEFAULT_VERIFY_TIMEOUT_MS = 600_000;

function branchNameFor(trackId: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `${BRANCH_PREFIX}/${trackId}-${stamp}`;
}

function isGitCheckout(repoPath: string): boolean {
  return fs.existsSync(path.join(repoPath, '.git'));
}

function hasGitCommit(repoPath: string): boolean {
  const r = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repoPath,
    encoding: 'utf8',
  });
  return r.status === 0;
}

/** True when the working tree has no staged or unstaged changes. */
function isGitTreeClean(repoPath: string): boolean {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf8' });
  if (r.status !== 0) return false; // git unavailable/failing: fail closed
  return r.stdout.trim().length === 0;
}

/**
 * Load the repo's .migratepr.json and merge it with explicit options.
 * Precedence: explicit option > config file > built-in default.
 * `logs` collects non-fatal notes for the report.
 */
function resolveSettings(
  repoPath: string,
  opts: MigrateOptions,
): { trackId?: string; engine: 'rules' | 'llm' | 'auto'; skipRuleIds: string[]; excludePatterns: string[]; verifyCommand?: string; verifyTimeoutMs: number; install: boolean; prBase?: string; logs: string[] } {
  const { config, file, error } = loadConfig(repoPath);
  const logs: string[] = [];
  if (error) throw new Error(`${error} (${file})`);
  if (file) logs.push(`config: using ${file}`);

  const cfg: MigrateprConfig = config;
  return {
    trackId: opts.trackId ?? cfg.track,
    engine: opts.engine ?? cfg.engine ?? 'auto',
    skipRuleIds: [...new Set([...(opts.skipRuleIds ?? []), ...(cfg.skipRules ?? [])])],
    excludePatterns: [...new Set([...(opts.excludePatterns ?? []), ...(cfg.exclude ?? [])])],
    verifyCommand: opts.verifyCommand ?? cfg.verifyCommand,
    verifyTimeoutMs: opts.verifyTimeoutMs ?? cfg.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    install: opts.install ?? cfg.install ?? false,
    prBase: opts.prBase ?? cfg.prBase,
    logs,
  };
}

/**
 * Config-aware entrypoint used by the CLI: invalid config files fail loudly.
 */
export async function runMigrate(opts: MigrateOptions): Promise<MigrateReport> {
  const repoPath = path.resolve(opts.repoPath);
  if (!fs.existsSync(repoPath)) throw new Error(`Repo path not found: ${repoPath}`);
  // Fail fast on a bad config before touching anything.
  resolveSettings(repoPath, opts);
  return migrate({ ...opts, repoPath });
}

/**
 * Core pipeline: detect → rewrite → verify → deliver.
 *
 * Design invariants:
 *  - Detection is deterministic (AST-based); the LLM never chooses what to change.
 *  - Tests gate everything: no green post-migration run, no PR.
 *  - Dry-run by default: nothing leaves the machine unless explicitly asked.
 */
export async function migrate(opts: MigrateOptions): Promise<MigrateReport> {
  const repoPath = path.resolve(opts.repoPath);
  if (!fs.existsSync(repoPath)) throw new Error(`Repo path not found: ${repoPath}`);

  const settings = resolveSettings(repoPath, opts);
  const logs = settings.logs;

  // Git safety preflights (fail before any file is touched).
  if (opts.requireGit && !isGitCheckout(repoPath)) {
    throw new Error(`--require-git: ${repoPath} is not a git checkout`);
  }
  if (!opts.dryRun) {
    if (!isGitCheckout(repoPath)) {
      throw new Error('Delivery requested (--push) but the repo is not a git checkout');
    }
    if (!hasGitCommit(repoPath)) {
      throw new Error('Delivery requested but the repo has no commits (git rev-parse HEAD failed)');
    }
    if (!isGitTreeClean(repoPath)) {
      throw new Error(
        'Delivery requested but the working tree is dirty — commit or stash first (git status). ' +
          'MigratePR never mixes its changes with yours.',
      );
    }
  }

  const track = resolveTrackForRepo(repoPath, settings.trackId);
  const skipSet = new Set(settings.skipRuleIds);
  const skipped: SkippedFinding[] = [];

  // 1. Detect — deterministic AST scan.
  const scan = new Scanner().scan(repoPath, track, settings.excludePatterns);
  const findings = scan.findings.filter(f => !skipSet.has(f.ruleId));

  // Repos without a runnable test script go to diff-review (never auto-verified).
  let verifySetup: { command: string; isPlaceholder: boolean } | null = null;
  try {
    verifySetup = resolveVerifyCommand(repoPath, settings.verifyCommand);
  } catch {
    verifySetup = null;
  }
  if (!verifySetup || verifySetup.isPlaceholder) {
    return {
      status: 'diff-review',
      reason:
        "No runnable 'test' script in package.json — MigratePR refuses to migrate repos it cannot verify.",
      track,
      findings: scan.findings,
      rewrites: [],
      skipped: [],
      baseline: null,
      post: null,
      diff: null,
      pr: null,
      logs,
    };
  }

  // 2. Baseline — the repo must be green before we touch it.
  ensureDependencies(repoPath);
  const baseline = runTests(repoPath, 'baseline', {
    verifyFn: opts.verifyFn,
    verifyCommand: settings.verifyCommand,
    timeoutMs: settings.verifyTimeoutMs,
  });
  if (!baseline.ok) {
    return {
      status: 'aborted',
      reason: 'Baseline test run failed — fix the repo before migrating.',
      track,
      findings: scan.findings,
      rewrites: [],
      skipped: [],
      baseline,
      post: null,
      diff: null,
      pr: null,
      logs,
    };
  }

  const branch = branchNameFor(track.id);
  const prBuilder = new PrPayloadBuilder(track, branch, settings.prBase);
  const snapshot = takeSnapshot(repoPath);

  // 3. Rewrite — rules first (deterministic), LLM for the rest.
  const rewrites: MigrateReport['rewrites'] = [];
  const rulesById = new Map(track.rules.map(r => [r.id, r]));
  const engineChoice = settings.engine;
  const llm = engineChoice === 'rules' ? null : makeLlmProvider();
  if (engineChoice !== 'rules' && !llm) {
    logs.push('llm engine unavailable: no provider configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY)');
  }

  for (const finding of findings) {
    const rule = rulesById.get(finding.ruleId);
    if (!rule) continue;
    // sdk-bump rules never produce findings; they run once per repo below.
    if (rule.kind === 'sdk-bump') continue;

    if (
      rule.kind === 'api-version' ||
      rule.kind === 'mock-method-key' ||
      (!rule.needsLlm && engineChoice !== 'llm')
    ) {
      const applied = new Rewriter().apply(rule, finding, repoPath);
      if (applied) {
        rewrites.push(applied);
        continue;
      }
      if (engineChoice === 'rules') {
        skipped.push({ ruleId: rule.id, reason: 'rule engine could not apply deterministically' });
        continue;
      }
    }

    if (!llm) {
      skipped.push({
        ruleId: rule.id,
        reason: 'needs LLM engine but no provider configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY)',
      });
      continue;
    }
    try {
      rewrites.push(await llmRewrite(llm, track, rule, finding, repoPath));
    } catch (err) {
      skipped.push({ ruleId: rule.id, reason: `LLM rewrite rejected: ${(err as Error).message}` });
    }
  }

  // SDK dependency bumps apply once per repo, independent of call-site findings.
  const bumpRules = track.rules.filter(
    (r): r is Extract<typeof r, { kind: 'sdk-bump' }> =>
      r.kind === 'sdk-bump' && !skipSet.has(r.id),
  );
  const bumps = bumpSdkDependencies(bumpRules, repoPath);
  rewrites.push(...bumps);
  if (bumps.length > 0 && settings.install) {
    logs.push('install: running npm install after dependency bump');
    ensureDependencies(repoPath, true);
  }

  // 4. Verify — run the repo's own suite against the rewritten code.
  const post = runTests(repoPath, 'post-migration', {
    verifyFn: opts.verifyFn,
    verifyCommand: settings.verifyCommand,
    timeoutMs: settings.verifyTimeoutMs,
  });
  if (!post.ok) {
    restoreSnapshot(repoPath, snapshot);
    return {
      status: 'aborted',
      reason: 'Post-migration tests failed — all changes reverted, no PR opened.',
      track,
      findings: scan.findings,
      rewrites,
      skipped,
      baseline,
      post,
      diff: null,
      pr: null,
      logs,
    };
  }

  const diff = diffAgainstSnapshot(repoPath, snapshot);
  const pr = prBuilder.build(findings, rewrites, skipped, diff);

  // 5. Deliver — dry-run by default; real git/PR only when asked.
  let git;
  if (!opts.dryRun) {
    git = await deliverWithGit(repoPath, branch, pr);
  }

  return {
    status: 'migrated',
    git,
    track,
    findings: scan.findings,
    rewrites,
    skipped,
    baseline,
    post,
    diff,
    pr,
    logs,
  };
}

/* ---------------------------------- snapshot ---------------------------------- */

interface Snapshot {
  files: Map<string, string>;
}

const SNAPSHOT_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

function walkFiles(repoPath: string, visit: (rel: string, abs: string) => void): void {
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SNAPSHOT_SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else visit(path.relative(repoPath, abs), abs);
    }
  };
  walk(repoPath);
}

function takeSnapshot(repoPath: string): Snapshot {
  const files = new Map<string, string>();
  walkFiles(repoPath, rel => files.set(rel, fs.readFileSync(path.join(repoPath, rel), 'utf8')));
  return { files };
}

function restoreSnapshot(repoPath: string, snap: Snapshot): void {
  for (const [rel, content] of snap.files) {
    fs.writeFileSync(path.join(repoPath, rel), content, 'utf8');
  }
}

/** Minimal LCS line diff — no git or external dependency required. */
function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < m) out.push(`- ${a[i++]}`);
  while (j < n) out.push(`+ ${b[j++]}`);
  return out;
}

function diffAgainstSnapshot(repoPath: string, snap: Snapshot): string | null {
  const chunks: string[] = [];
  for (const [rel, before] of snap.files) {
    const after = fs.readFileSync(path.join(repoPath, rel), 'utf8');
    if (after === before) continue;
    chunks.push(`--- a/${rel}\n+++ b/${rel}\n${lineDiff(before, after).join('\n')}`);
  }
  return chunks.length > 0 ? chunks.join('\n\n') : null;
}

/* ---------------------------------- delivery ---------------------------------- */

async function deliverWithGit(
  repoPath: string,
  branch: string,
  pr: PrPayload,
): Promise<MigrateReport['git']> {
  const run = (cmd: string, args: string[]): { ok: boolean; out: string } => {
    // git/gh resolve as .exe on Windows; no shell needed (avoids DEP0190).
    const r = spawnSync(cmd, args, { cwd: repoPath, encoding: 'utf8' });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  };

  const original = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out || pr.base;
  const runOrThrow = (args: string[]): void => {
    const r = run('git', args);
    if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.out}`);
  };

  // Windows installs often land after the calling shell's PATH was built;
  // fall back to the standard MSI location so delivery still works.
  const GH_MSI = 'C:\\Program Files\\GitHub CLI\\gh.exe';
  let ghBin = 'gh';
  if (!run('gh', ['--version']).ok && fs.existsSync(GH_MSI)) {
    ghBin = GH_MSI;
  }

  let committed = false;
  let pushed = false;
  try {
    runOrThrow(['checkout', '-b', branch]);
    runOrThrow(['add', '-A']);
    runOrThrow(['commit', '-m', pr.title]);
    committed = true;
    pushed = run('git', ['push', '-u', 'origin', branch]).ok;
    let prUrl: string | undefined;
    if (pushed) {
      // Pass the (large) body via a temp file: no argv-length limits, no
      // quoting hazards, no shell interpretation.
      const bodyFile = path.join(os.tmpdir(), `migratepr-pr-body-${Date.now()}.md`);
      fs.writeFileSync(bodyFile, pr.body, 'utf8');
      try {
        const gh = run(ghBin, [
          'pr',
          'create',
          '--title',
          pr.title,
          '--body-file',
          bodyFile,
          '--base',
          pr.base,
        ]);
        prUrl = gh.out.match(/https:\S+\/pull\/\d+/)?.[0];
        if (!gh.ok && !prUrl) {
          throw new Error(
            gh.out.trim().length > 0
              ? `gh pr create failed: ${gh.out}`
              : 'gh pr create failed — is the GitHub CLI installed and authenticated (gh auth login)?',
          );
        }
      } finally {
        fs.rmSync(bodyFile, { force: true });
      }
    }
    runOrThrow(['checkout', original]);
    return { branch, committed, pushed, switchedBack: true, prUrl };
  } catch (err) {
    run('git', ['checkout', original]);
    // Preserve work: only discard the branch when nothing was committed. If
    // the commit/push succeeded but PR creation failed, the migration lives
    // on `branch` (and on origin once pushed) for manual review.
    if (!committed) run('git', ['branch', '-D', branch]);
    return {
      branch,
      committed,
      pushed,
      switchedBack: true,
      error: (err as Error).message,
    };
  }
}

/* --------------------------------- PR payload --------------------------------- */

class PrPayloadBuilder {
  constructor(
    private readonly track: MigrateReport['track'],
    private readonly branch: string,
    private readonly base?: string,
  ) {}

  build(
    findings: MigrateReport['findings'],
    rewrites: MigrateReport['rewrites'],
    skipped: SkippedFinding[],
    diff: string | null,
  ): PrPayload {
    const t = this.track;
    const lines: string[] = [];
    lines.push('## Automatic API migration');
    lines.push('');
    lines.push(
      `Detected **${findings.length}** affected call site(s) for ` +
        `\`${t.vendor}\` SDK v${t.sdkFrom} → v${t.sdkTo} (API \`${t.apiFrom}\` → \`${t.apiTo}\`).`,
    );
    lines.push('');
    lines.push('### Verification');
    lines.push('');
    lines.push('- ✅ Baseline test run: green');
    lines.push('- ✅ Post-migration test run: green — this PR only exists because tests pass');
    lines.push('');
    lines.push('### Changes');
    lines.push('');
    lines.push('| File | Rule | Engine |');
    lines.push('|------|------|--------|');
    for (const r of rewrites) {
      lines.push(`| \`${r.file}${r.line ? ':' + r.line : ''}\` | \`${r.ruleId}\` | ${r.engine} |`);
    }
    if (skipped.length > 0) {
      lines.push('');
      lines.push('### Skipped (needs human attention)');
      lines.push('');
      for (const s of skipped) lines.push(`- \`${s.ruleId}\`: ${s.reason}`);
    }
    lines.push('');
    lines.push('### Affected call sites');
    lines.push('');
    for (const f of findings) {
      lines.push(`- \`${f.file}:${f.line}\` — ${f.ruleId}`);
      lines.push('  ```ts');
      lines.push(`  ${f.snippet.split('\n').join('\n  ')}`);
      lines.push('  ```');
    }
    if (diff) {
      lines.push('');
      lines.push('<details><summary>Diff</summary>');
      lines.push('');
      lines.push('```diff');
      lines.push(diff);
      lines.push('```');
      lines.push('');
      lines.push('</details>');
    }
    lines.push('');
    lines.push('### Sources');
    lines.push('');
    for (const url of t.guideUrls) lines.push(`- ${url}`);
    lines.push('');
    lines.push('---');
    lines.push(
      '_Generated by MigratePR — deterministic AST detection, guide-constrained rewrite, test-verified._',
    );

    return {
      branch: this.branch,
      base: this.base ?? 'main',
      title: `migratepr: ${t.vendor} v${t.sdkFrom} → v${t.sdkTo} (API ${t.apiTo})`,
      body: lines.join('\n'),
    };
  }
}
