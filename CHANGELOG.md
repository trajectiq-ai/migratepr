# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [1.0.0] - 2026-09-08

First ship-ready release of the CLI.

### Added
- Deterministic AST scanner (ts-morph): finds `stripe.*` call sites through default/namespace/`require()` imports, `new Stripe(...)` clients (including class-property clients), local aliases, and pinned `apiVersion` strings; honors `.migratepr.json`/CLI exclude globs.
- Structured rule registry with official-source URLs; tracks: `stripe-v12-to-v13`, `stripe-v17-to-v18` (Basil). Auto-detects the track from `package.json`.
- Deterministic rule engine: method renames, param renames with value reshaping, API-version pins, `package.json` dependency bumps (multi-SDK in one pass).
- Pluggable LLM engine (Anthropic/OpenAI adapters) with per-attempt timeouts, backoff retries, fence unwrapping, and output validation (required change present + file parses) before write.
- Verification gate: runs the repo's own test suite at baseline and post-migration; placeholder test scripts (`echo … && exit 1`) are treated as absent; per-run timeout (exit 124 on timeout); optional post-bump `npm install`.
- Safety: abort-and-revert on any red run (byte-for-byte snapshot restore); git preflights for `--push` (checkout, ≥1 commit, clean tree); repo-root write guard in the rewriter; `--require-git` mode.
- Delivery: branch + commit + push + `gh pr create` (body via temp file), switch back, cleanup on failure.
- CLI 1.0: `--repo --track --engine --push --dry-run --json --out --exclude --skip-rule --install --no-install --verify-command --timeout --require-git --pr-base --list-tracks --version`; stable exit codes (0 ok / 1 aborted / 2 diff-review / 3 usage).
- Config file `.migratepr.json` (also `migratepr.config.json`) with validation; precedence: CLI flag > config file > default.
- JSON report contract for CI consumption (`--json`, `--out`).
- GitHub Actions reusable composite action (`action.yml`) for CI usage.
- 30+ tests covering scanner, rewriter, bump, config, glob, engine, and pipeline semantics including revert and delivery preflights.
