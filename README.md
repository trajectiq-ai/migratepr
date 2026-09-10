# MigratePR

**Dependabot for API logic — we don't just bump the version number, we rewrite your code to work with the new API.**

MigratePR detects third-party API breaking changes in your codebase (Stripe first), finds every affected SDK call site with deterministic AST analysis, rewrites the code (rules by default, an LLM constrained by the official migration guide when needed), verifies the change by running *your* test suite, and opens a ready-to-review Pull Request.

Built from the YC Fall 2026 RFS "Self-Maintaining APIs."

## The pipeline

```
detect ──► rewrite ──► verify ──► deliver
  │           │           │          │
  │ ts-morph  │ rules or  │ repo's   │ PR payload
  │ AST scan  │ guide-    │ own test │ (git push +
  │ (no LLM)  │ constrained│ suite    │  gh pr create,
  │           │ LLM        │ 2× green │  opt-in)
```

Design invariants:

1. **Detection is deterministic.** The scanner is pure ts-morph — no LLM decides what to change, so there are no hallucinated findings.
2. **Rules before LLM.** Mechanical rules (renames, reshapes, pins) are applied by the deterministic engine. The LLM only handles what rules can't, and its output is validated (required change present + file still parses) before it is written.
3. **Tests gate everything.** Baseline must be green *before* a byte changes; post-migration must be green *or every change is reverted byte-for-byte and no PR is produced*.
4. **Dry-run by default.** Nothing leaves the machine unless you pass `--push`.

## Install

Requires Node ≥ 18.

```bash
npm install -g migratepr      # or: npx migratepr …
# from source:
git clone <this repo> && npm install && npm run build
```

## Quickstart

```bash
# Dry run against any repo: findings, rewrites, two test runs, PR payload. Nothing pushed.
migratepr --repo path/to/repo

# Machine-readable report (also: --out report.json)
migratepr --repo path/to/repo --json

# Real delivery: branch + commit + push + PR (requires git + gh auth; refuses dirty trees)
migratepr --repo path/to/repo --push
```

Track auto-detection: `stripe@^12` in `package.json` → the `stripe-v12-to-v13` track. `migratepr --list-tracks` shows all supported upgrade paths.

## Web app (register · login · run migrations · manage AI keys)

MigratePR ships with a zero-dependency web UI on top of the same engine:

```bash
npm run web        # build + start → http://127.0.0.1:3777
npm run web:start  # start without rebuilding
```

What you get in the browser:

- **Register / login** — accounts with salted scrypt password hashing and HttpOnly signed session cookies (7-day sessions, logout revokes server-side).
- **AI API keys** — add Anthropic or OpenAI keys; they are stored **AES-256-GCM encrypted** on this machine, displayed only as a masked hint (`sk-ant-…9f2c`), and can be **tested live** with one minimal request to the provider (`valid / invalid` verdict is recorded).
- **Run migrations** — point the app at any local repo path, pick the engine (`auto` / `rules` / `llm`) and track, and watch the queued job run the full pipeline: detect → rewrite → baseline tests → post-migration tests → report, with the PR body and diff rendered in the UI.
- **Job history** — every run's complete report is kept per user (`data/jobs/`), survives server restarts, and is scoped so users only ever see their own jobs.

Security notes: keys never leave the server unencrypted (not even to the browser); the LLM engine automatically uses a stored key for the signed-in user, preferring keys whose live test succeeded; the server binds to `127.0.0.1` by default (override with `MIGRATEPR_WEB_HOST` / `MIGRATEPR_WEB_PORT`; `data/` location override: `MIGRATEPR_DATA_DIR`). This is a local, single-machine app — do not expose it directly to the internet without putting auth/TLS in front.

## Real-world example (real SDK, real Jest)

`realworld-sample/` is a runnable repo that installs **real `stripe@12` and real `jest` from npm** (no stubs) and exercises every pattern real codebases use:

- **Cross-file wrapper module** — `src/stripeClient.js` creates the client; other files never import the SDK directly. The scanner resolves `const { stripe } = require('./stripeClient')` across files, in both `require` and `import` forms.
- **Aliases** — `const createCheckout = stripe.checkout.sessions.create`.
- **Class clients** — `constructor(client = stripe)` + `this.client.subscriptions.del(...)`.
- **Value-position references** — `stripe.subscriptions.del.mockResolvedValue(...)` and `expect(stripe.subscriptions.del)...` (no call at the site).
- **Jest manual mock** — `__mocks__/stripe.js` implementing the removed method.
- **Test assertions that encode the old API contract** — `expect.objectContaining({ shipping_rates: [...] })` is reshaped to the new contract.

Run it:

```bash
node dist/src/cli.js --repo realworld-sample          # dry run: 9 findings, 10 rewrites, tests 2× green
node dist/src/cli.js --repo realworld-sample --push   # open the PR (needs git + gh)
```

The `--repo` path may be relative or absolute.

## CLI reference

| Flag | Default | Meaning |
|------|---------|---------|
| `--repo <path>` | `.` | Target repository |
| `--track <id>` | auto-detect | Migration track id |
| `--engine <mode>` | `auto` | `rules` = deterministic only · `llm` = force LLM · `auto` = rules first, LLM for the rest |
| `--push` / `--dry-run` | `--dry-run` | Open the PR / stay local |
| `--json` / `--out <file>` | off | Full JSON report (stdout / file) |
| `--exclude <glob>` | — | Exclude files from scanning (repeatable; `generated/` excludes the whole directory) |
| `--skip-rule <id>` | — | Skip a rule id (repeatable) |
| `--install` / `--no-install` | `--no-install` | Run `npm install` after dependency bumps |
| `--verify-command <c>` | repo's test script | Override the verify command |
| `--timeout <ms>` | 600000 | Per-run verify timeout (timeout ⇒ exit code 124 recorded) |
| `--require-git` | off | Refuse to run outside a git checkout |
| `--pr-base <branch>` | branch HEAD had | Base branch for the PR |
| `--list-tracks` / `--version` / `-h` | — | Info |

### Exit codes (stable CI contract)

| Code | Meaning |
|------|---------|
| `0` | Migration succeeded (PR payload produced) |
| `1` | Aborted — the verify gate stopped it (all changes reverted) or delivery failed |
| `2` | Diff-review — repo has no runnable test suite; nothing was attempted |
| `3` | Usage or configuration error |

## Configuration: `.migratepr.json`

Commit one to the repo so everyone (and CI) gets the same behavior. Unknown keys are ignored (forward-compatible); precedence is **CLI flag > config file > default**.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/your-org/migratepr/main/schema/migratepr.schema.json",
  "track": "stripe-v12-to-v13",       // or omit to auto-detect
  "engine": "rules",                  // rules | llm | auto
  "exclude": ["generated/", "**/*.gen.ts"],
  "skipRules": ["stripe-v12-to-v13:checkout-shipping-options"],
  "verifyCommand": "make test",       // optional override
  "verifyTimeoutMs": 600000,
  "install": false,
  "prBase": "main"
}
```

`migratepr.config.json` is accepted as an alternative filename. An invalid config fails loudly (exit 3) before anything is touched.

## What a migration PR looks like

For `examples/checkout-demo` (Stripe v12 usage), MigratePR finds 3 call sites and produces 4 rewrites:

| Before | After | Rule |
|--------|-------|------|
| `stripe.subscriptions.del(id)` | `stripe.subscriptions.cancel(id)` | v13 removed `del` |
| `shipping_rates: [id]` | `shipping_options: [{ shipping_rate: id }]` | v13 removed `shipping_rates` — note the **value reshape**, not just a rename |
| `apiVersion: '2022-11-15'` | `apiVersion: '2023-08-16'` | API pin bump |
| `stripe@^12.18.0` | `stripe@^13.11.0` | SDK bump |

The PR body includes the verification receipt (baseline green, post-migration green), a change table with the engine used per change, every affected call site with its snippet, a collapsible diff, and links to the official migration guides.

## Safety model

- **Abort-and-revert:** any red post-migration run restores every file byte-for-byte from a pre-migration snapshot. No PR. (Covered by tests and reproducible live.)
- **Git preflights for `--push`:** must be a git checkout with ≥ 1 commit and a *clean* working tree. MigratePR never mixes its changes with yours.
- **Write guards:** rewrites cannot escape the repo root or touch `package.json` (dependency changes go exclusively through sdk-bump rules).
- **Placeholder detection:** a test script like `echo "Error: no test specified" && exit 1` is treated as *no test suite* → diff-review, never a false green.
- **Verify timeout:** hung suites are killed (exit 124 in the report) instead of hanging your CI.
- **LLM output validation:** required change present + syntax parse, then the test gate. Fenced markdown output is tolerated; everything else is rejected.

## LLM engine

Deterministic rules handle most migrations. For what they can't express, configure a provider and use `--engine llm` (or `auto`). Seven providers are supported:

| Provider | Activate with | Default model | Model override |
|---|---|---|---|
| **Anthropic** | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` | `MIGRATEPR_ANTHROPIC_MODEL` |
| **OpenAI** | `OPENAI_API_KEY` | `gpt-4o-mini` | `MIGRATEPR_OPENAI_MODEL` |
| **Groq** | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | `MIGRATEPR_GROQ_MODEL` |
| **Mistral** | `MISTRAL_API_KEY` | `mistral-large-latest` | `MIGRATEPR_MISTRAL_MODEL` |
| **DeepSeek** | `DEEPSEEK_API_KEY` | `deepseek-coder` | `MIGRATEPR_DEEPSEEK_MODEL` |
| **OpenRouter** | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4.5` | `MIGRATEPR_OPENROUTER_MODEL` |
| **Ollama (local)** | no key — just run `ollama serve` | auto-picked (see below) | `MIGRATEPR_OLLAMA_MODEL` |

```bash
# cloud: any one key is enough
export GROQ_API_KEY=gsk_…
migratepr --repo . --engine auto

# fully local, zero-config: if Ollama is running it is used automatically
ollama serve
ollama pull qwen2.5-coder:7b
migratepr --repo . --engine llm
```

**Ollama (fully local, private — code never leaves your machine):**

- Server URL via `OLLAMA_HOST` (default `http://127.0.0.1:11434`)
- The best installed model is auto-picked (code-tuned models preferred). Force one with `MIGRATEPR_OLLAMA_MODEL`
- Force provider selection explicitly with `MIGRATEPR_LLM_PROVIDER` (one of: `anthropic`, `openai`, `groq`, `mistral`, `deepseek`, `openrouter`, `ollama`)

Provider priority with multiple keys set: Anthropic → OpenAI → Groq → Mistral → DeepSeek → OpenRouter → local Ollama. The web app's key manager supports every provider above (with live "Test" checks, including Ollama reachability and model listing).

Prompts are constrained by the rule's official guide excerpt; requests have per-attempt timeouts and exponential backoff on 429/5xx.

## CI usage

### GitHub Actions (composite action)

```yaml
name: migratepr
on:
  schedule:
    - cron: '0 9 * * 1'   # weekly
  workflow_dispatch:
jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./                # once published: uses: your-org/migratepr-action@v1
        with:
          engine: rules
          push: 'true'
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Any CI (exit codes + JSON report)

```bash
migratepr --repo . --json --out migratepr-report.json
code=$?   # 0 → open PR payload; 1 → gate aborted; 2 → diff-review; 3 → config error
```

The repo's own CI (`.github/workflows/ci.yml`) runs the full matrix: Ubuntu/Windows/macOS × Node 18/20/22, typecheck, tests, build, demo, and CLI exit-code smoke checks.

## Architecture

| Piece | File |
|-------|------|
| AST scanner | `src/scanner.ts` — imports (default/namespace/`require()`/destructured), `new Stripe(...)` clients (including class properties and `this.client` chains), local aliases, pinned `apiVersion` strings; glob excludes; dot-dir skip |
| Rule registry | `src/rules/stripe.ts` — tracks `stripe-v12-to-v13`, `stripe-v17-to-v18` (Basil); every rule carries its official `guideUrl` |
| Rule engine | `src/rewriter.ts` — deterministic ts-morph edits; returns null rather than guess |
| Bump | `src/bump.ts` — multi-SDK `package.json` bump in one pass |
| LLM engine | `src/engine.ts` + `src/providers/` — pluggable `LlmProvider`, validation before write |
| Verify | `src/verify.ts` — baseline/post runs, placeholder detection, timeouts |
| Config | `src/config.ts` — `.migratepr.json` loader + validator |
| Orchestrator | `src/migrate.ts` — config precedence, preflights, snapshot/revert, delivery, PR payload |
| CLI | `src/cli.ts` — flags, JSON, exit codes |

### The rule library is the moat

Adding an upgrade path = one `MigrationTrack` entry with structured rules, each tied to its official source. Every vendor release adds rules; every merged PR (accept/edit/reject) tunes them. That dataset compounds; the code does not.

## Known limits

- `--push` uses local `git`/`gh` rather than the GitHub API; the GitHub App (webhooks, permissions, multi-repo) is the next milestone.
- Scanner roots: `src/`, `lib/`, `app/`, `test/`, `tests/`, `__tests__/` (falls back to the repo root); dot-directories are skipped.
- LLM validation is token-presence + syntax parse + the test gate — not full semantic equivalence.
- Only TypeScript/JavaScript today; Python (libcst) is planned.

## Publishing checklist (maintainers)

1. `npm run typecheck && npm test && npm run build`
2. Update `CHANGELOG.md`; bump `version` (SemVer)
3. `npm pack --dry-run` — confirm contents (dist/src + docs only)
4. `npm publish` (or tag and let CI publish)
5. Point the composite action's docs at the published package

## License

MIT — see [LICENSE](LICENSE).
