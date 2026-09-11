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

Track auto-detection is vendor-driven: the pinned SDK major in `package.json`
picks the track (`stripe@^12` → `stripe-v12-to-v13`, `express@^4` →
`express-v4-to-v5`, `openai@^3` → `openai-v3-to-v4`).
`migratepr --list-tracks` shows all supported upgrade paths.

| Track | SDK upgrade | What gets rewritten |
|---|---|---|
| `stripe-v12-to-v13` | stripe ^12 → ^13 | `subscriptions.del()` → `cancel()`, `shipping_rates` → `shipping_options` reshape, API pin, Jest mocks, test assertions |
| `stripe-v17-to-v18` | stripe ^17 → ^18 | Upcoming Invoice API → Create Preview (`retrieveUpcoming` → `createPreview`), API pin |
| `express-v4-to-v5` | express ^4 → ^5 | `app.del()` → `app.delete()`, route wildcards, Express mocks, SDK bump |
| `openai-v3-to-v4` | openai ^3 → ^4 | 10 flat methods → namespaced resources (`createChatCompletion` → `chat.completions.create`, `createEmbedding` → `embeddings.create`, …), client constructor (LLM), SDK bump |

## Custom tracks — the JSON rule DSL

Tracks are pure data. Define your own vendor migrations in `.migratepr.json`
— no TypeScript, no rebuild — and the whole engine (scan → rewrite → verify →
watch) picks them up. Custom tracks override built-ins with the same id.

```jsonc
{
  "tracks": [
    {
      "id": "acme-sdk-v1-to-v2",
      "vendor": "acme",
      "sdkModule": "@acme/sdk",
      "sdkFrom": 1,
      "sdkTo": 2,
      "apiFrom": "1.0",
      "apiTo": "2.0",
      "guideUrls": ["https://docs.acme.example/migration-v2"],
      "rules": [
        {
          "kind": "method-rename",
          "resource": "widgets",
          "from": "destroy",
          "to": "remove",
          "summary": "widgets.destroy() became widgets.remove() in v2",
          "guideUrl": "https://docs.acme.example/migration-v2",
          "risk": "mechanical"
        },
        { "kind": "sdk-bump", "packageName": "@acme/sdk", "to": "^2.0.0", "summary": "Bump to v2", "guideUrl": "…", "risk": "mechanical" }
      ]
    }
  ]
}
```

Rule kinds: `method-rename` (resource + from/to), `method-move` (flat client
method → a namespaced chain, e.g. `createChatCompletion` →
`chat.completions.create`), `param-rename` (optional `method`, `wrapTemplate`
value reshape), `api-version` (from/to pin), `mock-method-key` (test doubles),
`client-constructor` (construction shape change — `needsLlm: true`), and
`sdk-bump` (package.json range).
`resource` is the property chain before the method (`'subscriptions'` for
`stripe.subscriptions.del`); leave it `""` when the client itself is the
resource (e.g. `app.del(...)`). `risk` is `mechanical` | `review-recommended`
| `semantic`. Invalid tracks fail loudly with a precise error instead of
silently doing nothing.

## Self-maintaining watch (keep repos migrated automatically)

`migratepr watch` is the loop that makes the product's name true: it watches one
or more repos and runs the full pipeline **only when something actually changed**
— a new call site, a downgraded SDK pin, a reverted migration. Unchanged repos
are skipped via a persisted fingerprint (`data/watch.json`), so the loop never
re-opens duplicate PRs and never re-runs failing migrations against the same
code.

```bash
# One cycle now (useful for cron)
migratepr watch --repo path/to/repo --once

# Loop forever, checking every hour (dry-run: prints PR payloads)
migratepr watch --repo path/to/repo --interval 3600

# Multiple repos + real delivery (clean git tree + gh auth required)
migratepr watch --repo app-a --repo app-b --push --interval 86400
```

Every cycle prints one line per repo: `migrated (n findings, m rewrites)`,
`unchanged`, `aborted`, or `error`. After a `--push` cycle the repo stays
"delivered" (PR URL recorded) until its code changes again — merge the PR and
the loop resumes watching normally.

**Hosted version (no local machine needed):** copy
[`examples/watch-workflow.yml`](examples/watch-workflow.yml) into your repo as
`.github/workflows/migratepr-watch.yml`. It runs daily on GitHub Actions, skips
when a migration PR is already open, and opens the next PR with `GITHUB_TOKEN`
— zero extra secrets for public repos.

## Verify gates — prove it with your own tooling

The test suite is the primary gate, but repos have stricter contracts. Extra
gates run at **both** stages — before any rewrite and after — and a failure
aborts and reverts:

```bash
migratepr --repo path/to/repo --gate typecheck --gate lint
```

Or in `.migratepr.json`: `"verifyGates": ["typecheck", "lint"]`. Each gate is an
npm script. Failing **before** the migration means the repo was already broken →
nothing is touched. Failing **after** means MigratePR broke it → every file is
restored byte-for-byte. A gate whose script does not exist is skipped with a
logged note (never a silent pass). Results appear in the report (`gates[]`) and
in the web app's job view.

## AI rule generation — turn a migration guide into rules

The rule library is the moat, so generating rules should be cheap. `rulegen`
reads an official vendor migration guide (markdown), asks the LLM engine for a
rule set, and **validates it through the exact same schema as
`.migratepr.json`** — an LLM draft never ships unvalidated.

```bash
# Generate and print (validated) rules; --write merges into .migratepr.json
migratepr rulegen --guide docs/v2-migration.md \
  --vendor acme --sdk @acme/sdk --from 1 --to 2 --json

# Smoke-test the draft against a real repo: which rules actually match code?
migratepr rulegen --guide docs/v2-migration.md --vendor acme \
  --sdk @acme/sdk --from 1 --to 2 --repo path/to/repo
```

Workflow: generate → review the JSON → smoke-test against a real repo →
`--write` → run the normal pipeline. Try it with **zero API keys** using the
included guide (local Ollama):

```bash
migratepr rulegen --guide examples/rulegen-guide-express.md \
  --vendor express --sdk express --from 4 --to 5
```

Guardrails: removals with no mechanical equivalent are deliberately skipped
(never fabricated), rules with unknown kinds are dropped with a warning rather
to fail a whole draft, `sdk-bump` rules targeting the wrong package are dropped,
and the output is accepted in any of the shapes models emit (`{"rules": …}`, a
bare array, or a full track envelope).

## GitHub App — the hosted self-maintaining service

The watch loop and the scheduled workflow need no server. For a multi-repo
service, MigratePR ships the code-level pieces of a GitHub App:

```bash
migratepr github-app --name migratepr --url https://your-host --hook-url https://your-host/webhook
```

It prints a **GitHub App manifest** (paste it at `github.com/settings/apps/new`
to create the app in one step) with minimal scope — read code, write PRs, write
checks — subscribed to `push` and `pull_request`.

`src/github-app.ts` also provides the two server-side primitives: **timing-safe
HMAC-SHA256 webhook verification** (`X-Hub-Signature-256`) and the **event
router** that decides whether a delivery warrants a migration run — a push to
the default branch that touched dependency files, or a scheduled sweep. PR
events are ignored so the loop never reacts to its own pull requests.

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
| `--gate <name>` | — | Extra npm-script gate run before *and* after migration (repeatable) |
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

### Subcommands

| Command | What it does |
|---|---|
| `migratepr` | One migration run (flags above) |
| `migratepr doctor` | Detect local LLMs, save a default, or print free setup options |
| `migratepr watch` | Self-maintaining loop over one or more repos |
| `migratepr rulegen` | Generate + validate rules from an official migration guide |
| `migratepr github-app` | Print the GitHub App manifest |

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
  "verifyGates": ["typecheck"],        // npm scripts run before AND after
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

## Finding an LLM automatically (`migratepr doctor`)

Install MigratePR on a machine you have never seen and you should not be interrogated about model choices. `migratepr doctor` scans the system and configures itself:

```bash
migratepr doctor               # detect, then save the best option as the default
migratepr doctor --json        # machine-readable (for installers)
migratepr doctor --set-default ollama
migratepr doctor --no-write    # report only
```

What it does:

1. **Probes local runtimes** in parallel on their well-known ports — Ollama (`:11434`), LM Studio (`:1234`), Jan (`:1337`), llama.cpp (`:8080`), vLLM (`:8000`), LocalAI, GPT4All, KoboldCpp, text-generation-webui — and lists the models each one has.
2. **Flags runtimes that are installed but stopped** (binary on `PATH`, nothing listening), so the fix is one command rather than a reinstall.
3. **Checks the environment** for cloud API keys that are already set.
4. **Saves the best option as the default** (`data/llm.json`) so every later run — CLI, watch loop, web app — works with no configuration.
5. **If nothing is found**, prints free options with exact copy-pasteable commands, ordered by effort.

Example on a machine with Ollama running:

```text
Local runtimes
  ✔ Ollama      http://127.0.0.1:11434/v1  12 model(s) · using qwen3:8b
  ! LM Studio   installed but not running

Effective provider
  ollama · qwen3:8b — saved default (detected ollama)
```

When nothing is available, doctor recommends the following — and **option 1 is genuinely sufficient**:

| Option | Cost | Effort | Privacy |
|---|---|---|---|
| **1. Do nothing** — deterministic rules engine | free | none | code never leaves the machine |
| **2. Groq** free tier | free | one key, no install | affected files sent to Groq |
| **3. OpenRouter** free models | free | one key, no install | affected files sent to OpenRouter |
| **4. Ollama** | free | one install (~4.7 GB) | **nothing leaves the machine** |
| **5. Your own endpoint** via `MIGRATEPR_BASE_URL` | varies | already have it | your infrastructure |

Most migrations are mechanical, so MigratePR needs no LLM at all: the model is only consulted for changes a rule cannot express, and those findings are *skipped* — never guessed — when no provider is configured. Doctor says so plainly rather than pressuring the customer into a download.

Discovery never installs anything, never sends data anywhere, and never writes a credential — only a provider name, a base URL, and a model name.

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
| **Any OpenAI-compatible endpoint** | `MIGRATEPR_BASE_URL` (+ optional `MIGRATEPR_API_KEY`) | `MIGRATEPR_MODEL` | — |

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

Provider priority: explicit `MIGRATEPR_LLM_PROVIDER` → first cloud key present (Anthropic → OpenAI → Groq → Mistral → DeepSeek → OpenRouter) → `MIGRATEPR_BASE_URL` → the default saved by `migratepr doctor` → a reachable local Ollama → none (rules engine only). The web app's key manager supports every named provider above (with live "Test" checks, including Ollama reachability and model listing).

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
