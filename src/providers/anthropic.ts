import { LlmProvider } from '../types';
import { fetchWithRetry } from './http';

/**
 * Anthropic adapter. Activated when ANTHROPIC_API_KEY is set.
 * Override the model with MIGRATEPR_ANTHROPIC_MODEL.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';

  async complete(system: string, prompt: string): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

    const res = await fetchWithRetry(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: process.env.MIGRATEPR_ANTHROPIC_MODEL || 'claude-sonnet-4-5',
          max_tokens: 8192,
          temperature: 0,
          system,
          messages: [{ role: 'user', content: prompt }],
        }),
      },
      { timeoutMs: 120_000 },
    );
    if (!res.ok) {
      throw new Error(`Anthropic API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return (data.content ?? [])
      .filter(part => part.type === 'text' && part.text)
      .map(part => part.text)
      .join('')
      .trim();
  }
}
