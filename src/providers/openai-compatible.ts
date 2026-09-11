import { LlmProvider } from '../types';
import { fetchWithRetry } from './http';

/**
 * Shared adapter for every OpenAI-compatible chat-completions endpoint:
 * OpenAI, Groq, Mistral, DeepSeek, OpenRouter, and local Ollama.
 * Subclasses only supply defaults; behavior is configured via options so a
 * single class covers all of them.
 */

export interface OpenAiCompatibleOptions {
  /** Provider identifier (used in logs and rewrite annotations). */
  name: string;
  /** Chat-completions endpoint, e.g. https://api.groq.com/openai/v1/chat/completions */
  baseUrl: string;
  /** Bearer-token API key, if the provider requires one. */
  apiKey?: string;
  /** Fallback model when MIGRATEPR_<NAME>_MODEL is not set. */
  defaultModel: string;
  /** Env var that overrides the model, e.g. MIGRATEPR_GROQ_MODEL. */
  modelEnvVar?: string;
  /** Extra JSON body fields (e.g. Ollama options). */
  extraBody?: Record<string, unknown>;
  /** Request timeout — local runtimes can be slow to first token. */
  timeoutMs?: number;
  /** Retries for 429/5xx/network. Ollama has no rate limits; default 3. */
  attempts?: number;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  protected readonly opts: OpenAiCompatibleOptions;
  /** Subclasses that auto-pick a model set this before their first request. */
  protected resolvedModel: string | null = null;

  constructor(opts: OpenAiCompatibleOptions) {
    this.name = opts.name;
    this.opts = opts;
  }

  async complete(system: string, prompt: string): Promise<string> {
    const model = this.resolveModel();
    const res = await fetchWithRetry(
      this.opts.baseUrl,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          ...this.opts.extraBody,
        }),
      },
      {
        // Global override for slow local runtimes (rulegen on CPU-bound Ollama).
        timeoutMs: Number(process.env.MIGRATEPR_LLM_TIMEOUT_MS) || (this.opts.timeoutMs ?? 120_000),
        attempts: this.opts.attempts ?? 3,
      },
    );
    if (!res.ok) {
      const host = new URL(this.opts.baseUrl).host;
      throw new Error(`${host} API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return (data.choices?.[0]?.message?.content ?? '').trim();
  }

  protected resolveModel(): string {
    if (this.resolvedModel) return this.resolvedModel;
    const env = this.opts.modelEnvVar ? process.env[this.opts.modelEnvVar] : undefined;
    return env || this.opts.defaultModel;
  }
}
