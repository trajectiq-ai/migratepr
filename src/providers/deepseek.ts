import { OpenAiCompatibleProvider } from './openai-compatible';

/**
 * DeepSeek adapter (OpenAI-compatible). Activated when DEEPSEEK_API_KEY is set.
 * deepseek-coder is purpose-built for code rewrites.
 * Override the model with MIGRATEPR_DEEPSEEK_MODEL.
 */
export class DeepSeekProvider extends OpenAiCompatibleProvider {
  constructor() {
    super({
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com/chat/completions',
      apiKey: process.env.DEEPSEEK_API_KEY,
      defaultModel: 'deepseek-coder',
      modelEnvVar: 'MIGRATEPR_DEEPSEEK_MODEL',
    });
  }
}
