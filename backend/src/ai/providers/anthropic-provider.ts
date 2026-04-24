import Anthropic from '@anthropic-ai/sdk';
import type { AiGenerateInput, AiGenerateOutput, IAiProvider } from './ai-provider.interface';

/**
 * Anthropic Claude via the official SDK. Default model is Haiku 4.5 — cheap,
 * fast, and genuinely good at SQL generation. Upgrade to Sonnet for hard
 * reasoning or Opus for the best quality at ~15x the cost.
 */
export class AnthropicProvider implements IAiProvider {
  readonly id = 'anthropic';
  private client: Anthropic | null = null;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly defaultModel: string,
  ) {
    if (apiKey) this.client = new Anthropic({ apiKey });
  }

  get enabled() {
    return this.client !== null;
  }

  async generate(input: AiGenerateInput): Promise<AiGenerateOutput> {
    if (!this.client) throw new Error('Anthropic provider is not configured');
    const model = input.model ?? this.defaultModel;
    const resp = await this.client.messages.create({
      model,
      max_tokens: input.maxTokens ?? 2048,
      system: input.system,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const block = resp.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') {
      throw new Error('Anthropic returned no text content');
    }
    return { text: block.text.trim(), model };
  }
}
