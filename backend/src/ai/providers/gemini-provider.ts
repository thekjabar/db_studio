import { HttpException, HttpStatus } from '@nestjs/common';
import type { AiGenerateInput, AiGenerateOutput, IAiProvider } from './ai-provider.interface';

/**
 * Google Gemini via the v1beta REST API. We skip @google/genai to avoid a
 * new dependency — the HTTP surface we need is small.
 *
 * The API's message format differs from Anthropic/OpenAI:
 *   - `systemInstruction` is a top-level field, not a message with role=system
 *   - messages are `contents: [{ role, parts: [{ text }] }]`
 *   - `role` is "user" | "model" (not "assistant")
 *
 * We translate at the boundary so call sites keep using the universal
 * AiGenerateInput shape.
 */
export class GeminiProvider implements IAiProvider {
  readonly id = 'gemini';

  constructor(
    private readonly apiKey: string | undefined,
    private readonly defaultModel: string,
  ) {}

  get enabled() {
    return !!this.apiKey;
  }

  async generate(input: AiGenerateInput): Promise<AiGenerateOutput> {
    if (!this.apiKey) throw new Error('Gemini provider is not configured');
    const model = input.model ?? this.defaultModel;

    // v1beta endpoint. The `:generateContent` suffix is the sync-text method;
    // `:streamGenerateContent` exists if we ever add streaming.
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
      `:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const body = {
      systemInstruction: { parts: [{ text: input.system }] },
      contents: input.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        maxOutputTokens: input.maxTokens ?? 2048,
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (res.status === 429) {
        throw new HttpException(
          'Gemini quota exceeded — check your plan at aistudio.google.com/apikey, or switch to another provider (AI_PROVIDER=groq/openai/anthropic).',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw new HttpException(
          'Gemini API key rejected. Rotate the key at aistudio.google.com/apikey and update GEMINI_API_KEY.',
          HttpStatus.BAD_GATEWAY,
        );
      }
      throw new HttpException(
        `Gemini ${res.status}: ${errText.slice(0, 200)}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const data = (await res.json()) as {
      candidates?: {
        content?: { parts?: { text?: string }[] };
        finishReason?: string;
      }[];
      promptFeedback?: { blockReason?: string };
    };

    // Safety / block responses don't include candidates.
    if (!data.candidates?.length) {
      const blocked = data.promptFeedback?.blockReason;
      throw new Error(
        blocked
          ? `Gemini blocked the request (${blocked})`
          : 'Gemini returned no candidates',
      );
    }
    const text = data.candidates[0].content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text.trim()) throw new Error('Gemini returned empty text');
    return { text: text.trim(), model };
  }
}
