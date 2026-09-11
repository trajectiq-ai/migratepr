/**
 * Install-time LLM discovery — the engine behind `migratepr doctor`.
 *
 * Scans the customer's machine for anything that can serve as a migration LLM:
 *
 *   1. Local OpenAI-compatible runtimes (Ollama, LM Studio, llama.cpp, vLLM,
 *      Jan, LocalAI, GPT4All, KoboldCpp, text-generation-webui) — probed on
 *      their well-known ports.
 *   2. Cloud API keys already present in the environment.
 *
 * If a local runtime answers, it is persisted as the default provider so later
 * runs need zero configuration. If nothing is found the report says so
 * honestly and recommends free options with exact, copy-pasteable commands —
 * starting with the zero-dependency answer: the deterministic rules engine
 * needs no LLM at all, and that is the default path.
 *
 * This module deliberately does NOT import the engine (the engine imports it
 * to read the saved default), so the dependency direction stays acyclic.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { bold, cyan, dim, green, yellow } from './ansi';
import { PROVIDERS } from './web/providers';
import { OLLAMA_DEFAULT_MODEL, pickPreferredOllamaModel } from './providers/ollama';

/* ------------------------------ known runtimes ------------------------------ */

export interface LocalRuntimeSpec {
  id: string;
  name: string;
  /** OpenAI-compatible base URL (no trailing slash). */
  baseUrl: string;
  /** Native model-list endpoint, for runtimes that expose one (Ollama). */
  nativeModelsUrl?: string;
  /** CLI binary whose presence proves the runtime is installed. */
  binaries: string[];
  docsUrl: string;
  /** Exact install command per OS, or a download URL when there is no package. */
  install: { windows: string; macOS: string; linux: string };
}

export const LOCAL_RUNTIMES: LocalRuntimeSpec[] = [
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    nativeModelsUrl: 'http://127.0.0.1:11434/api/tags',
    binaries: ['ollama'],
    docsUrl: 'https://ollama.com/download',
    install: {
      windows: 'winget install Ollama.Ollama',
      macOS: 'brew install ollama',
      linux: 'curl -fsSL https://ollama.com/install.sh | sh',
    },
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    binaries: ['lms'],
    docsUrl: 'https://lmstudio.ai',
    install: {
      windows: 'Download from https://lmstudio.ai',
      macOS: 'Download from https://lmstudio.ai',
      linux: 'Download from https://lmstudio.ai',
    },
  },
  {
    id: 'jan',
    name: 'Jan',
    baseUrl: 'http://127.0.0.1:1337/v1',
    binaries: ['jan'],
    docsUrl: 'https://jan.ai',
    install: {
      windows: 'Download from https://jan.ai',
      macOS: 'brew install --cask jan',
      linux: 'Download from https://jan.ai',
    },
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp server',
    baseUrl: 'http://127.0.0.1:8080/v1',
    binaries: ['llama-server'],
    docsUrl: 'https://github.com/ggml-org/llama.cpp',
    install: {
      windows: 'Build: https://github.com/ggml-org/llama.cpp',
      macOS: 'brew install llama.cpp',
      linux: 'Build: https://github.com/ggml-org/llama.cpp',
    },
  },
  {
    id: 'localai',
    name: 'LocalAI',
    baseUrl: 'http://127.0.0.1:8080/v1',
    binaries: ['local-ai'],
    docsUrl: 'https://localai.io',
    install: {
      windows: 'docker run -p 8080:8080 localai/localai:latest',
      macOS: 'docker run -p 8080:8080 localai/localai:latest',
      linux: 'docker run -p 8080:8080 localai/localai:latest',
    },
  },
  {
    id: 'vllm',
    name: 'vLLM',
    baseUrl: 'http://127.0.0.1:8000/v1',
    binaries: ['vllm'],
    docsUrl: 'https://docs.vllm.ai',
    install: {
      windows: 'pip install vllm',
      macOS: 'pip install vllm',
      linux: 'pip install vllm',
    },
  },
  {
    id: 'gpt4all',
    name: 'GPT4All',
    baseUrl: 'http://127.0.0.1:4891/v1',
    binaries: [],
    docsUrl: 'https://www.nomic.ai/gpt4all',
    install: {
      windows: 'Download from https://www.nomic.ai/gpt4all',
      macOS: 'Download from https://www.nomic.ai/gpt4all',
      linux: 'Download from https://www.nomic.ai/gpt4all',
    },
  },
  {
    id: 'koboldcpp',
    name: 'KoboldCpp',
    baseUrl: 'http://127.0.0.1:5001/v1',
    binaries: ['koboldcpp'],
    docsUrl: 'https://github.com/LostRuins/koboldcpp',
    install: {
      windows: 'Download from https://github.com/LostRuins/koboldcpp',
      macOS: 'Download from https://github.com/LostRuins/koboldcpp',
      linux: 'Download from https://github.com/LostRuins/koboldcpp',
    },
  },
  {
    id: 'textgen',
    name: 'text-generation-webui',
    baseUrl: 'http://127.0.0.1:5000/v1',
    binaries: [],
    docsUrl: 'https://github.com/oobabooga/text-generation-webui',
    install: {
      windows: 'Download from https://github.com/oobabooga/text-generation-webui',
      macOS: 'Download from https://github.com/oobabooga/text-generation-webui',
      linux: 'Download from https://github.com/oobabooga/text-generation-webui',
    },
  },
];

/** Ollama is the recommended local runtime: one binary, one pull, no config. */
export const PREFERRED_RUNTIME_ORDER = ['ollama', 'lmstudio', 'jan', 'llamacpp', 'vllm', 'localai'];

/* --------------------------------- probing --------------------------------- */

const PROBE_TIMEOUT_MS = 1200;

async function getJson(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Best model for whole-file rewrites: prefer a code-tuned one. */
export function pickModel(models: string[]): string | undefined {
  if (models.length === 0) return undefined;
  return models.find(m => /coder|code/i.test(m)) ?? models[0];
}

export interface DetectedRuntime {
  runtime: LocalRuntimeSpec;
  baseUrl: string;
  models: string[];
  /** Model the engine would use. */
  model?: string;
}

/**
 * Probe one runtime. `overrides.baseUrl` lets callers (and tests) target a
 * non-default host; the native Ollama endpoint is derived from it too.
 */
export async function probeRuntime(
  spec: LocalRuntimeSpec,
  overrides: { baseUrl?: string } = {},
): Promise<DetectedRuntime | null> {
  const baseUrl = (overrides.baseUrl ?? spec.baseUrl).replace(/\/+$/, '');

  if (spec.id === 'ollama') {
    // Ollama exposes a richer native listing (names include the tag).
    const host = baseUrl.replace(/\/v1$/, '');
    const body = await getJson(`${host}/api/tags`);
    const models = Array.isArray((body as { models?: unknown })?.models)
      ? ((body as { models: Array<{ name?: string }> }).models
          .map(m => m.name ?? '')
          .filter(Boolean))
      : [];
    if (body === null) return null;
    return { runtime: spec, baseUrl, models, model: pickOllamaModel(models) };
  }

  const body = await getJson(`${baseUrl}/models`);
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return null;
  const models = data
    .map(m => (m && typeof m === 'object' ? (m as { id?: string }).id ?? '' : ''))
    .filter(Boolean);
  return { runtime: spec, baseUrl, models, model: pickModel(models) };
}

/** Ollama-specific preference (reuses the adapter's ranking, with a fallback). */
function pickOllamaModel(models: string[]): string {
  return models.length === 0 ? OLLAMA_DEFAULT_MODEL : pickPreferredOllamaModel(models);
}

/** True when a CLI binary is on PATH. Never throws, never hangs for long. */
export function commandExists(cmd: string): boolean {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore', timeout: 2500 });
    return true;
  } catch (err) {
    // ENOENT means "not installed"; any other failure means the binary ran.
    return (err as NodeJS.ErrnoException)?.code !== 'ENOENT';
  }
}

export interface DiscoveryResult {
  /** Runtimes answering right now. */
  reachable: DetectedRuntime[];
  /** Installed but not accepting requests — actionable: "start it". */
  installedButStopped: LocalRuntimeSpec[];
}

export async function discoverLocalRuntimes(): Promise<DiscoveryResult> {
  const ollamaHost = process.env.OLLAMA_HOST?.trim().replace(/\/+$/, '');
  const probed = await Promise.all(
    LOCAL_RUNTIMES.map(async spec => ({
      spec,
      // A remote/alternative Ollama host is a first-class setup, not an edge case.
      hit: await probeRuntime(
        spec,
        spec.id === 'ollama' && ollamaHost ? { baseUrl: `${ollamaHost}/v1` } : {},
      ),
    })),
  );
  const reachable = probed.filter(p => p.hit !== null).map(p => p.hit as DetectedRuntime);
  const stopped = probed
    .filter(p => p.hit === null && p.spec.binaries.some(commandExists))
    .map(p => p.spec);

  // Stable, opinionated ordering: Ollama first, then the rest as configured.
  const rank = (id: string): number => {
    const i = PREFERRED_RUNTIME_ORDER.indexOf(id);
    return i === -1 ? PREFERRED_RUNTIME_ORDER.length : i;
  };
  reachable.sort((a, b) => rank(a.runtime.id) - rank(b.runtime.id) || a.runtime.name.localeCompare(b.runtime.name));
  return { reachable, installedButStopped: stopped };
}

export interface CloudKey {
  id: string;
  displayName: string;
  envVar: string;
  signupUrl?: string;
}

/** Cloud providers whose API key is already present in the environment. */
export function discoverCloudKeys(env: NodeJS.ProcessEnv = process.env): CloudKey[] {
  return PROVIDERS.filter(p => p.envVar && env[p.envVar])
    .map(p => ({
      id: p.id,
      displayName: p.displayName,
      envVar: p.envVar as string,
      signupUrl: p.signupUrl,
    }));
}

/* ------------------------------ saved default ------------------------------ */

export interface DefaultProviderConfig {
  provider: string;
  /** For any OpenAI-compatible endpoint (LM Studio, vLLM, LiteLLM, Azure, …). */
  baseUrl?: string;
  model?: string;
  /** Which runtime discovery found — informational. */
  detectedVia?: string;
  savedAt?: string;
}

/** Core data directory (matches watch.ts; the web app's is one level deeper). */
export function coreDataDir(): string {
  return process.env.MIGRATEPR_DATA_DIR ?? path.join(__dirname, '..', '..', 'data');
}

export function defaultConfigPath(dataDir = coreDataDir()): string {
  return path.join(dataDir, 'llm.json');
}

/** Validate a persisted default; a malformed file is ignored, never fatal. */
export function parseDefaultConfig(raw: unknown): DefaultProviderConfig | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.provider !== 'string' || r.provider.trim().length === 0) return null;
  const out: DefaultProviderConfig = { provider: r.provider.trim() };
  if (typeof r.baseUrl === 'string' && r.baseUrl.trim().length > 0) out.baseUrl = r.baseUrl.trim();
  if (typeof r.model === 'string' && r.model.trim().length > 0) out.model = r.model.trim();
  if (typeof r.detectedVia === 'string') out.detectedVia = r.detectedVia;
  if (typeof r.savedAt === 'string') out.savedAt = r.savedAt;
  if (out.provider === 'custom' && !out.baseUrl) return null; // unusable
  return out;
}

export function readDefaultProvider(dataDir = coreDataDir()): DefaultProviderConfig | null {
  try {
    const p = defaultConfigPath(dataDir);
    if (!fs.existsSync(p)) return null;
    return parseDefaultConfig(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch {
    return null;
  }
}

/** Persist the chosen default (atomic write). Returns the file path. */
export function writeDefaultProvider(dataDir: string, cfg: DefaultProviderConfig): string {
  const p = defaultConfigPath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

export function clearDefaultProvider(dataDir = coreDataDir()): boolean {
  const p = defaultConfigPath(dataDir);
  if (!fs.existsSync(p)) return false;
  fs.rmSync(p, { force: true });
  return true;
}

/* ----------------------------- recommendations ----------------------------- */

export interface Recommendation {
  id: string;
  title: string;
  why: string;
  steps: string[];
  url?: string;
  /** True for "you do not need to do anything". */
  optional?: boolean;
}

/**
 * What to tell a customer who has no LLM. Ordered by effort: do nothing, then
 * a no-install cloud free tier, then a local runtime. Every option here is
 * either already supported by the engine or is a generic OpenAI-compatible
 * endpoint the engine can talk to today.
 */
export function buildRecommendations(platform: NodeJS.Platform = process.platform): Recommendation[] {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macOS' : 'linux';
  const ollama = LOCAL_RUNTIMES[0];
  const setKey =
    platform === 'win32'
      ? 'setx GROQ_API_KEY "gsk_your_key_here"   (open a new terminal afterwards)'
      : 'export GROQ_API_KEY=gsk_your_key_here    (add to ~/.bashrc or ~/.zshrc to persist)';

  return [
    {
      id: 'none-needed',
      title: 'Start here: do nothing (no LLM required)',
      why:
        'Most migrations are mechanical, and MigratePR applies them with deterministic rules that ' +
        'need no model at all. The LLM is only used for changes a rule cannot express — it never ' +
        'guesses, and it skips those findings when no provider is configured.',
      steps: ['migratepr --repo path/to/your/repo        # dry run: findings, rewrites and a PR payload'],
      optional: true,
    },
    {
      id: 'groq',
      title: 'Groq — free tier, no install, fastest to set up',
      why:
        'A free account gives you a generous free tier and a hosted Llama 3.3 70B. Nothing to ' +
        'install: one key and the LLM engine is live. Good if you want no local downloads and ' +
        'are comfortable sending the affected files to a hosted API.',
      steps: [`Get a free key: https://console.groq.com/keys`, setKey, 'migratepr doctor        # re-run to confirm it is detected'],
      url: 'https://console.groq.com/keys',
    },
    {
      id: 'openrouter',
      title: 'OpenRouter — one free key, hundreds of models',
      why:
        'Has genuinely free models (any model name ending in ":free"). No install, one key, and ' +
        'you can switch models with a single env var if output quality disappoints.',
      steps: [
        'Get a free key: https://openrouter.ai/keys',
        platform === 'win32'
          ? 'setx OPENROUTER_API_KEY "sk-or-your_key_here"'
          : 'export OPENROUTER_API_KEY=sk-or-your_key_here',
        'Optional: set MIGRATEPR_OPENROUTER_MODEL to a ":free" model id',
      ],
      url: 'https://openrouter.ai/keys',
    },
    {
      id: 'ollama',
      title: 'Ollama — free, fully local, nothing leaves your machine',
      why:
        'The best option for private code: runs on your hardware, needs no account, works offline, ' +
        'and costs nothing. Recommended if your code cannot be sent to a third party. A 7B code ' +
        'model is enough for whole-file rewrites.',
      steps: [
        `Install:  ${ollama.install[os as 'windows' | 'macOS' | 'linux']}`,
        'ollama pull qwen2.5-coder:7b        # ~4.7 GB, one time',
        'ollama serve                         # usually already running after install',
        'migratepr doctor                     # auto-detects and saves it as the default',
      ],
      url: ollama.docsUrl,
    },
    {
      id: 'any-endpoint',
      title: 'Already have an OpenAI-compatible endpoint? Point at it',
      why:
        'vLLM, LiteLLM, LM Studio, llama.cpp, Azure OpenAI, or a company gateway all speak the ' +
        'same API. MigratePR can drive any of them with no code changes and no new provider.',
      steps: [
        'export MIGRATEPR_BASE_URL=http://your-host:8000/v1',
        'export MIGRATEPR_MODEL=your-model-id',
        'export MIGRATEPR_API_KEY=optional-if-required',
      ],
      url: 'https://github.com/trajectiq-ai/migratepr#llm-engine',
    },
  ];
}

/* --------------------------------- the run --------------------------------- */

export interface DoctorReport {
  reachable: DetectedRuntime[];
  installedButStopped: LocalRuntimeSpec[];
  cloudKeys: CloudKey[];
  /** What the engine will actually use on the next run. */
  effective: { provider: string; model?: string; baseUrl?: string; source: string } | null;
  /** Set when discovery persisted a default. */
  savedTo?: string;
  recommendations: Recommendation[];
}

export interface DoctorOptions {
  dataDir?: string;
  /** Persist a detected runtime as the default. Defaults to true. */
  write?: boolean;
  /** Force a provider id (skips auto-selection). */
  setDefault?: string;
  platform?: NodeJS.Platform;
  /** Inject discovery results (tests). */
  discovery?: DiscoveryResult;
  keys?: CloudKey[];
}

/** Force the priority chain the engine uses, so doctor never lies about it. */
function describeEffective(
  cloudKeys: CloudKey[],
  saved: DefaultProviderConfig | null,
  reachable: DetectedRuntime[],
): DoctorReport['effective'] {
  const forced = process.env.MIGRATEPR_LLM_PROVIDER?.trim().toLowerCase();
  if (forced) return { provider: forced, model: undefined, source: 'MIGRATEPR_LLM_PROVIDER' };
  if (cloudKeys.length > 0) {
    return { provider: cloudKeys[0].id, source: `environment (${cloudKeys[0].envVar})` };
  }
  if (saved) {
    return {
      provider: saved.provider,
      model: saved.model,
      baseUrl: saved.baseUrl,
      source: saved.detectedVia ? `saved default (detected ${saved.detectedVia})` : 'saved default',
    };
  }
  if (process.env.MIGRATEPR_BASE_URL) {
    return {
      provider: 'custom',
      model: process.env.MIGRATEPR_MODEL,
      baseUrl: process.env.MIGRATEPR_BASE_URL,
      source: 'environment (MIGRATEPR_BASE_URL)',
    };
  }
  const ollama = reachable.find(r => r.runtime.id === 'ollama');
  if (ollama) {
    return { provider: 'ollama', model: ollama.model, baseUrl: ollama.baseUrl, source: 'detected locally' };
  }
  return null;
}

/** Soft-wrap a sentence for terminal output. */
function wrapText(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line.length === 0) line = w;
    else if (line.length + 1 + w.length <= width) line += ' ' + w;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.map(l => indent + l).join('\n');
}

/**
 * Human-readable report. Lives next to the data it renders so it can be
 * tested directly (the CLI only adds the JSON and exit-code wrapping).
 */
export function formatDoctorReport(report: DoctorReport): string {
  const out: string[] = [];
  out.push(bold('MigratePR doctor — LLM discovery') + '\n');

  out.push(bold('Local runtimes'));
  if (report.reachable.length === 0 && report.installedButStopped.length === 0) {
    out.push(
      dim(
        '  – none found (probed Ollama, LM Studio, Jan, llama.cpp, vLLM, LocalAI,\n' +
          '    GPT4All, KoboldCpp, text-generation-webui)',
      ),
    );
  }
  for (const r of report.reachable) {
    const models = r.models.length > 0 ? `${r.models.length} model(s)` : 'no models pulled';
    const model = r.model ? ` · using ${r.model}` : '';
    out.push(`  ${green('✔')} ${r.runtime.name.padEnd(22)} ${dim(r.baseUrl)}  ${models}${model}`);
  }
  for (const s of report.installedButStopped) {
    out.push(`  ${yellow('!')} ${s.name.padEnd(22)} ${dim('installed but not running')}`);
  }

  out.push('\n' + bold('Cloud API keys in this environment'));
  if (report.cloudKeys.length === 0) out.push(dim('  – none found'));
  for (const k of report.cloudKeys) {
    out.push(`  ${green('✔')} ${k.displayName} ${dim(`(${k.envVar})`)}`);
  }

  out.push('\n' + bold('Effective provider'));
  if (report.effective) {
    const model = report.effective.model ? ` · ${report.effective.model}` : '';
    out.push(`  ${green(report.effective.provider)}${model} ${dim(`— ${report.effective.source}`)}`);
    if (report.savedTo) out.push(dim(`  saved as the default: ${report.savedTo}`));
    out.push(dim('\nNext:  migratepr --repo path/to/repo'));
  } else {
    out.push(`  ${yellow('none')} ${dim('— deterministic rules engine only')}`);
    out.push(dim('  most migrations are mechanical and need no LLM at all — try it now:'));
    out.push(`  ${cyan('migratepr --repo path/to/repo')}`);
  }

  if (report.recommendations.length > 0) {
    out.push('\n' + bold('Options — any ONE of these is enough:\n'));
    report.recommendations.forEach((rec, idx) => {
      const flag = rec.optional ? dim('   ← recommended to start') : '';
      out.push(`  ${bold(`${idx + 1}. ${rec.title}`)}${flag}`);
      out.push(wrapText(rec.why, 74, '     '));
      for (const s of rec.steps) out.push(`     ${cyan('→')} ${s}`);
      if (rec.url) out.push(`     ${dim(rec.url)}`);
      out.push('');
    });
  }

  return out.join('\n');
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const dataDir = opts.dataDir ?? coreDataDir();
  const platform = opts.platform ?? process.platform;

  const discovery = opts.discovery ?? (await discoverLocalRuntimes());
  const cloudKeys = opts.keys ?? discoverCloudKeys();

  let saved = readDefaultProvider(dataDir);
  let savedTo: string | undefined;

  // 1. An explicit `--set-default <id>` wins.
  if (opts.setDefault) {
    const wanted = opts.setDefault.trim().toLowerCase();
    const hit = discovery.reachable.find(r => r.runtime.id === wanted);
    const knownNamed = PROVIDERS.some(p => p.id === wanted);
    if (!hit && !knownNamed) {
      const ids = [
        ...new Set([...PROVIDERS.map(p => p.id), ...discovery.reachable.map(r => r.runtime.id)]),
      ];
      throw new Error(
        `unknown provider '${opts.setDefault}' — use one of: ${ids.join(', ')}`,
      );
    }
    const savedAt = new Date().toISOString();
    // A detected runtime other than Ollama is reached through the generic
    // OpenAI-compatible provider, so persist it as 'custom' + baseUrl —
    // otherwise the saved id would name a provider the engine cannot build.
    const cfg: DefaultProviderConfig = hit
      ? hit.runtime.id === 'ollama'
        ? { provider: 'ollama', model: hit.model, detectedVia: 'ollama', savedAt }
        : {
            provider: 'custom',
            model: hit.model,
            baseUrl: hit.baseUrl,
            detectedVia: hit.runtime.id,
            savedAt,
          }
      : { provider: wanted, savedAt };
    if (opts.write !== false) savedTo = writeDefaultProvider(dataDir, cfg);
    saved = cfg;
  } else if (opts.write !== false && discovery.reachable.length > 0 && !cloudKeys.length) {
    // 2. Auto-configure: make the best detected runtime the default.
    const best = discovery.reachable[0];
    const isOllama = best.runtime.id === 'ollama';
    const cfg: DefaultProviderConfig = {
      // Ollama has a first-class adapter; anything else goes through the
      // generic OpenAI-compatible provider with an explicit base URL.
      provider: isOllama ? 'ollama' : 'custom',
      model: best.model,
      baseUrl: isOllama ? undefined : best.baseUrl,
      detectedVia: best.runtime.id,
      savedAt: new Date().toISOString(),
    };
    savedTo = writeDefaultProvider(dataDir, cfg);
    saved = cfg;
  }

  const effective = describeEffective(cloudKeys, saved, discovery.reachable);
  const recommendations = effective ? [] : buildRecommendations(platform);

  return {
    reachable: discovery.reachable,
    installedButStopped: discovery.installedButStopped,
    cloudKeys,
    effective,
    savedTo,
    recommendations,
  };
}
