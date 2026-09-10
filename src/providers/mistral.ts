import { OpenAiCompatibleProvider } from './openai-compatible';

/**
 * Mistral adapter (OpenAI-compatible). Activated when MISTRAL_API_KEY is set.
 * Override the model with MIGRATEPR_MISTRAL_MODEL.
 */
export class MistralProvider extends OpenAiCompatibleProvider {
  constructor() {
    super({
      name: 'mistral',
      baseUrl: 'https://api.mistral.ai/v1/chat/completions',
      apiKey: process.env.MISTRAL_API_KEY,
      defaultModel: 'mistral-large-latest',
      modelEnvVar: 'MIGRATEPR_MISTRAL_MODEL',
    });
  }
}
