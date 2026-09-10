import { OpenAiCompatibleProvider } from './openai-compatible';

/**
 * Ollama adapter (OpenAI-compatible) — fully local, no API key, no network
 * egress beyond your machine. Activated when a local Ollama server is
 * reachable (default http://127.0.0.1:11434).
 *
 * Override with:
 *   OLLAMA_HOST             base URL (default http://127.0.0.1:11434)
 *   MIGRATEPR_OLLAMA_MODEL  exact model tag (skips auto-picking)
 *
 * Model auto-picking: if the preferred default tag is not installed, the
 * adapter queries the local model list and picks the best available one
 * (code-tuned models first). num_ctx is raised so whole-file rewrites fit
 * in context.
 */

export const OLLAMA_DEFAULT_MODEL = 'qwen2.5-coder:7b';

/** Preference order for auto-picking among installed local models. */
const MODEL_PREFERENCE: RegExp[] = [
  /coder|code[-_]/i, // code-tuned models are best at whole-file rewrites
  /^qwen[23]?[-:]?(3|2\.5)?[-:]?(8b|7b|14b|32b)/i,
  /^gpt-oss/i,
  /^mistral|mistral-small/i,
  /^llama/i,
  /^gemma/i,
];

/**
 * Pick the best installed model from an /api/tags listing.
 * Exported for testing; the network call lives in the adapter.
 */
export function pickPreferredOllamaModel(installed: string[]): string {
  if (installed.length === 0) return OLLAMA_DEFAULT_MODEL;
  if (installed.includes(OLLAMA_DEFAULT_MODEL)) return OLLAMA_DEFAULT_MODEL;
  for (const re of MODEL_PREFERENCE) {
    const hit = installed.find(name => re.test(name));
    if (hit) return hit;
  }
  return installed[0];
}

export class OllamaProvider extends OpenAiCompatibleProvider {
  private modelResolved = false;

  constructor() {
    const host = (process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    super({
      name: 'ollama',
      baseUrl: `${host}/v1/chat/completions`,
      apiKey: process.env.OLLAMA_API_KEY, // optional — Ollama itself needs none
      defaultModel: OLLAMA_DEFAULT_MODEL,
      modelEnvVar: 'MIGRATEPR_OLLAMA_MODEL',
      extraBody: { options: { temperature: 0, num_ctx: 16384 } },
      timeoutMs: 300_000, // local hardware can be slow on first model load
      attempts: 1, // no rate limits locally; retrying a half-loaded model just adds delay
    });
  }

  async complete(system: string, prompt: string): Promise<string> {
    if (!this.modelResolved) {
      this.resolvedModel = await this.pickInstalledModel();
      this.modelResolved = true;
    }
    return super.complete(system, prompt);
  }

  /** Explicit override wins; otherwise prefer the default, then best installed. */
  private async pickInstalledModel(): Promise<string | null> {
    if (process.env.MIGRATEPR_OLLAMA_MODEL) return null; // base class uses it
    const host = (process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${host}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const body = (await res.json()) as { models?: Array<{ name?: string }> };
      const installed = (body.models ?? []).map(m => m.name ?? '').filter(Boolean);
      return pickPreferredOllamaModel(installed);
    } catch {
      return null; // fall back to the default tag; the request will report the error
    }
  }
}

/** True if a local (or remote) Ollama server answers its version endpoint. */
export async function isOllamaAvailable(host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${host.replace(/\/+$/, '')}/api/version`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}
