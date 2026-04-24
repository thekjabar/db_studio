import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/config.service';
import { AnthropicProvider } from './anthropic-provider';
import { GeminiProvider } from './gemini-provider';
import { OpenAiCompatProvider } from './openai-compat-provider';
import type { IAiProvider } from './ai-provider.interface';

/**
 * Builds the set of configured providers and exposes the "primary" one —
 * the one the app should use by default for AI requests.
 *
 * Resolution order for `AI_PROVIDER=auto`:
 *   Anthropic → Gemini → OpenAI → Groq → OpenRouter → Ollama
 *
 * Anthropic wins when a key is present because it's what existing
 * installs expect. Every other provider is opt-in via explicit env.
 *
 * When `AI_PROVIDER` is pinned (e.g. `gemini`), we return that provider
 * whether or not it's configured — the request will fail with a clear
 * "not configured" error instead of silently falling back. Explicit is
 * better than implicit for production.
 */
@Injectable()
export class AiProviderFactory {
  private readonly log = new Logger(AiProviderFactory.name);
  private readonly providers: Map<string, IAiProvider>;
  private readonly resolved: IAiProvider | null;

  constructor(private readonly cfg: AppConfigService) {
    // Default model per provider — chosen for cheap-but-capable SQL work.
    // Each can be overridden per-call or globally via AI_MODEL.
    const aiModel = cfg.aiModelOverride;
    const modelFor = (fallback: string) => aiModel ?? fallback;

    const anthropic = new AnthropicProvider(
      cfg.anthropicApiKey,
      modelFor(cfg.anthropicModel),
    );
    const gemini = new GeminiProvider(
      cfg.geminiApiKey,
      modelFor('gemini-2.0-flash'),
    );
    const openai = new OpenAiCompatProvider(
      'openai',
      'https://api.openai.com/v1',
      cfg.openaiApiKey,
      modelFor('gpt-4o-mini'),
    );
    const groq = new OpenAiCompatProvider(
      'groq',
      'https://api.groq.com/openai/v1',
      cfg.groqApiKey,
      modelFor('llama-3.3-70b-versatile'),
    );
    const openrouter = new OpenAiCompatProvider(
      'openrouter',
      'https://openrouter.ai/api/v1',
      cfg.openrouterApiKey,
      modelFor('meta-llama/llama-3.3-70b-instruct'),
    );
    const ollama = new OpenAiCompatProvider(
      'ollama',
      cfg.ollamaBaseUrl ?? 'http://localhost:11434/v1',
      undefined,
      modelFor('llama3.2'),
      false, // no API key required
    );

    this.providers = new Map<string, IAiProvider>([
      ['anthropic', anthropic],
      ['gemini', gemini],
      ['openai', openai],
      ['groq', groq],
      ['openrouter', openrouter],
      ['ollama', ollama],
    ]);

    this.resolved = this.resolvePrimary(cfg.aiProvider);
    if (this.resolved) {
      this.log.log(`AI provider: ${this.resolved.id} (${this.resolved.enabled ? 'ready' : 'NOT CONFIGURED'})`);
    } else {
      this.log.log('AI disabled — no provider configured');
    }
  }

  /** The primary provider. Null when AI is fully disabled. */
  get primary(): IAiProvider | null {
    return this.resolved;
  }

  private resolvePrimary(choice: string): IAiProvider | null {
    if (choice !== 'auto') {
      // Explicit pin — return that provider even if it's not configured,
      // so the failure mode is a clear "Gemini is not configured" error
      // rather than silently using Anthropic.
      return this.providers.get(choice) ?? null;
    }
    // Auto: first enabled provider in preference order.
    const order = ['anthropic', 'gemini', 'openai', 'groq', 'openrouter', 'ollama'];
    for (const id of order) {
      const p = this.providers.get(id);
      if (p?.enabled) return p;
    }
    return null;
  }
}
