import { afterEach, describe, expect, it } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import {
  DEFAULT_PULL_MODEL,
  SMALL_PULL_MODEL,
  OllamaUnavailableError,
  formatBytes,
  formatMissingOllama,
  formatModelList,
  formatPullProgress,
  installHint,
  isInstalled,
  listLocalModels,
  ollamaHost,
  pullCommandFor,
  pullModel,
  preferredLocalModel,
} from '../src/model';
import { pickPreferredOllamaModel } from '../src/providers/ollama';
import { buildRecommendations } from '../src/doctor';

/* ------------------------------ test harness ------------------------------- */

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))),
  );
});

/** A fake Ollama: routes /api/tags and /api/pull however the test needs. */
async function fakeOllama(handler: (path: string, res: import('http').ServerResponse) => void): Promise<string> {
  const server = createServer((req, res) => handler(req.url ?? '/', res));
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** A port nothing is listening on (the "Ollama not running" case). */
async function deadHost(): Promise<string> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/* --------------------------------- listing --------------------------------- */

describe('listLocalModels', () => {
  it('returns installed models, sorted, with sizes', async () => {
    const host = await fakeOllama((path, res) => {
      expect(path).toBe('/api/tags');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          models: [
            { name: 'qwen2.5-coder:7b', size: 4_700_000_000 },
            { name: 'llama3.2:3b', size: 2_000_000_000 },
          ],
        }),
      );
    });

    const models = await listLocalModels({ host });
    expect(models.map(m => m.name)).toEqual(['llama3.2:3b', 'qwen2.5-coder:7b']);
    expect(models[1].sizeBytes).toBe(4_700_000_000);
  });

  it('accepts the older `model` field as well as `name`', async () => {
    const host = await fakeOllama((_p, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ models: [{ model: 'gemma3:4b', size: 3_300_000_000 }] }));
    });
    expect((await listLocalModels({ host })).map(m => m.name)).toEqual(['gemma3:4b']);
  });

  it('throws a friendly error when nothing is listening', async () => {
    const host = await deadHost();
    await expect(listLocalModels({ host, timeoutMs: 2000 })).rejects.toBeInstanceOf(
      OllamaUnavailableError,
    );
    await expect(listLocalModels({ host, timeoutMs: 2000 })).rejects.toThrow(/ollama serve/);
  });

  it('treats a non-OK response as unavailable', async () => {
    const host = await fakeOllama((_p, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    await expect(listLocalModels({ host })).rejects.toBeInstanceOf(OllamaUnavailableError);
  });
});

describe('isInstalled', () => {
  const models = [{ name: 'qwen2.5-coder:7b' }, { name: 'llama3.2:latest' }];

  it('matches exact tags', () => {
    expect(isInstalled(models, 'qwen2.5-coder:7b')).toBe(true);
  });

  it('treats a bare name as :latest (Ollama semantics)', () => {
    expect(isInstalled(models, 'llama3.2')).toBe(true);
    expect(isInstalled(models, 'qwen2.5-coder')).toBe(false);
  });

  it('does not match a different tag of the same model', () => {
    expect(isInstalled(models, 'qwen2.5-coder:1.5b')).toBe(false);
    expect(isInstalled([], 'anything')).toBe(false);
  });
});

/* --------------------------------- pulling --------------------------------- */

describe('pullModel', () => {
  it('streams NDJSON progress, including across chunk boundaries', async () => {
    const host = await fakeOllama((path, res) => {
      expect(path).toBe('/api/pull');
      expect(res.req?.method).toBe('POST');
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      // Deliberately split a line in half: the parser must buffer it.
      res.write('{"status":"pulling manifest"}\n{"status":"downloading","total":1000,"completed":5');
      setTimeout(() => {
        res.write('00}\n{"status":"verifying sha256 digest"}\n{"status":"success"}\n');
        res.end();
      }, 10);
    });

    const seen: string[] = [];
    const result = await pullModel('qwen2.5-coder:7b', {
      host,
      onProgress: p => seen.push(formatPullProgress(p)),
    });

    expect(result.model).toBe('qwen2.5-coder:7b');
    expect(result.downloaded).toBe(true);
    expect(result.events.map(e => e.status)).toEqual([
      'pulling manifest',
      'downloading',
      'verifying sha256 digest',
      'success',
    ]);
    expect(result.events[1].percent).toBe(50);
    expect(seen).toContain('downloading 50% (500 B / 1000 B)');
  });

  it('surfaces an error reported inside a 200 stream', async () => {
    const host = await fakeOllama((_p, res) => {
      res.writeHead(200);
      res.write('{"status":"pulling manifest"}\n');
      res.end('{"error":"model \\"nope:1b\\" not found"}\n');
    });

    await expect(pullModel('nope:1b', { host })).rejects.toThrow(/not found/);
    await expect(pullModel('nope:1b', { host })).rejects.toThrow(/ollama\.com\/library/);
  });

  it("uses Ollama's own message from a 404 body", async () => {
    const host = await fakeOllama((_p, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'model "ghost:9b" not found' }));
    });
    await expect(pullModel('ghost:9b', { host })).rejects.toThrow(/ghost:9b/);
  });

  it('falls back to the HTTP status when the body is not JSON', async () => {
    const host = await fakeOllama((_p, res) => {
      res.writeHead(500);
      res.end('<html>gateway exploded</html>');
    });
    await expect(pullModel('anything', { host })).rejects.toThrow(/HTTP 500/);
  });

  it('reports an unreachable host as OllamaUnavailableError', async () => {
    const host = await deadHost();
    await expect(pullModel('qwen2.5-coder:7b', { host })).rejects.toBeInstanceOf(
      OllamaUnavailableError,
    );
  });

  it('ignores non-JSON noise on the stream', async () => {
    const host = await fakeOllama((_p, res) => {
      res.writeHead(200);
      res.end('not json\n{"status":"success"}\n');
    });
    const result = await pullModel('x', { host });
    expect(result.events.map(e => e.status)).toEqual(['success']);
  });
});

/* -------------------------------- formatting -------------------------------- */

describe('formatting', () => {
  it('formats byte sizes for humans', () => {
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(0)).toBe('');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(4_700_000_000)).toBe('4.4 GB');
  });

  it('formats progress with and without a total', () => {
    expect(formatPullProgress({ status: 'pulling manifest' })).toBe('pulling manifest');
    expect(formatPullProgress({ status: 'downloading', completed: 250, total: 1000, percent: 25 })).toBe(
      'downloading 25% (250 B / 1000 B)',
    );
  });

  it('lists models and marks the preferred one', () => {
    const text = formatModelList(
      [
        { name: 'llama3.2:3b', sizeBytes: 2_000_000_000 },
        { name: 'qwen2.5-coder:7b', sizeBytes: 4_700_000_000 },
      ],
      { host: 'http://127.0.0.1:11434', preferred: 'qwen2.5-coder:7b' },
    );
    expect(text).toContain('qwen2.5-coder:7b');
    expect(text).toContain('preferred by MigratePR');
    expect(text).toContain('llama3.2:3b');
  });

  it('tells you how to get a model when none are installed', () => {
    const text = formatModelList([], { host: 'http://127.0.0.1:11434' });
    expect(text).toContain('no models installed');
    expect(text).toContain('migratepr model pull');
  });

  it('gives an actionable message when Ollama is missing', () => {
    const text = formatMissingOllama('win32');
    expect(text).toContain('winget install Ollama.Ollama');
    expect(text).toContain('migratepr model pull');
    expect(text).toContain('rules engine needs no model');
  });
});

describe('ollamaHost / install hints / pull command', () => {
  it('normalizes trailing slashes and honors an override', () => {
    expect(ollamaHost('http://host:1234///')).toBe('http://host:1234');
  });

  it('prefers OLLAMA_HOST when no override is given', () => {
    const previous = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = 'http://other:9999/';
    try {
      expect(ollamaHost()).toBe('http://other:9999');
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = previous;
    }
  });

  it('gives a per-platform install command', () => {
    expect(installHint('win32').command).toContain('winget');
    expect(installHint('darwin').command).toContain('brew');
    expect(installHint('linux').command).toContain('ollama.com/install.sh');
    expect(installHint('linux').next).toBe(pullCommandFor());
  });

  it('omits the tag for the default model, includes it otherwise', () => {
    expect(pullCommandFor(DEFAULT_PULL_MODEL)).toBe('migratepr model pull');
    expect(pullCommandFor(SMALL_PULL_MODEL)).toBe(`migratepr model pull ${SMALL_PULL_MODEL}`);
  });
});

describe('preferredLocalModel', () => {
  const mixed = [{ name: 'gemma3:4b' }, { name: 'llama3.2:3b' }, { name: 'qwen3:8b' }];

  it('agrees exactly with the ranking the adapter uses at run time', () => {
    for (const models of [mixed, [{ name: 'llama3.2:3b' }], [{ name: 'qwen2.5-coder:7b' }]]) {
      expect(preferredLocalModel(models)).toBe(pickPreferredOllamaModel(models.map(m => m.name)));
    }
  });

  it('prefers a code-tuned model', () => {
    expect(preferredLocalModel([{ name: 'llama3.2:3b' }, { name: 'qwen2.5-coder:7b' }])).toBe(
      'qwen2.5-coder:7b',
    );
  });

  it('falls back to the pull default when nothing is installed', () => {
    expect(preferredLocalModel([])).toBe(DEFAULT_PULL_MODEL);
  });
});

/* --------------------------- doctor integration ---------------------------- */

describe('doctor recommendations', () => {
  it('points at `migratepr model pull` instead of raw ollama commands', () => {
    const ollama = buildRecommendations('linux').find(r => r.id === 'ollama');
    expect(ollama).toBeDefined();
    const steps = ollama!.steps.join('\n');
    expect(steps).toContain('migratepr model pull');
    expect(steps).toContain('migratepr model pull qwen2.5-coder:1.5b');
    expect(steps).not.toContain('ollama pull qwen2.5-coder:7b');
  });

  it('still leads with the zero-LLM option', () => {
    expect(buildRecommendations()[0].id).toBe('none-needed');
    expect(buildRecommendations()[0].optional).toBe(true);
  });

  it('tells an installed-but-stopped user to start it, not to install it', () => {
    const recs = buildRecommendations('win32', { ollamaInstalled: true });
    const ollama = recs.find(r => r.id === 'ollama')!;
    const steps = ollama.steps.join('\n');
    expect(steps).toContain('you already have it');
    expect(steps).not.toContain('winget install');
    // …and it is promoted: the shortest path should not be the fourth option.
    expect(recs[1].id).toBe('ollama');
    expect(recs).toHaveLength(5);
  });

  it('keeps install instructions when Ollama is absent', () => {
    const recs = buildRecommendations('win32', { ollamaInstalled: false });
    const ollama = recs.find(r => r.id === 'ollama')!;
    expect(ollama.steps.join('\n')).toContain('winget install Ollama.Ollama');
    expect(recs[1].id).toBe('groq');
  });
});
