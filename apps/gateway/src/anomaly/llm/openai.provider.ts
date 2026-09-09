import type { FeatureEnvelope } from '../envelope.js';
import {
  type ClassifyOptions,
  LlmError,
  type LlmProvider,
  parseVerdict,
  type Verdict,
} from './provider.js';
import { fewShotMessages, SYSTEM_PROMPT, userMessage } from './prompt.js';

export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  /** Any OpenAI-compatible endpoint: OpenAI, Groq, Together, Mistral, DeepSeek, Ollama (/v1), vLLM… */
  baseUrl: string;
  maxOutputTokens: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  name?: string;
}

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * Chat-completions adapter. Because the wire format is a de-facto standard, pointing LLM_BASE_URL
 * at another vendor (or a local Ollama) reuses this adapter unchanged - that is how OmniGate stays
 * provider-agnostic without a class per vendor.
 */
export class OpenAiProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAiProviderOptions) {
    this.name = opts.name ?? 'openai';
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async classify(
    envelope: FeatureEnvelope,
    { timeoutMs }: ClassifyOptions,
  ): Promise<Verdict> {
    const body = {
      model: this.model,
      max_tokens: this.opts.maxOutputTokens,
      temperature: 0,
      // JSON mode where supported; the parser stays tolerant for endpoints that ignore it.
      response_format: { type: 'json_object' as const },
      messages: [
        { role: 'system' as const, content: SYSTEM_PROMPT },
        ...fewShotMessages(),
        { role: 'user' as const, content: userMessage(envelope) },
      ],
    };

    const response = await this.post(
      `${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`,
      body,
      timeoutMs,
    );
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new LlmError(
        'invalid_output',
        `Empty completion${json.error?.message ? `: ${json.error.message}` : ''}`,
      );
    }
    return parseVerdict(content);
  }

  private async post(
    url: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Local servers accept (and ignore) a dummy key, so the header is always present.
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new LlmError('timeout', `LLM call exceeded ${timeoutMs} ms`);
      }
      throw new LlmError(
        'http',
        `LLM request failed: ${(err as Error).message}`,
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new LlmError(
        'http',
        `LLM returned ${response.status}: ${text.slice(0, 200)}`,
        response.status,
      );
    }
    return response;
  }
}
