import { OpenAiCompatibleProvider } from './openai-compatible';

/**
 * OpenRouter adapter (OpenAI-compatible) — one key, hundreds of models.
 * Activated when OPENROUTER_API_KEY is set. The default model string uses
 * OpenRouter's "vendor/model" naming; override with MIGRATEPR_OPENROUTER_MODEL.
 */
export class OpenRouterProvider extends OpenAiCompatibleProvider {
  constructor() {
    super({
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: process.env.OPENROUTER_API_KEY,
      defaultModel: 'anthropic/claude-sonnet-4.5',
      modelEnvVar: 'MIGRATEPR_OPENROUTER_MODEL',
    });
  }
}
