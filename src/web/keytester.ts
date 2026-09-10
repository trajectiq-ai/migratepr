import { getDecryptedApiKey, updateApiKeyStatus } from './auth';
import { PROVIDERS, providerMeta } from './providers';
import { pickPreferredOllamaModel } from '../providers/ollama';

/**
 * Live validation of a stored API key: one minimal, cheapest-possible request
 * to the provider. Updates lastStatus and returns a user-facing summary.
 * Metadata-driven — adding a provider to providers.ts is all it takes.
 */

const PROVIDER_TIMEOUT_MS = 15_000;

interface TestOutcome {
  ok: boolean;
  message: string;
  model?: string;
}

async function fetchJson(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function providerErrorMessage(status: number, body: unknown): string {
  const rec = body as { error?: { message?: string } | string } | null;
  const detail =
    typeof rec?.error === 'string' ? rec.error : typeof rec?.error?.message === 'string' ? rec.error.message : '';
  if (status === 401) return 'Invalid API key (authentication failed)';
  if (status === 403) return 'Key is valid but lacks permission for this request';
  if (status === 429) return 'Key is valid but rate-limited right now';
  return detail || `Provider returned HTTP ${status}`;
}

function authHeadersFor(testAuth: string, raw: string): Record<string, string> {
  if (testAuth === 'anthropic-header') {
    return { 'x-api-key': raw, 'anthropic-version': '2023-06-01' };
  }
  if (testAuth === 'bearer') return { Authorization: `Bearer ${raw}` };
  return {};
}

export async function testApiKey(
  email: string,
  keyId: string,
): Promise<TestOutcome & { hint?: string }> {
  const { listApiKeys } = await import('./auth');
  const rec = listApiKeys(email).find(k => k.id === keyId);
  if (!rec) return { ok: false, message: 'Key not found' };
  const raw = getDecryptedApiKey(email, keyId);
  if (!raw) return { ok: false, message: 'Key not found' };

  const meta = providerMeta(rec.provider);
  if (!meta) return { ok: false, message: `Unknown provider '${rec.provider}'`, hint: rec.hint };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    let outcome: TestOutcome;

    if (!meta.testUrl) {
      // Local runtimes (Ollama): "testing" means checking the server is up.
      const host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
      try {
        const { status, body } = await fetchJson(`${host.replace(/\/+$/, '')}/api/tags`, {
          signal: controller.signal,
        });
        const models = (body as { models?: Array<{ name?: string }> } | null)?.models ?? [];
        const names = models.map(m => m.name ?? '').filter(Boolean);
        outcome =
          status === 200
            ? {
                ok: names.length > 0,
                message: names.length
                  ? `Ollama is running at ${host} — ${names.length} model(s) installed; engine will use ${pickPreferredOllamaModel(names)}`
                  : `Ollama is running at ${host} — but no models are installed yet (run: ollama pull qwen2.5-coder:7b)`,
                model: names.length ? pickPreferredOllamaModel(names) : undefined,
              }
            : { ok: false, message: `Ollama responded with HTTP ${status}` };
      } catch (err) {
        outcome = {
          ok: false,
          message:
            (err as Error).name === 'AbortError'
              ? `Ollama did not respond in 15s — is "ollama serve" running at ${host}?`
              : `Ollama is not reachable at ${host} — start it with "ollama serve"`,
        };
      }
    } else {
      const { status, body } = await fetchJson(meta.testUrl, {
        headers: authHeadersFor(meta.testAuth, raw),
        signal: controller.signal,
      });
      const list = body as { data?: Array<{ id?: string }>; models?: Array<{ id?: string; name?: string }> } | null;
      const model = list?.data?.[0]?.id ?? list?.models?.[0]?.id ?? list?.models?.[0]?.name;
      outcome =
        status === 200
          ? { ok: true, message: `Key is valid — ${meta.displayName} accepted it`, model }
          : { ok: false, message: providerErrorMessage(status, body) };
    }
    updateApiKeyStatus(email, keyId, outcome.ok ? 'valid' : 'invalid');
    return { ...outcome, hint: rec.hint };
  } catch (err) {
    const msg = (err as Error).name === 'AbortError' ? 'Provider did not respond in 15s — try again' : `Network error: ${(err as Error).message}`;
    return { ok: false, message: msg, hint: rec.hint };
  } finally {
    clearTimeout(timer);
  }
}

/** Kept for potential reuse; lists providers that accept stored keys. */
export const TESTABLE_PROVIDERS = PROVIDERS.filter(p => p.keyRequired).map(p => p.id);
