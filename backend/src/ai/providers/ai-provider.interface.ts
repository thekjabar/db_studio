/**
 * Minimal interface every AI provider implements. All providers reduce to
 * "given a system prompt + a conversation, return an assistant text reply."
 *
 * Why not expose tool-calling, streaming, images, etc.?  We don't use any of
 * those in Studio's AI surfaces yet. Keeping the contract small means adding
 * a new provider is a 40-line implementation, and swapping providers never
 * changes the call sites.
 *
 * If we add streaming later, do it as a second method (`stream(...)`)
 * rather than making `generate` return an AsyncIterator — most existing
 * call sites just want the final string.
 */
export interface AiGenerateInput {
  /** System prompt / persona. */
  system: string;
  /** Conversation so far. The model reads these in order and replies to the
   *  last one. For one-shot SQL generation this is a single user message. */
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** Upper bound on tokens in the response. Optional — providers use their
   *  own sensible default when omitted (usually 1024-2048). */
  maxTokens?: number;
  /** Optional per-call model override. Falls back to the provider's
   *  configured default when omitted. */
  model?: string;
}

export interface AiGenerateOutput {
  /** Assistant's text reply. Never null — providers throw on empty/failed
   *  responses rather than return empty strings. */
  text: string;
  /** Which model actually served the request, for logging / audit. */
  model: string;
}

export interface IAiProvider {
  /** Stable identifier — "anthropic" | "gemini" | "openai" | etc. */
  readonly id: string;

  /** Whether the provider has enough config (API key / base URL) to run. */
  readonly enabled: boolean;

  generate(input: AiGenerateInput): Promise<AiGenerateOutput>;
}
