import { HttpException, HttpStatus } from '@nestjs/common';
import type { AiGenerateInput, AiGenerateOutput, IAiProvider } from './ai-provider.interface';

/**
 * Provider for any OpenAI-compatible /v1/chat/completions endpoint. This
 * single class covers:
 *   - OpenAI itself       (https://api.openai.com/v1)
 *   - Groq                (https://api.groq.com/openai/v1)
 *   - OpenRouter          (https://openrouter.ai/api/v1)
 *   - Ollama local        (http://localhost:11434/v1)
 *   - Any other inference server that implements the same shape
 *
 * The factory constructs one of these per configured provider with the
 * right `baseUrl` / `apiKey` / `defaultModel`.
 *
 * Why one class for four services: the request body is identical across
 * all of them. Differences (rate limits, pricing, auth) happen outside the
 * HTTP boundary. Collapsing them means adding a fifth compatible host is
 * a config-only change.
 */
export class OpenAiCompatProvider implements IAiProvider {
  constructor(
    readonly id: string,
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly defaultModel: string,
    /** Some hosts (Ollama local) don't require a key. */
    private readonly keyRequired = true,
  ) {}

  get enabled() {
    if (this.keyRequired) return !!this.apiKey;
    return !!this.baseUrl;
  }

  async generate(input: AiGenerateInput): Promise<AiGenerateOutput> {
    if (this.keyRequired && !this.apiKey) {
      throw new Error(`${this.id} provider is not configured (missing API key)`);
    }
    const model = input.model ?? this.defaultModel;

    const messages = [
      { role: 'system' as const, content: input.system },
      ...input.messages.map((m) => ({
        role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: m.content,
      })),
    ];

    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: input.maxTokens ?? 2048,
        temperature: 0.2,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (res.status === 429 || res.status === 413) {
        throw new HttpException(
          `${this.id} rate limit hit — try again in a minute, ask a more specific question (smaller schema context), or switch provider.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw new HttpException(
          `${this.id} API key rejected. Check the key in your .env file.`,
          HttpStatus.BAD_GATEWAY,
        );
      }
      throw new HttpException(
        `${this.id} ${res.status}: ${errText.slice(0, 200)}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) throw new Error(`${this.id} returned empty content`);
    return { text, model };
  }
}
