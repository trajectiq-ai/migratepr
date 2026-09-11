import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCAL_RUNTIMES,
  buildRecommendations,
  clearDefaultProvider,
  commandExists,
  defaultConfigPath,
  discoverCloudKeys,
  formatDoctorReport,
  parseDefaultConfig,
  pickModel,
  probeRuntime,
  readDefaultProvider,
  runDoctor,
  writeDefaultProvider,
  DoctorReport,
} from '../src/doctor';

const ollamaSpec = LOCAL_RUNTIMES.find(r => r.id === 'ollama')!;
const lmstudioSpec = LOCAL_RUNTIMES.find(r => r.id === 'lmstudio')!;

let tmp: string;

/** Keys that would make discovery non-deterministic. */
const PROVIDER_ENV = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'MIGRATEPR_LLM_PROVIDER',
  'MIGRATEPR_BASE_URL',
  'MIGRATEPR_MODEL',
  'MIGRATEPR_OLLAMA_MODEL',
];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migratepr-doctor-'));
  for (const k of PROVIDER_ENV) delete process.env[k];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ------------------------------ test http server ------------------------------ */

interface Served {
  url: string;
  close: () => Promise<void>;
}

function startServer(handler: http.RequestListener): Promise<Served> {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => server.close(() => r())),
      });
    });
  });
}

/** Serve an OpenAI-compatible /models listing. */
function startOpenAiLike(ids: string[]): Promise<Served> {
  return startServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: ids.map(id => ({ id, object: 'model' })) }));
      return;
    }
    res.writeHead(404).end('{}');
  });
}

/** Serve Ollama's native /api/tags listing. */
function startOllamaLike(names: string[]): Promise<Served> {
  return startServer((req, res) => {
    if (req.url?.startsWith('/api/tags')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: names.map(name => ({ name, model: name })) }));
      return;
    }
    res.writeHead(404).end('{}');
  });
}

/* --------------------------------- probing --------------------------------- */

describe('runtime probing', () => {
  let served: Served;
  afterEach(async () => {
    if (served) await served.close();
  });

  it('detects an OpenAI-compatible runtime via /v1/models', async () => {
    served = await startOpenAiLike(['llama-3.2-3b', 'qwen2.5-coder-7b']);
    const hit = await probeRuntime(lmstudioSpec, { baseUrl: `${served.url}/v1` });
    expect(hit).not.toBeNull();
    expect(hit!.models).toEqual(['llama-3.2-3b', 'qwen2.5-coder-7b']);
    // code-tuned model preferred for whole-file rewrites
    expect(hit!.model).toBe('qwen2.5-coder-7b');
  });

  it('detects Ollama through its native /api/tags endpoint', async () => {
    served = await startOllamaLike(['qwen3:8b', 'llama3.2:3b']);
    const hit = await probeRuntime(ollamaSpec, { baseUrl: `${served.url}/v1` });
    expect(hit).not.toBeNull();
    expect(hit!.models).toEqual(['qwen3:8b', 'llama3.2:3b']);
    expect(hit!.model).toBe('qwen3:8b');
  });

  it('returns null when nothing is listening', async () => {
    // Port 1 is reserved and never serves HTTP.
    const hit = await probeRuntime(lmstudioSpec, { baseUrl: 'http://127.0.0.1:1/v1' });
    expect(hit).toBeNull();
  });

  it('picks the first model when none is code-tuned', () => {
    expect(pickModel(['llama3.2:3b', 'gemma3:4b'])).toBe('llama3.2:3b');
    expect(pickModel([])).toBeUndefined();
    expect(pickModel(['llama3.2', 'qwen2.5-coder'])).toBe('qwen2.5-coder');
  });

  it('detects an installed binary without throwing', () => {
    expect(commandExists('node')).toBe(true);
    expect(commandExists('definitely-not-a-real-binary-xyz')).toBe(false);
  });
});

/* ------------------------------- persistence ------------------------------- */

describe('saved default provider', () => {
  it('round-trips through the data dir', () => {
    const file = writeDefaultProvider(tmp, {
      provider: 'ollama',
      model: 'qwen3:8b',
      detectedVia: 'ollama',
    });
    expect(file).toBe(defaultConfigPath(tmp));
    const back = readDefaultProvider(tmp);
    expect(back).toEqual({ provider: 'ollama', model: 'qwen3:8b', detectedVia: 'ollama' });
    expect(clearDefaultProvider(tmp)).toBe(true);
    expect(readDefaultProvider(tmp)).toBeNull();
    expect(clearDefaultProvider(tmp)).toBe(false);
  });

  it('ignores a malformed or unusable file instead of failing', () => {
    fs.writeFileSync(defaultConfigPath(tmp), '{ not json', 'utf8');
    expect(readDefaultProvider(tmp)).toBeNull();

    expect(parseDefaultConfig(null)).toBeNull();
    expect(parseDefaultConfig({})).toBeNull();
    expect(parseDefaultConfig({ provider: '   ' })).toBeNull();
    // A custom endpoint without a base URL can never work.
    expect(parseDefaultConfig({ provider: 'custom' })).toBeNull();
    expect(parseDefaultConfig({ provider: 'custom', baseUrl: '' })).toBeNull();
    expect(parseDefaultConfig({ provider: 'groq' })).toEqual({ provider: 'groq' });
  });

  it('finds cloud keys already present in the environment', () => {
    expect(discoverCloudKeys({})).toEqual([]);
    const found = discoverCloudKeys({ GROQ_API_KEY: 'gsk_x', OPENROUTER_API_KEY: 'sk-or-x' });
    expect(found.map(k => k.id)).toEqual(['groq', 'openrouter']);
    expect(found[0].envVar).toBe('GROQ_API_KEY');
    expect(found[0].signupUrl).toContain('groq.com');
  });
});

/* --------------------------------- doctor --------------------------------- */

const noKeys: never[] = [];
const noStopped = { installedButStopped: [] };

describe('runDoctor', () => {
  it('saves a detected Ollama as the default provider', async () => {
    const report = await runDoctor({
      dataDir: tmp,
      discovery: {
        reachable: [{ runtime: ollamaSpec, baseUrl: ollamaSpec.baseUrl, models: ['qwen3:8b'], model: 'qwen3:8b' }],
        ...noStopped,
      },
      keys: noKeys,
    });
    // Ollama has a first-class adapter, so no base URL needs persisting.
    expect(report.effective).toMatchObject({
      provider: 'ollama',
      model: 'qwen3:8b',
      source: 'saved default (detected ollama)',
    });
    expect(report.effective?.baseUrl).toBeUndefined();
    expect(report.savedTo).toBe(defaultConfigPath(tmp));
    expect(readDefaultProvider(tmp)).toMatchObject({ provider: 'ollama', model: 'qwen3:8b' });
    expect(report.recommendations).toEqual([]);
  });

  it('routes a non-Ollama runtime through the generic endpoint', async () => {
    await runDoctor({
      dataDir: tmp,
      discovery: {
        reachable: [{ runtime: lmstudioSpec, baseUrl: 'http://127.0.0.1:1234/v1', models: ['qwen2.5-coder-7b'], model: 'qwen2.5-coder-7b' }],
        ...noStopped,
      },
      keys: noKeys,
    });
    expect(readDefaultProvider(tmp)).toEqual({
      provider: 'custom',
      model: 'qwen2.5-coder-7b',
      baseUrl: 'http://127.0.0.1:1234/v1',
      detectedVia: 'lmstudio',
      savedAt: expect.any(String),
    });
  });

  it('does not overwrite an environment key but still reports both', async () => {
    const report = await runDoctor({
      dataDir: tmp,
      discovery: {
        reachable: [{ runtime: ollamaSpec, baseUrl: ollamaSpec.baseUrl, models: ['qwen3:8b'], model: 'qwen3:8b' }],
        ...noStopped,
      },
      keys: [{ id: 'groq', displayName: 'Groq', envVar: 'GROQ_API_KEY' }],
    });
    expect(report.effective).toEqual({ provider: 'groq', source: 'environment (GROQ_API_KEY)' });
    expect(report.savedTo).toBeUndefined();
    expect(readDefaultProvider(tmp)).toBeNull();
  });

  it('honours --set-default and --no-write', async () => {
    const forced = await runDoctor({
      dataDir: tmp,
      setDefault: 'lmstudio',
      discovery: {
        reachable: [{ runtime: lmstudioSpec, baseUrl: 'http://127.0.0.1:1234/v1', models: ['m'], model: 'm' }],
        ...noStopped,
      },
      keys: noKeys,
    });
    expect(forced.effective?.provider).toBe('custom');
    expect(readDefaultProvider(tmp)).toMatchObject({
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:1234/v1',
      detectedVia: 'lmstudio',
    });

    clearDefaultProvider(tmp);
    await runDoctor({
      dataDir: tmp,
      write: false,
      discovery: {
        reachable: [{ runtime: ollamaSpec, baseUrl: ollamaSpec.baseUrl, models: ['qwen3:8b'], model: 'qwen3:8b' }],
        ...noStopped,
      },
      keys: noKeys,
    });
    expect(readDefaultProvider(tmp)).toBeNull();
  });

  it('rejects an unknown --set-default instead of saving a dead default', async () => {
    await expect(
      runDoctor({
        dataDir: tmp,
        setDefault: 'not-a-provider',
        discovery: { reachable: [], installedButStopped: [] },
        keys: noKeys,
      }),
    ).rejects.toThrow(/unknown provider 'not-a-provider'/);
    expect(readDefaultProvider(tmp)).toBeNull();
  });

  it('recommends free options when nothing is available', async () => {
    const report = await runDoctor({
      dataDir: tmp,
      discovery: { reachable: [], installedButStopped: [] },
      keys: noKeys,
    });
    expect(report.effective).toBeNull();
    expect(report.recommendations[0].id).toBe('none-needed');
    expect(report.recommendations[0].optional).toBe(true);
    expect(report.recommendations.map(r => r.id)).toEqual([
      'none-needed',
      'groq',
      'openrouter',
      'ollama',
      'any-endpoint',
    ]);
    // Every option must be actionable.
    for (const rec of report.recommendations) expect(rec.steps.length).toBeGreaterThan(0);
  });

  it('respects a saved default when discovery later finds nothing', async () => {
    writeDefaultProvider(tmp, { provider: 'custom', baseUrl: 'http://127.0.0.1:9000/v1', model: 'm' });
    const report = await runDoctor({
      dataDir: tmp,
      write: false,
      discovery: { reachable: [], installedButStopped: [] },
      keys: noKeys,
    });
    expect(report.effective).toMatchObject({ provider: 'custom', model: 'm' });
  });
});

/* ------------------------------ presentation ------------------------------ */

describe('recommendations and formatting', () => {
  it('uses OS-appropriate install commands', () => {
    const win = buildRecommendations('win32');
    const mac = buildRecommendations('darwin');
    const linux = buildRecommendations('linux');
    const ollamaOf = (rs: ReturnType<typeof buildRecommendations>) => rs.find(r => r.id === 'ollama')!;

    expect(ollamaOf(win).steps[0]).toContain('winget install Ollama.Ollama');
    expect(ollamaOf(mac).steps[0]).toContain('brew install ollama');
    expect(ollamaOf(linux).steps[0]).toContain('curl -fsSL https://ollama.com/install.sh');

    // Windows gets setx, POSIX gets export.
    expect(win.find(r => r.id === 'groq')!.steps.some(s => s.includes('setx GROQ_API_KEY'))).toBe(true);
    expect(linux.find(r => r.id === 'groq')!.steps.some(s => s.includes('export GROQ_API_KEY'))).toBe(true);
  });

  it('renders the no-LLM report with the rules-engine option first', () => {
    const report: DoctorReport = {
      reachable: [],
      installedButStopped: [],
      cloudKeys: [],
      effective: null,
      recommendations: buildRecommendations('linux'),
    };
    const text = formatDoctorReport(report);
    expect(text).toContain('none');
    expect(text).toContain('deterministic rules engine only');
    expect(text).toContain('1. Start here: do nothing (no LLM required)');
    expect(text).toContain('Ollama — free, fully local');
  });

  it('renders a found runtime with the model and saved path', () => {
    const report: DoctorReport = {
      reachable: [{ runtime: ollamaSpec, baseUrl: 'http://127.0.0.1:11434/v1', models: ['a', 'b'], model: 'qwen3:8b' }],
      installedButStopped: [],
      cloudKeys: [],
      effective: { provider: 'ollama', model: 'qwen3:8b', source: 'saved default (detected ollama)' },
      savedTo: path.join(tmp, 'llm.json'),
      recommendations: [],
    };
    const text = formatDoctorReport(report);
    expect(text).toContain('2 model(s)');
    expect(text).toContain('using qwen3:8b');
    expect(text).toContain('saved as the default');
    expect(text).not.toContain('Options — any ONE');
  });
});
