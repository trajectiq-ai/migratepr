import { OpenAiCompatibleProvider } from './openai-compatible';

/**
 * Groq adapter (OpenAI-compatible). Activated when GROQ_API_KEY is set.
 * Default model is Llama 3.3 70B — fast and capable at code rewrites.
 * Override the model with MIGRATEPR_GROQ_MODEL.
 */
export class GroqProvider extends OpenAiCompatibleProvider {
  constructor() {
    super({
      name: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: process.env.GROQ_API_KEY,
      defaultModel: 'llama-3.3-70b-versatile',
      modelEnvVar: 'MIGRATEPR_GROQ_MODEL',
    });
  }
}
