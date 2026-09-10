/**
 * Single source of truth for the LLM providers MigratePR supports.
 * Used by key validation (auth), live key testing (keytester), job
 * credential injection (server), and served to the web UI via /api/providers
 * so the interface can never drift from the engine.
 */

/** Providers that can be selected when storing a key in the web app. */
export type KeyProvider =
  | 'anthropic'
  | 'openai'
  | 'groq'
  | 'mistral'
  | 'deepseek'
  | 'openrouter'
  | 'ollama';

export interface ProviderMeta {
  id: KeyProvider;
  displayName: string;
  /** Keys with a distinctive prefix are validated on save; undefined = free-form. */
  keyPrefix?: string;
  /** False only for Ollama — runs locally, no key exists. */
  keyRequired: boolean;
  placeholder: string;
  signupUrl?: string;
  /** Live-test endpoint used by "Test" in the key manager. */
  testUrl?: string;
  /** How the test endpoint authenticates. */
  testAuth: 'anthropic-header' | 'bearer' | 'none';
  /** Env var a migration job injects the decrypted key into. */
  envVar?: string;
  /** Local runtimes (Ollama) need no credential injection at all. */
  local?: boolean;
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    keyPrefix: 'sk-ant-',
    keyRequired: true,
    placeholder: 'sk-ant-api03-…',
    signupUrl: 'https://console.anthropic.com/settings/keys',
    testUrl: 'https://api.anthropic.com/v1/models?limit=1',
    testAuth: 'anthropic-header',
    envVar: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    keyPrefix: 'sk-',
    keyRequired: true,
    placeholder: 'sk-proj-…',
    signupUrl: 'https://platform.openai.com/api-keys',
    testUrl: 'https://api.openai.com/v1/models?limit=1',
    testAuth: 'bearer',
    envVar: 'OPENAI_API_KEY',
  },
  {
    id: 'groq',
    displayName: 'Groq',
    keyPrefix: 'gsk_',
    keyRequired: true,
    placeholder: 'gsk_…',
    signupUrl: 'https://console.groq.com/keys',
    testUrl: 'https://api.groq.com/openai/v1/models',
    testAuth: 'bearer',
    envVar: 'GROQ_API_KEY',
  },
  {
    id: 'mistral',
    displayName: 'Mistral AI',
    keyRequired: true,
    placeholder: 'Mistral platform key',
    signupUrl: 'https://console.mistral.ai/api-keys',
    testUrl: 'https://api.mistral.ai/v1/models',
    testAuth: 'bearer',
    envVar: 'MISTRAL_API_KEY',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    keyRequired: true,
    placeholder: 'DeepSeek platform key',
    signupUrl: 'https://platform.deepseek.com/api_keys',
    testUrl: 'https://api.deepseek.com/models',
    testAuth: 'bearer',
    envVar: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    keyPrefix: 'sk-or-',
    keyRequired: true,
    placeholder: 'sk-or-… (one key, hundreds of models)',
    signupUrl: 'https://openrouter.ai/keys',
    testUrl: 'https://openrouter.ai/api/v1/models',
    testAuth: 'bearer',
    envVar: 'OPENROUTER_API_KEY',
  },
  {
    id: 'ollama',
    displayName: 'Ollama (local)',
    keyRequired: false,
    placeholder: 'no key needed — runs on your machine',
    testAuth: 'none',
    local: true,
  },
];

export function providerMeta(id: string): ProviderMeta | undefined {
  return PROVIDERS.find(p => p.id === id);
}
