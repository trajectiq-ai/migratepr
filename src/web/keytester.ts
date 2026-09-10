import { getDecryptedApiKey, KeyProvider, updateApiKeyStatus } from './auth';

/**
 * Live validation of a stored API key: one minimal, cheapest-possible request
 * to the provider. Updates lastStatus and returns a user-facing summary.
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

export async function testApiKey(
  email: string,
  keyId: string,
): Promise<TestOutcome & { hint?: string }> {
  const { listApiKeys } = await import('./auth');
  const rec = listApiKeys(email).find(k => k.id === keyId);
  if (!rec) return { ok: false, message: 'Key not found' };
  const raw = getDecryptedApiKey(email, keyId);
  if (!raw) return { ok: false, message: 'Key not found' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    let outcome: TestOutcome;
    if (rec.provider === 'anthropic') {
      const { status, body } = await fetchJson('https://api.anthropic.com/v1/models?limit=1', {
        headers: {
          'x-api-key': raw,
          'anthropic-version': '2023-06-01',
        },
        signal: controller.signal,
      });
      outcome =
        status === 200
          ? { ok: true, message: 'Key is valid — Anthropic accepted it' }
          : { ok: false, message: providerErrorMessage(status, body) };
    } else {
      const { status, body } = await fetchJson('https://api.openai.com/v1/models?limit=1', {
        headers: { Authorization: `Bearer ${raw}` },
        signal: controller.signal,
      });
      const list = body as { data?: Array<{ id?: string }> } | null;
      outcome =
        status === 200
          ? { ok: true, message: 'Key is valid — OpenAI accepted it', model: list?.data?.[0]?.id }
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
