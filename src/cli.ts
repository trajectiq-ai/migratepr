#!/usr/bin/env node
import * as fs from 'fs';
import { migrate } from './migrate';
import { TRACKS } from './rules';
import { watchCycle, watchLoop, WatchRepo, WatchResult } from './watch';
import { bold, cyan, dim, green, red, yellow } from './ansi';

/** Exit codes (stable contract for CI): */
export const EXIT = {
  OK: 0, // migrated (or info flags)
  ABORTED: 1, // migration attempted but the gate stopped it (or delivery failed)
  DIFF_REVIEW: 2, // repo cannot be verified — no attempt made
  USAGE: 3, // bad flags, bad config, missing paths
} as const;

interface ParsedArgs {
  repoPath: string;
  trackId?: string;
  engine?: 'rules' | 'llm' | 'auto';
  push: boolean;
  json: boolean;
  out?: string;
  excludes: string[];
  skipRules: string[];
  install?: boolean;
  verifyCommand?: string;
  timeoutMs?: number;
  requireGit: boolean;
  prBase?: string;
  listTracks: boolean;
  version: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    repoPath: '.',
    push: false,
    json: false,
    excludes: [],
    skipRules: [],
    requireGit: false,
    listTracks: false,
    version: false,
    help: false,
  };
  const engines = new Set(['rules', 'llm', 'auto']);
  const needValue = (flag: string): string => {
    const v = argv[++i];
    if (v === undefined) throw new Error(`missing value for ${flag}`);
    return v;
  };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') parsed.repoPath = needValue(a);
    else if (a === '--track') parsed.trackId = needValue(a);
    else if (a === '--engine') {
      const v = needValue(a);
      if (!engines.has(v)) throw new Error(`--engine must be one of: ${[...engines].join(', ')}`);
      parsed.engine = v as ParsedArgs['engine'];
    } else if (a === '--push') parsed.push = true;
    else if (a === '--dry-run') parsed.push = false;
    else if (a === '--json') parsed.json = true;
    else if (a === '--out') parsed.out = needValue(a);
    else if (a === '--exclude') parsed.excludes.push(needValue(a));
    else if (a === '--skip-rule') parsed.skipRules.push(needValue(a));
    else if (a === '--install') parsed.install = true;
    else if (a === '--no-install') parsed.install = false;
    else if (a === '--verify-command') parsed.verifyCommand = needValue(a);
    else if (a === '--timeout') {
      const v = Number(needValue(a));
      if (!Number.isFinite(v) || v <= 0) throw new Error('--timeout must be a positive number of ms');
      parsed.timeoutMs = v;
    } else if (a === '--require-git') parsed.requireGit = true;
    else if (a === '--pr-base') parsed.prBase = needValue(a);
    else if (a === '--list-tracks') parsed.listTracks = true;
    else if (a === '--version') parsed.version = true;
    else if (a === '--help' || a === '-h') parsed.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return parsed;
}

const VERSION = '1.0.0';

function usage(): void {
  console.log(`migratepr v${VERSION} — test-verified migration PRs for third-party API changes

Usage:
  migratepr --repo <path> [options]
  migratepr watch --repo <path> [options]   # self-maintaining loop

Flags:
  --repo <path>        Target repository (default: .)
  --track <id>         Migration track id (default: auto-detect from package.json)
  --engine <mode>      rules | llm | auto (default: auto — rules first, LLM for the rest)
  --push               Create branch, commit, push, open PR (default: dry-run)
  --dry-run            Explicitly force dry-run
  --json               Print the full JSON report (machine-readable)
  --out <file>         Write the JSON report to a file
  --exclude <glob>     Exclude files from scanning (repeatable, e.g. "generated/")
  --skip-rule <id>     Skip a rule id (repeatable)
  --install            Run npm install after dependency bumps
  --no-install         Never run npm install (default)
  --verify-command <c> Override the verify command (default: package.json test script)
  --timeout <ms>       Per-run verify timeout in ms (default: 600000)
  --require-git        Refuse to run outside a git checkout
  --pr-base <branch>   Base branch for PR delivery (default: branch HEAD had)
  --list-tracks        Print available migration tracks
  --version            Print version
  -h, --help           Show this help

Exit codes:
  0  migration succeeded (PR payload produced)
  1  aborted — verify gate stopped it (changes reverted) or delivery failed
  2  diff-review — repo has no runnable test suite; nothing was attempted
  3  usage or configuration error
`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'watch') {
    return runWatch(argv.slice(1));
  }
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(red((err as Error).message));
    usage();
    return EXIT.USAGE;
  }
  if (args.help) return usage(), EXIT.OK;
  if (args.version) return console.log(VERSION), EXIT.OK;
  if (args.listTracks) {
    console.log('Available migration tracks:');
    for (const t of TRACKS) {
      console.log(`  ${t.id.padEnd(20)} ${t.vendor} v${t.sdkFrom} → v${t.sdkTo} (API ${t.apiTo})`);
    }
    return EXIT.OK;
  }

  const report = await migrate({
    repoPath: args.repoPath,
    trackId: args.trackId,
    engine: args.engine,
    dryRun: !args.push,
    skipRuleIds: args.skipRules,
    excludePatterns: args.excludes,
    install: args.install,
    verifyCommand: args.verifyCommand,
    verifyTimeoutMs: args.timeoutMs,
    requireGit: args.requireGit,
    prBase: args.prBase,
  });

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.status === 'migrated' ? EXIT.OK : report.status === 'aborted' ? EXIT.ABORTED : EXIT.DIFF_REVIEW;
  }

  printHuman(report, args.repoPath, args.push);
  if (report.status === 'aborted') return EXIT.ABORTED;
  if (report.status === 'diff-review') return EXIT.DIFF_REVIEW;
  return EXIT.OK;
}

function printHuman(
  report: Awaited<ReturnType<typeof migrate>>,
  repoPath: string,
  push: boolean,
): void {
  console.log(bold('MigratePR — detect → rewrite → verify → deliver'));
  console.log(dim(`repo: ${repoPath}`));
  console.log('');

  for (const line of report.logs ?? []) console.log(dim(`· ${line}`));

  console.log(`Track:      ${cyan(report.track.id)}`);
  console.log(`Status:     ${statusColored(report.status)}`);
  console.log(`Findings:   ${report.findings.length}`);
  console.log(`Rewrites:   ${report.rewrites.length}`);
  if (report.skipped.length > 0) console.log(`Skipped:    ${report.skipped.length}`);
  console.log('');

  for (const r of report.rewrites) {
    console.log(green('✔') + ` ${r.file}${r.line ? ':' + r.line : ''}  ${dim(r.ruleId)} [${r.engine}]`);
    console.log(dim('  before: ') + firstLine(r.before));
    console.log(dim('  after:  ') + firstLine(r.after));
  }
  for (const s of report.skipped) {
    console.log(yellow('–') + ` skipped ${s.ruleId}: ${s.reason}`);
  }

  if (report.baseline) {
    console.log('');
    console.log(
      `Verify (${report.baseline.stage}): ${report.baseline.ok ? green('pass') : red('fail')}` +
        dim(` (${report.baseline.durationMs}ms, ${report.baseline.command})`),
    );
  }
  if (report.post) {
    console.log(
      `Verify (${report.post.stage}): ${report.post.ok ? green('pass') : red('fail')}` +
        dim(` (${report.post.durationMs}ms, ${report.post.command})`),
    );
  }

  if (report.status === 'aborted') {
    console.log('');
    console.log(red(`Aborted: ${report.reason}`));
    return;
  }

  if (report.pr) {
    console.log('');
    console.log(bold(push ? 'Delivery' : 'PR payload (dry run — use --push to open the PR)'));
    console.log(`  branch: ${report.pr.branch}`);
    console.log(`  title:  ${report.pr.title}`);
  }
  if (report.git) {
    console.log('');
    if (report.git.error) {
      console.log(red(`git delivery failed: ${report.git.error}`));
    } else {
      console.log(
        `branch ${report.git.branch} committed; pushed: ${report.git.pushed}` +
          (report.git.prUrl ? `; PR: ${report.git.prUrl}` : ''),
      );
    }
  }
}

function firstLine(s: string): string {
  return s.split('\n')[0].slice(0, 160);
}

function statusColored(status: string): string {
  if (status === 'migrated') return green(status);
  if (status === 'diff-review') return yellow(status);
  return red(status);
}

/* ------------------------------- watch mode ------------------------------- */

interface WatchArgs {
  repos: WatchRepo[];
  intervalSeconds: number;
  once: boolean;
  push: boolean;
  json: boolean;
  help: boolean;
}

function parseWatchArgs(argv: string[]): WatchArgs {
  const parsed: WatchArgs = { repos: [], intervalSeconds: 3600, once: false, push: false, json: false, help: false };
  const needValue = (flag: string): string => {
    const v = argv[++i];
    if (v === undefined) throw new Error(`missing value for ${flag}`);
    return v;
  };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo' || a === '--repos') parsed.repos.push({ repoPath: needValue(a) });
    else if (a === '--track') {
      if (parsed.repos.length === 0) parsed.repos.push({ repoPath: '.' });
      parsed.repos[parsed.repos.length - 1].trackId = needValue(a);
    } else if (a === '--engine') {
      const v = needValue(a);
      if (!['rules', 'llm', 'auto'].includes(v)) throw new Error(`--engine must be one of: rules, llm, auto`);
      if (parsed.repos.length === 0) parsed.repos.push({ repoPath: '.' });
      parsed.repos[parsed.repos.length - 1].engine = v as WatchRepo['engine'];
    } else if (a === '--exclude') {
      if (parsed.repos.length === 0) parsed.repos.push({ repoPath: '.' });
      (parsed.repos[parsed.repos.length - 1].excludes ??= []).push(needValue(a));
    } else if (a === '--pr-base') {
      if (parsed.repos.length === 0) parsed.repos.push({ repoPath: '.' });
      parsed.repos[parsed.repos.length - 1].prBase = needValue(a);
    } else if (a === '--interval') {
      const v = Number(needValue(a));
      if (!Number.isFinite(v) || v <= 0) throw new Error('--interval must be a positive number of seconds');
      parsed.intervalSeconds = v;
    } else if (a === '--once') parsed.once = true;
    else if (a === '--push') parsed.push = true;
    else if (a === '--json') parsed.json = true;
    else if (a === '--help' || a === '-h') parsed.help = true;
    else throw new Error(`unknown watch flag: ${a}`);
  }
  if (parsed.repos.length === 0) throw new Error('watch needs at least one --repo <path>');
  return parsed;
}

function watchUsage(): void {
  console.log(`migratepr v${VERSION} — self-maintaining watch mode

Usage:
  migratepr watch --repo <path> [--repo <path> ...] [options]

Watches repositories for migration-relevant changes (SDK pin or call sites
moving) and runs the full detect → rewrite → verify → deliver pipeline only
when something actually changed. Unchanged repos are skipped via a persisted
fingerprint (data/watch.json), so the loop never re-opens duplicate PRs.

Flags:
  --repo <path>      Repo to watch (repeatable)
  --track <id>       Migration track for the last --repo (default: auto-detect)
  --engine <mode>    rules | llm | auto for the last --repo (default: auto)
  --exclude <glob>   Exclude glob for the last --repo (repeatable)
  --pr-base <branch> PR base branch for the last --repo
  --interval <sec>   Loop interval (default: 3600). 0 runs once.
  --once             Run a single cycle and exit (same as --interval 0)
  --push             Open real PRs (requires clean git tree + gh auth)
  --json             Machine-readable per-cycle output
  -h, --help         Show this help

Example:
  migratepr watch --repo . --repo ../other-app --interval 3600
`);
}

async function runWatch(argv: string[]): Promise<number> {
  let args: WatchArgs;
  try {
    args = parseWatchArgs(argv);
  } catch (err) {
    console.error(red((err as Error).message));
    watchUsage();
    return EXIT.USAGE;
  }
  if (args.help) return watchUsage(), EXIT.OK;

  const opts = {
    repos: args.repos,
    intervalSeconds: args.once ? 0 : args.intervalSeconds,
    push: args.push,
  };

  const onCycle = (results: WatchResult[]): void => {
    if (args.json) {
      console.log(JSON.stringify(results));
      return;
    }
    console.log(bold('MigratePR watch — ' + new Date().toISOString()));
    for (const r of results) {
      const state = r.skipped
        ? dim('unchanged')
        : r.outcome === 'migrated'
          ? green('migrated')
          : r.outcome === 'error'
            ? red('error')
            : yellow(r.outcome);
      console.log(
        `  ${r.repoPath}: ${state}` +
          (r.findings !== undefined ? dim(` (${r.findings} findings, ${r.rewrites} rewrites)`) : '') +
          (r.prUrl ? dim(` → ${r.prUrl}`) : ''),
      );
      if (r.message && !r.skipped) console.log(dim(`    ${r.message}`));
    }
  };

  if (opts.intervalSeconds === 0) {
    onCycle(await watchCycle(opts));
    return EXIT.OK;
  }

  console.log(
    dim(`watching ${args.repos.length} repo(s) every ${opts.intervalSeconds}s — Ctrl+C to stop`),
  );
  await watchLoop(opts, onCycle);
  return EXIT.OK;
}

main()
  .then(code => {
    process.exitCode = code;
  })
  .catch(err => {
    console.error(red(err instanceof Error ? err.message : String(err)));
    process.exitCode = EXIT.USAGE;
  });
