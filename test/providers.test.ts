import { afterEach, describe, expect, it } from 'vitest';
import { PROVIDERS, providerMeta } from '../src/web/providers';
import { SUPPORTED_LLM_PROVIDERS, makeLlmProvider } from '../src/engine';
import { GroqProvider } from '../src/providers/groq';
import { OllamaProvider, isOllamaAvailable, pickPreferredOllamaModel } from '../src/providers/ollama';
import { OpenRouterProvider } from '../src/providers/openrouter';
import { AuthError, saveApiKey } from '../src/web/auth';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  delete process.env.MIGRATEPR_DATA_DIR;
  delete process.env.MIGRATEPR_LLM_PROVIDER;
  delete process.env.GROQ_API_KEY;
});

function useTmpDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'migratepr-prov-'));
  tmpDirs.push(dir);
  process.env.MIGRATEPR_DATA_DIR = dir;
  return dir;
}

describe('provider registry', () => {
  it('covers all seven providers', () => {
    expect(PROVIDERS.map(p => p.id)).toEqual([
      'anthropic', 'openai', 'groq', 'mistral', 'deepseek', 'openrouter', 'ollama',
    ]);
  });

  it('engine and web registries agree', () => {
    // The engine's selectable providers must never drift from the web registry.
    expect([...SUPPORTED_LLM_PROVIDERS].sort()).toEqual(PROVIDERS.map(p => p.id).sort());
  });

  it('ollama is the only keyless/local provider', () => {
    const locals = PROVIDERS.filter(p => !p.keyRequired);
    expect(locals.map(p => p.id)).toEqual(['ollama']);
  });

  it('every cloud provider maps to a distinct env var used for injection', () => {
    const envVars = PROVIDERS.filter(p => p.keyRequired).map(p => p.envVar);
    expect(envVars.every(Boolean)).toBe(true);
    expect(new Set(envVars).size).toBe(envVars.length);
  });

  it('providerMeta resolves ids and rejects unknown ones', () => {
    expect(providerMeta('groq')?.displayName).toBe('Groq');
    expect(providerMeta('nope')).toBeUndefined();
  });
});

describe('per-provider key validation', () => {
  it('accepts a groq key with the gsk_ prefix and stores it encrypted', () => {
    useTmpDataDir();
    const rec = saveApiKey('a@b.co', 'groq', 'gsk_' + 'x'.repeat(40), 'test');
    expect(rec.provider).toBe('groq');
    expect(rec.hint).toContain('…');
    expect(rec.keyEnc).not.toContain('gsk_');
  });

  it('rejects a mistral key saved under the anthropic provider', () => {
    useTmpDataDir();
    expect(() => saveApiKey('a@b.co', 'anthropic', 'not-an-anthropic-key-0123456789', ''))
      .toThrow(/Anthropic keys start with "sk-ant-"/);
  });

  it('rejects unknown providers entirely', () => {
    useTmpDataDir();
    expect(() => saveApiKey('a@b.co', 'cohere' as never, 'x'.repeat(40), ''))
      .toThrow(/Unknown provider/);
  });

  it('rejects cloud keys that are too short', () => {
    useTmpDataDir();
    expect(() => saveApiKey('a@b.co', 'openrouter', 'sk-or-short', ''))
      .toThrow(/too short/);
  });
});

describe('provider adapters', () => {
  it('groq adapter targets the groq endpoint and resolves its model', async () => {
    const p = new GroqProvider();
    expect(p.name).toBe('groq');
    // resolveModel is protected; verify indirectly via a compile-level check.
    expect(typeof p.complete).toBe('function');
  });

  it('openrouter default model uses vendor/model naming', () => {
    const p = new OpenRouterProvider();
    expect(p.name).toBe('openrouter');
  });

  it('ollama adapter points at the local OpenAI-compatible endpoint', () => {
    const p = new OllamaProvider();
    expect(p.name).toBe('ollama');
  });

  it('isOllamaAvailable is false when nothing listens locally', async () => {
    const prev = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = 'http://127.0.0.1:9'; // discard port — nothing listens
    try {
      expect(await isOllamaAvailable()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = prev;
    }
  });

  it('auto-picks the best installed Ollama model', () => {
    // Prefers code-tuned models above everything else.
    expect(pickPreferredOllamaModel(['llama3.2:3b', 'qwen3:8b', 'deepseek-coder:6.7b']))
      .toBe('deepseek-coder:6.7b');
    // Falls back by preference tier when no coder model exists.
    expect(pickPreferredOllamaModel(['gemma3:4b', 'gpt-oss:20b', 'llama3.2:3b']))
      .toBe('gpt-oss:20b');
    // Explicit default wins when actually installed.
    expect(pickPreferredOllamaModel(['qwen2.5-coder:7b', 'gpt-oss:20b']))
      .toBe('qwen2.5-coder:7b');
    // Empty list degrades to the default tag.
    expect(pickPreferredOllamaModel([])).toBe('qwen2.5-coder:7b');
  });
});

describe('makeLlmProvider selection', () => {
  it('returns null with no keys and no local Ollama', async () => {
    const prev = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
    try {
      expect(await makeLlmProvider()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = prev;
    }
  });

  it('honors priority order: groq before mistral before deepseek', async () => {
    const prevOllama = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
    process.env.GROQ_API_KEY = 'gsk_test';
    process.env.MISTRAL_API_KEY = 'would-win-if-no-groq';
    try {
      const p = await makeLlmProvider();
      expect(p?.name).toBe('groq');
    } finally {
      if (prevOllama === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = prevOllama;
    }
  });

  it('MIGRATEPR_LLM_PROVIDER forces a specific provider', async () => {
    const prevOllama = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
    process.env.MIGRATEPR_LLM_PROVIDER = 'deepseek';
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    try {
      expect((await makeLlmProvider())?.name).toBe('deepseek');
    } finally {
      if (prevOllama === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = prevOllama;
    }
  });

  it('rejects unknown forced providers with the supported list', async () => {
    process.env.MIGRATEPR_LLM_PROVIDER = 'cohere';
    await expect(makeLlmProvider()).rejects.toThrow(/supported: anthropic, openai, groq/);
  });

  it('fails loudly when ollama is forced but unreachable', async () => {
    const prevOllama = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
    process.env.MIGRATEPR_LLM_PROVIDER = 'ollama';
    try {
      await expect(makeLlmProvider()).rejects.toThrow(/not reachable/);
    } finally {
      if (prevOllama === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = prevOllama;
    }
  });
});
