import type { FeatureEnvelope } from '../envelope.js';
import {
  type ClassifyOptions,
  LlmError,
  type LlmProvider,
  parseVerdict,
  type Verdict,
  VERDICT_CATEGORIES,
} from './provider.js';
import { fewShotMessages, SYSTEM_PROMPT, userMessage } from './prompt.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxOutputTokens: number;
  fetchImpl?: typeof fetch;
}

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const API_VERSION = '2023-06-01';

/** Forced tool call is Anthropic's structured-output mode, so the answer is JSON by construction. */
const VERDICT_TOOL = {
  name: 'record_verdict',
  description: 'Record the security classification for the analysed request.',
  input_schema: {
    type: 'object' as const,
    properties: {
      score: { type: 'number', minimum: 0, maximum: 1 },
      verdict: { type: 'string', enum: ['benign', 'suspicious', 'malicious'] },
      categories: {
        type: 'array',
        items: { type: 'string', enum: [...VERDICT_CATEGORIES] },
      },
      reasoning: { type: 'string', maxLength: 240 },
    },
    required: ['score', 'verdict', 'categories', 'reasoning'],
  },
};

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: AnthropicProviderOptions) {
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
      system: SYSTEM_PROMPT,
      tools: [VERDICT_TOOL],
      tool_choice: { type: 'tool' as const, name: VERDICT_TOOL.name },
      messages: [
        ...fewShotMessages(),
        { role: 'user' as const, content: userMessage(envelope) },
      ],
    };

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.opts.baseUrl.replace(/\/$/, '')}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.opts.apiKey,
            'anthropic-version': API_VERSION,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
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

    const json = (await response.json()) as {
      content?: Array<{ type: string; text?: string; input?: unknown }>;
    };
    const toolUse = json.content?.find((block) => block.type === 'tool_use');
    if (toolUse?.input) return parseVerdict(JSON.stringify(toolUse.input));
    const text = json.content?.find((block) => block.type === 'text')?.text;
    if (typeof text === 'string' && text.length > 0) return parseVerdict(text);
    throw new LlmError(
      'invalid_output',
      'Anthropic response contained no verdict',
    );
  }
}
