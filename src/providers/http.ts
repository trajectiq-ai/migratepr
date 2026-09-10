/** Shared HTTP helper for LLM providers: timeout + exponential backoff. */

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function backoffMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

/**
 * fetch with a per-attempt timeout and retry on network errors, 429, and 5xx.
 * Client errors (4xx except 429) return immediately — retrying cannot help.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { attempts?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if ((res.status >= 500 || res.status === 429) && attempt < attempts) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(backoffMs(attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
