import { LlmProvider } from '../types';
import { fetchWithRetry } from './http';

/**
 * OpenAI adapter. Activated when OPENAI_API_KEY is set.
 * Override the model with MIGRATEPR_OPENAI_MODEL.
 */
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';

  async complete(system: string, prompt: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const res = await fetchWithRetry(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: process.env.MIGRATEPR_OPENAI_MODEL || 'gpt-4o-mini',
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        }),
      },
      { timeoutMs: 120_000 },
    );
    if (!res.ok) {
      throw new Error(`OpenAI API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return (data.choices?.[0]?.message?.content ?? '').trim();
  }
}
