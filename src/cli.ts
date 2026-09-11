#!/usr/bin/env node
import * as fs from 'fs';
import { migrate } from './migrate';
import { TRACKS } from './rules';
import { watchCycle, watchLoop, WatchRepo, WatchResult } from './watch';
import { generateRulesFromGuide, smokeTestTrack } from './rulegen';
import { makeLlmProvider } from './engine';
import { buildAppManifest } from './github-app';
import { loadConfig } from './config';
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
  verifyGates: string[];
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
    verifyGates: [],
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
    else if (a === '--gate') parsed.verifyGates.push(needValue(a));
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
  --gate <name>        Extra verify gate: an npm script (typecheck/build/lint) run at
                       baseline and post-migration (repeatable)
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
  if (argv[0] === 'rulegen') {
    return runRulegen(argv.slice(1));
  }
  if (argv[0] === 'github-app') {
    return runGithubApp(argv.slice(1));
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
    verifyGates: args.verifyGates,
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
  for (const g of report.gates ?? []) {
    console.log(
      `Gate (${g.name}): baseline ${g.baseline.ok ? green('pass') : red('fail')} · post ${g.post.ok ? green('pass') : red('fail')}` +
        dim(` (${g.command})`),
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

/* ------------------------------- rulegen ------------------------------- */

interface RulegenArgs {
  guide: string;
  vendor: string;
  sdk: string;
  from: number;
  to: number;
  apiFrom?: string;
  apiTo?: string;
  id?: string;
  guideUrl?: string;
  repo?: string;
  write: boolean;
  maxRules: number;
  json: boolean;
  help: boolean;
}

function parseRulegenArgs(argv: string[]): RulegenArgs {
  const parsed: RulegenArgs = {
    guide: '',
    vendor: '',
    sdk: '',
    from: 0,
    to: 0,
    write: false,
    maxRules: 25,
    json: false,
    help: false,
  };
  const needValue = (flag: string): string => {
    const v = argv[++i];
    if (v === undefined) throw new Error(`missing value for ${flag}`);
    return v;
  };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--guide') parsed.guide = needValue(a);
    else if (a === '--vendor') parsed.vendor = needValue(a);
    else if (a === '--sdk') parsed.sdk = needValue(a);
    else if (a === '--from') parsed.from = Number(needValue(a));
    else if (a === '--to') parsed.to = Number(needValue(a));
    else if (a === '--api-from') parsed.apiFrom = needValue(a);
    else if (a === '--api-to') parsed.apiTo = needValue(a);
    else if (a === '--id') parsed.id = needValue(a);
    else if (a === '--guide-url') parsed.guideUrl = needValue(a);
    else if (a === '--repo') parsed.repo = needValue(a);
    else if (a === '--max-rules') parsed.maxRules = Number(needValue(a));
    else if (a === '--write') parsed.write = true;
    else if (a === '--json') parsed.json = true;
    else if (a === '--help' || a === '-h') parsed.help = true;
    else throw new Error(`unknown rulegen flag: ${a}`);
  }
  if (parsed.help) return parsed;
  if (!parsed.guide) throw new Error('rulegen needs --guide <file> (use "-" for stdin)');
  if (!parsed.vendor) throw new Error('rulegen needs --vendor <name>');
  if (!parsed.sdk) throw new Error('rulegen needs --sdk <npm-package>');
  if (!Number.isInteger(parsed.from) || parsed.from <= 0 || !Number.isInteger(parsed.to) || parsed.to <= 0) {
    throw new Error('rulegen needs integer --from and --to major versions');
  }
  return parsed;
}

function rulegenUsage(): void {
  console.log(`migratepr v${VERSION} — AI rule generation from migration guides

Usage:
  migratepr rulegen --guide <file> --vendor <name> --sdk <pkg> --from <n> --to <n> [options]

Reads an official vendor migration guide (markdown), asks the LLM engine for a
structured rule set, validates it against the exact same schema as
.migratepr.json tracks, and prints the track (or writes it to config).

Flags:
  --guide <file>   Migration guide markdown ("-" reads stdin)
  --vendor <name>  Vendor name, e.g. openai
  --sdk <pkg>      npm package name, e.g. openai
  --from <n>       SDK major version being migrated FROM
  --to <n>         SDK major version being migrated TO
  --api-from <s>   API version string before (optional)
  --api-to <s>     API version string after (optional)
  --id <trackId>   Track id (default: <vendor>-v<from>-to-v<to>)
  --guide-url <u>  Source URL recorded on every rule
  --repo <path>    Smoke-test the generated rules on a real repo (scan only)
  --max-rules <n>  Cap on generated rules (default 25)
  --write          Merge the track into .migratepr.json
  --json           Print the raw track JSON
  -h, --help       Show this help

Requires an LLM provider: set ANTHROPIC_API_KEY / OPENAI_API_KEY / GROQ_API_KEY /
MISTRAL_API_KEY / DEEPSEEK_API_KEY / OPENROUTER_API_KEY, or have Ollama running.
`);
}

async function runRulegen(argv: string[]): Promise<number> {
  let args: RulegenArgs;
  try {
    args = parseRulegenArgs(argv);
  } catch (err) {
    console.error(red((err as Error).message));
    rulegenUsage();
    return EXIT.USAGE;
  }
  if (args.help) return rulegenUsage(), EXIT.OK;

  let guideText: string;
  try {
    guideText = args.guide === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(args.guide, 'utf8');
  } catch (err) {
    console.error(red(`cannot read guide: ${(err as Error).message}`));
    return EXIT.USAGE;
  }

  const provider = await makeLlmProvider();
  if (!provider) {
    console.error(
      red('no LLM provider available — set ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, DEEPSEEK_API_KEY or OPENROUTER_API_KEY, or start Ollama'),
    );
    return EXIT.USAGE;
  }

  console.log(dim(`rulegen: extracting rules from ${args.guide} via ${provider.name}…`));
  const { track, raw, warnings } = await generateRulesFromGuide({
    guideText,
    vendor: args.vendor,
    sdkModule: args.sdk,
    sdkFrom: args.from,
    sdkTo: args.to,
    apiFrom: args.apiFrom ?? `v${args.from}`,
    apiTo: args.apiTo ?? `v${args.to}`,
    trackId: args.id,
    guideUrl: args.guideUrl,
    provider,
    maxRules: args.maxRules,
  });

  if (args.json) {
    console.log(JSON.stringify({ track, raw, warnings }, null, 2));
    return EXIT.OK;
  }

  console.log(bold(`Track: ${track.id} — ${track.rules.length} rules`));
  for (const w of warnings) console.log(yellow(`· ${w}`));
  for (const r of track.rules) {
    console.log(`  ${r.kind.padEnd(18)} ${r.id}  ${dim(r.summary)}`);
  }

  if (args.repo) {
    console.log('');
    console.log(bold(`Smoke test against ${args.repo}:`));
    const hits = smokeTestTrack(track, args.repo);
    if (hits.length === 0) {
      console.log(yellow('  no findings — the generated rules matched nothing in that repo'));
    } else {
      for (const h of hits) {
        console.log(`  ${green(String(h.findings).padStart(3))} finding(s)  ${h.ruleId}  ${dim(h.sampleFile ?? '')}`);
      }
    }
  }

  if (args.write) {
    const cfgPath = '.migratepr.json';
    const { config } = loadConfig('.');
    const tracks = [...(config.tracks ?? []).filter(t => t.id !== track.id), track];
    const out = JSON.stringify({ ...config, tracks }, null, 2) + '\n';
    fs.writeFileSync(cfgPath, out, 'utf8');
    console.log(`\n${green('written')} — ${track.id} merged into ${cfgPath}`);
  }
  return EXIT.OK;
}

/* ------------------------------- github-app ------------------------------- */

function runGithubApp(argv: string[]): number {
  let name = 'migratepr';
  let url = 'https://github.com/trajectiq-ai/migratepr';
  let hookUrl: string | undefined;
  let help = false;
  const needValue = (flag: string): string => {
    const v = argv[++i];
    if (v === undefined) throw new Error(`missing value for ${flag}`);
    return v;
  };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') name = needValue(a);
    else if (a === '--url') url = needValue(a);
    else if (a === '--hook-url') hookUrl = needValue(a);
    else if (a === '--help' || a === '-h') help = true;
    else throw new Error(`unknown github-app flag: ${a}`);
  }
  if (help) {
    console.log(`migratepr github-app — create the MigratePR GitHub App

Usage:
  migratepr github-app [--name <app>] [--url <homepage>] [--hook-url <https-url>]

Prints a GitHub App manifest. To create the app:
  1. Run this command and copy the JSON.
  2. Open https://github.com/settings/apps/new and paste the manifest (or
     POST it to github.com/settings/apps/new with a form field url=...).
  3. GitHub returns a temporary code; exchange it for the app's credentials
     via POST /app-manifests/<code>/conversions.
  4. Store the app id + private key + webhook secret, and wire the webhook
     URL to your MigratePR server. The server verifies every delivery with
     X-Hub-Signature-256 (HMAC-SHA256) before acting.

The manifest requests: read code, write PRs, write checks. Events: push
(default branch) and pull_request (so the bot ignores its own PRs).
`);
    return EXIT.OK;
  }
  const manifest = buildAppManifest({ name, url, hookUrl });
  console.log(JSON.stringify(manifest, null, 2));
  return EXIT.OK;
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
