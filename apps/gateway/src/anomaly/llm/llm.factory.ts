import type { Env } from '../../config/env.js';
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL,
  AnthropicProvider,
} from './anthropic.provider.js';
import { FakeProvider } from './fake.provider.js';
import {
  OPENAI_DEFAULT_BASE_URL,
  OPENAI_DEFAULT_MODEL,
  OpenAiProvider,
} from './openai.provider.js';
import { LlmError, type LlmProvider } from './provider.js';

/** DI token for the active adapter, so tests and future runtime switching can replace it. */
export const LLM_PROVIDER_TOKEN = Symbol('LLM_PROVIDER');

/** Ollama's OpenAI-compatible endpoint; `local` means "an OpenAI-shaped server you run yourself". */
export const LOCAL_DEFAULT_BASE_URL = 'http://localhost:11434/v1';
export const LOCAL_DEFAULT_MODEL = 'qwen2.5:7b';

/**
 * Pick the adapter for LLM_PROVIDER (docs/06 §6.1). `openai` and `local` share one adapter because
 * the chat-completions shape is a de-facto standard: setting LLM_BASE_URL points it at Groq,
 * Together, Mistral, DeepSeek, vLLM or Ollama without new code.
 */
export function createLlmProvider(
  env: Env,
  fetchImpl?: typeof fetch,
): LlmProvider {
  const maxOutputTokens = env.LLM_MAX_OUTPUT_TOKENS;
  switch (env.LLM_PROVIDER) {
    case 'fake':
      return new FakeProvider();
    case 'anthropic':
      if (!env.LLM_API_KEY)
        throw new LlmError(
          'config',
          'LLM_API_KEY is required for LLM_PROVIDER=anthropic',
        );
      return new AnthropicProvider({
        apiKey: env.LLM_API_KEY,
        model: env.LLM_MODEL ?? ANTHROPIC_DEFAULT_MODEL,
        baseUrl: env.LLM_BASE_URL ?? ANTHROPIC_DEFAULT_BASE_URL,
        maxOutputTokens,
        fetchImpl,
      });
    case 'local':
      return new OpenAiProvider({
        name: 'local',
        // Local servers ignore the key but the header must exist.
        apiKey: env.LLM_API_KEY ?? 'local',
        model: env.LLM_MODEL ?? LOCAL_DEFAULT_MODEL,
        baseUrl: env.LLM_BASE_URL ?? LOCAL_DEFAULT_BASE_URL,
        maxOutputTokens,
        fetchImpl,
      });
    case 'openai':
    default:
      if (!env.LLM_API_KEY)
        throw new LlmError(
          'config',
          'LLM_API_KEY is required for LLM_PROVIDER=openai',
        );
      return new OpenAiProvider({
        apiKey: env.LLM_API_KEY,
        model: env.LLM_MODEL ?? OPENAI_DEFAULT_MODEL,
        baseUrl: env.LLM_BASE_URL ?? OPENAI_DEFAULT_BASE_URL,
        maxOutputTokens,
        fetchImpl,
      });
  }
}

/**
 * Module-level factory: a misconfigured provider must not stop the gateway from booting, so the
 * error is deferred into every call and surfaces as a skipped classification.
 */
export function createProviderOrDisabled(env: Env): LlmProvider {
  try {
    return createLlmProvider(env);
  } catch (err) {
    const message = (err as Error).message;
    return {
      name: 'disabled',
      model: 'none',
      classify: () => Promise.reject(new LlmError('config', message)),
    };
  }
}
