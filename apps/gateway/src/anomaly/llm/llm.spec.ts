import { readFileSync } from 'node:fs';
import type { PinoLogger } from 'nestjs-pino';
import type { Env } from '../../config/env.js';
import type { RedisService } from '../../redis/redis.service.js';
import type { FeatureEnvelope } from '../envelope.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { FakeProvider } from './fake.provider.js';
import {
  BREAKER_FAILURE_THRESHOLD,
  dedupHash,
  LlmGuardrails,
  utcDay,
} from './guardrails.js';
import {
  createLlmProvider,
  createProviderOrDisabled,
  LOCAL_DEFAULT_BASE_URL,
} from './llm.factory.js';
import { LlmService } from './llm.service.js';
import { OpenAiProvider } from './openai.provider.js';
import {
  CONFIDENCE_SCORE,
  LlmError,
  parseVerdict,
  type LlmProvider,
} from './provider.js';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`./__fixtures__/${name}.json`, import.meta.url),
      'utf8',
    ),
  );

const logger = {
  setContext() {},
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as PinoLogger;

const envelope = (over: Partial<FeatureEnvelope> = {}): FeatureEnvelope => ({
  requestId: 'req-1',
  route: 'orders',
  method: 'GET',
  path: '/v1/orders',
  principal: 'api_key:k1',
  clientCountry: null,
  userAgent: 'Mozilla/5.0',
  querySample: 'page=2',
  bodySample: '',
  heuristics: {
    score: 0.02,
    signals: {
      injection_patterns: 0,
      body_size_z: 0,
      entropy: 0,
      burst: 0,
      path_enum: 0,
      ua_anomaly: 0,
      auth_failures: 0,
      method_mismatch: 0,
      unknown_param: 0,
    },
    categories: [],
    matchedPatterns: [],
  },
  principalStats10m: { requests: 20, errorRate: 0.01, distinctPaths: 3 },
  ...over,
});

/** Stub fetch returning a scripted body, so no test touches the network (docs/09 section 2). */
function stubFetch(
  handler: (
    url: string,
    init: RequestInit,
  ) => { status?: number; body: unknown } | Promise<never>,
): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const url = String(input);
    calls.push({ url, init });
    const result = await handler(url, init);
    const { status = 200, body } = result;
    return new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      {
        status,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('parseVerdict', () => {
  it('accepts clean JSON, fenced JSON and JSON wrapped in prose', () => {
    const clean = parseVerdict(
      '{"verdict":"malicious","confidence":"high","categories":["sqli"],"reasoning":"x"}',
    );
    expect(clean).toMatchObject({
      verdict: 'malicious',
      confidence: 'high',
      categories: ['sqli'],
    });
    expect(
      parseVerdict(
        '```json\n{"verdict":"benign","confidence":"high","categories":[],"reasoning":"ok"}\n```',
      ).verdict,
    ).toBe('benign');
    expect(
      parseVerdict(
        'Sure! {"verdict":"suspicious","confidence":"low","categories":[],"reasoning":"hm"} hope that helps',
      ).verdict,
    ).toBe('suspicious');
  });

  it('derives the score from verdict and confidence, not from the model number', () => {
    // A model that still volunteers a score has it recorded but not acted on: this is the whole
    // point of the change, since the number it volunteers tracks the heuristic score it was shown.
    const v = parseVerdict(
      '{"score":0.11,"verdict":"suspicious","confidence":"high","categories":[],"reasoning":"x"}',
    );
    expect(v.rawScore).toBe(0.11);
    expect(v.score).toBe(CONFIDENCE_SCORE.suspicious.high);
  });

  it('puts a confidently suspicious request above the flag threshold', () => {
    // The regression this change exists to prevent: the old prompt capped "suspicious" at 0.7 and
    // the flag threshold was also 0.7, so no suspicious verdict could ever trigger action.
    expect(CONFIDENCE_SCORE.suspicious.high).toBeGreaterThan(0.7);
    expect(CONFIDENCE_SCORE.suspicious.high).toBeLessThan(0.9);
    expect(CONFIDENCE_SCORE.malicious.medium).toBeGreaterThanOrEqual(0.9);
    // Confidence is in the verdict, not in the danger: surer it is benign means a lower score.
    expect(CONFIDENCE_SCORE.benign.high).toBeLessThan(CONFIDENCE_SCORE.benign.low);
  });

  it('defaults a missing confidence to medium', () => {
    const v = parseVerdict(
      '{"verdict":"malicious","categories":[],"reasoning":"x"}',
    );
    expect(v.confidence).toBe('medium');
    expect(v.score).toBe(CONFIDENCE_SCORE.malicious.medium);
  });

  it('drops unknown categories, clamps reasoning and coerces numeric strings', () => {
    const v = parseVerdict(
      `{"score":"0.42","verdict":"suspicious","confidence":"low","categories":["sqli","aliens","XSS"],"reasoning":"${'y'.repeat(400)}"}`,
    );
    expect(v.rawScore).toBe(0.42);
    expect(v.categories).toEqual(['sqli', 'xss']);
    expect(v.reasoning).toHaveLength(240);
  });

  it('rejects malformed output, out-of-range scores and unknown verdicts', () => {
    expect(() => parseVerdict('not json at all')).toThrow(LlmError);
    expect(() =>
      parseVerdict(
        '{"score":4,"verdict":"malicious","confidence":"high","categories":[],"reasoning":"x"}',
      ),
    ).toThrow(LlmError);
    expect(() =>
      parseVerdict(
        '{"verdict":"spicy","confidence":"high","categories":[],"reasoning":"x"}',
      ),
    ).toThrow(LlmError);
    expect(() =>
      parseVerdict(
        '{"verdict":"malicious","confidence":"certain","categories":[],"reasoning":"x"}',
      ),
    ).toThrow(LlmError);
  });
});

describe('OpenAiProvider (recorded fixtures)', () => {
  const opts = {
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    maxOutputTokens: 200,
  };

  it('posts the prompt with JSON mode and parses the completion', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      body: fixture('openai-chat-completion'),
    }));
    const verdict = await new OpenAiProvider({ ...opts, fetchImpl }).classify(
      envelope(),
      { timeoutMs: 5_000 },
    );
    expect(verdict).toMatchObject({
      verdict: 'malicious',
      confidence: 'high',
      score: CONFIDENCE_SCORE.malicious.high,
      categories: ['sqli'],
    });

    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    const sent = JSON.parse(String(calls[0].init.body)) as {
      model: string;
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(sent.model).toBe('gpt-4o-mini');
    expect(sent.response_format.type).toBe('json_object');
    expect(sent.messages[0].role).toBe('system');
    // four few-shot pairs plus the request under test
    expect(sent.messages.filter((m) => m.role === 'user')).toHaveLength(5);
    expect(sent.messages.at(-1)?.content).toContain('<request>');

    // The envelope carries the heuristic score. Withholding it was tried and measured: the model's
    // own judgement is close to constant without it and recall fell from 0.900 to 0.433. It is safe
    // to send because combine.ts only lets the model raise the score, never lower it.
    expect(sent.messages.at(-1)?.content).toContain('signals');
    expect(sent.messages.at(-1)?.content).toContain('score');
    // The model is asked for a judgement, not a number.
    expect(sent.messages[0].content).toContain('confidence');
    expect(sent.messages[0].content).toContain('Do not return a numeric score');
  });

  it('works against any OpenAI-compatible base URL (Groq, Ollama, vLLM)', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      body: fixture('openai-chat-completion'),
    }));
    await new OpenAiProvider({
      ...opts,
      baseUrl: 'http://localhost:11434/v1/',
      fetchImpl,
    }).classify(envelope(), { timeoutMs: 1_000 });
    expect(calls[0].url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('maps HTTP failures, empty completions and timeouts to LlmError kinds', async () => {
    const http = stubFetch(() => ({
      status: 429,
      body: { error: { message: 'slow down' } },
    }));
    await expect(
      new OpenAiProvider({ ...opts, fetchImpl: http.fetchImpl }).classify(
        envelope(),
        { timeoutMs: 100 },
      ),
    ).rejects.toMatchObject({
      kind: 'http',
      status: 429,
    });

    const empty = stubFetch(() => ({ body: { choices: [] } }));
    await expect(
      new OpenAiProvider({ ...opts, fetchImpl: empty.fetchImpl }).classify(
        envelope(),
        { timeoutMs: 100 },
      ),
    ).rejects.toMatchObject({
      kind: 'invalid_output',
    });

    const timeout = stubFetch(() =>
      Promise.reject(
        Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
      ),
    );
    await expect(
      new OpenAiProvider({ ...opts, fetchImpl: timeout.fetchImpl }).classify(
        envelope(),
        { timeoutMs: 50 },
      ),
    ).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});

describe('AnthropicProvider (recorded fixtures)', () => {
  const opts = {
    apiKey: 'sk-ant-test',
    model: 'claude-haiku-4-5-20251001',
    baseUrl: 'https://api.anthropic.com',
    maxOutputTokens: 200,
  };

  it('forces the verdict tool and reads its input', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      body: fixture('anthropic-tool-use'),
    }));
    const verdict = await new AnthropicProvider({
      ...opts,
      fetchImpl,
    }).classify(envelope(), { timeoutMs: 5_000 });
    expect(verdict).toMatchObject({
      verdict: 'suspicious',
      confidence: 'high',
      score: CONFIDENCE_SCORE.suspicious.high,
      categories: ['scraping', 'enumeration'],
    });

    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(
      (calls[0].init.headers as Record<string, string>)['anthropic-version'],
    ).toBe('2023-06-01');
    const sent = JSON.parse(String(calls[0].init.body)) as {
      tool_choice: { name: string };
      system: string;
    };
    expect(sent.tool_choice.name).toBe('record_verdict');
    expect(sent.system).toContain('untrusted DATA');
  });

  it('falls back to text content when no tool block is returned', async () => {
    const { fetchImpl } = stubFetch(() => ({
      body: {
        content: [
          {
            type: 'text',
            text: '{"score":0.2,"verdict":"benign","categories":[],"reasoning":"fine"}',
          },
        ],
      },
    }));
    await expect(
      new AnthropicProvider({ ...opts, fetchImpl }).classify(envelope(), {
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      verdict: 'benign',
    });
  });
});

describe('FakeProvider', () => {
  const fake = new FakeProvider();

  it('is deterministic and mirrors obvious injection signals', async () => {
    const attack = envelope({
      heuristics: {
        ...envelope().heuristics,
        score: 0.9,
        categories: ['sqli'],
        matchedPatterns: ['tautology'],
      },
    });
    const first = await fake.classify(attack, { timeoutMs: 100 });
    const second = await fake.classify(attack, { timeoutMs: 100 });
    expect(first).toEqual(second);
    expect(first.verdict).toBe('malicious');
    expect(first.categories).toContain('sqli');
  });

  it('uses sender statistics the inline pass only samples', async () => {
    const scraper = await fake.classify(
      envelope({
        principal: 'anon:1.2.3.4',
        principalStats10m: {
          requests: 4000,
          errorRate: 0.2,
          distinctPaths: 3800,
        },
      }),
      { timeoutMs: 100 },
    );
    expect(scraper.score).toBeGreaterThanOrEqual(0.7);
    expect(scraper.categories).toEqual(
      expect.arrayContaining(['scraping', 'enumeration']),
    );

    const stuffing = await fake.classify(
      envelope({
        principal: 'anon:5.6.7.8',
        principalStats10m: { requests: 400, errorRate: 0.95, distinctPaths: 2 },
      }),
      { timeoutMs: 100 },
    );
    expect(stuffing.categories).toContain('credential_stuffing');
  });

  it('does not flag a busy trusted integration on few paths', async () => {
    const trusted = await fake.classify(
      envelope({
        principal: 'api_key:erp',
        principalStats10m: {
          requests: 5000,
          errorRate: 0.01,
          distinctPaths: 2,
        },
      }),
      { timeoutMs: 100 },
    );
    expect(trusted.verdict).toBe('benign');
  });
});

describe('createLlmProvider', () => {
  const base = { LLM_MAX_OUTPUT_TOKENS: 200 } as Env;

  it('selects the adapter for each LLM_PROVIDER value', () => {
    expect(createLlmProvider({ ...base, LLM_PROVIDER: 'fake' }).name).toBe(
      'fake',
    );
    expect(
      createLlmProvider({ ...base, LLM_PROVIDER: 'openai', LLM_API_KEY: 'k' }),
    ).toBeInstanceOf(OpenAiProvider);
    expect(
      createLlmProvider({
        ...base,
        LLM_PROVIDER: 'anthropic',
        LLM_API_KEY: 'k',
      }),
    ).toBeInstanceOf(AnthropicProvider);
    const local = createLlmProvider({ ...base, LLM_PROVIDER: 'local' } as Env);
    expect(local).toBeInstanceOf(OpenAiProvider);
    expect(local.name).toBe('local');
  });

  it('requires a key for hosted providers but not for local or fake', () => {
    expect(() =>
      createLlmProvider({ ...base, LLM_PROVIDER: 'openai' } as Env),
    ).toThrow(/LLM_API_KEY/);
    expect(() =>
      createLlmProvider({ ...base, LLM_PROVIDER: 'anthropic' } as Env),
    ).toThrow(/LLM_API_KEY/);
    expect(() =>
      createLlmProvider({ ...base, LLM_PROVIDER: 'local' } as Env),
    ).not.toThrow();
  });

  it('honours LLM_MODEL and LLM_BASE_URL overrides', () => {
    const groq = createLlmProvider({
      ...base,
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: 'k',
      LLM_MODEL: 'llama-3.3-70b-versatile',
      LLM_BASE_URL: 'https://api.groq.com/openai/v1',
    } as Env);
    expect(groq.model).toBe('llama-3.3-70b-versatile');
    expect(LOCAL_DEFAULT_BASE_URL).toContain('11434');
  });
});

/** In-memory Redis good enough for the guardrail commands. */
function fakeRedis(down = false) {
  const store = new Map<string, string>();
  const client = {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => (store.set(k, v), 'OK'),
    del: async (k: string) => (store.delete(k) ? 1 : 0),
    exists: async (k: string) => (store.has(k) ? 1 : 0),
    multi() {
      const ops: Array<() => unknown> = [];
      const chain = {
        incr: (k: string) => (
          ops.push(() => {
            const n = Number(store.get(k) ?? 0) + 1;
            store.set(k, String(n));
            return n;
          }),
          chain
        ),
        expire: () => (ops.push(() => 1), chain),
        set: (k: string, v: string) => (
          ops.push(() => (store.set(k, v), 'OK')),
          chain
        ),
        del: (k: string) => (ops.push(() => (store.delete(k) ? 1 : 0)), chain),
        exec: async () => ops.map((op) => [null, op()] as [null, unknown]),
      };
      return chain;
    },
  };
  const redis = {
    store,
    safe: async <T>(
      _w: string,
      fn: (c: typeof client) => Promise<T>,
      fallback: T,
    ) => (down ? fallback : fn(client)),
  };
  return redis as unknown as RedisService & { store: Map<string, string> };
}

describe('LlmGuardrails', () => {
  it('caches and reuses verdicts by principal + payload hash', async () => {
    const redis = fakeRedis();
    const g = new LlmGuardrails(redis, logger);
    const hash = dedupHash(envelope());
    expect(await g.cachedVerdict(hash)).toBeNull();
    await g.cacheVerdict(hash, {
       confidence: 'medium',score: 0.4,
      verdict: 'suspicious',
      categories: [],
      reasoning: 'x',
    });
    expect(await g.cachedVerdict(hash)).toMatchObject({ score: 0.4 });
    // a different payload from the same principal is a different key
    expect(
      await g.cachedVerdict(dedupHash(envelope({ bodySample: 'other' }))),
    ).toBeNull();
  });

  it('enforces the daily cap using a per-day counter', async () => {
    const redis = fakeRedis();
    const g = new LlmGuardrails(redis, logger);
    expect(await g.blockedReason(2)).toBeNull();
    await g.countCall();
    await g.countCall();
    expect(await g.callsToday()).toBe(2);
    expect(await g.blockedReason(2)).toBe('daily_cap');
    expect(await g.blockedReason(0)).toBe('daily_cap');
    expect(redis.store.has(`llm:calls:${utcDay()}`)).toBe(true);
  });

  it('opens the breaker after five consecutive failures and closes it on success', async () => {
    const redis = fakeRedis();
    const g = new LlmGuardrails(redis, logger);
    for (let i = 1; i < BREAKER_FAILURE_THRESHOLD; i++) {
      expect(await g.recordFailure()).toBe(false);
      expect(await g.blockedReason(100)).toBeNull();
    }
    expect(await g.recordFailure()).toBe(true);
    expect(await g.blockedReason(100)).toBe('circuit_open');
    // the open flag expires on its own; a success clears the failure streak
    redis.store.delete('cb:llm:open');
    await g.recordSuccess();
    expect(await g.blockedReason(100)).toBeNull();
  });

  it('degrades to "allow, uncached" when Redis is unavailable', async () => {
    const g = new LlmGuardrails(fakeRedis(true), logger);
    expect(await g.cachedVerdict('h')).toBeNull();
    expect(await g.blockedReason(100)).toBeNull();
    expect(await g.recordFailure()).toBe(false);
  });
});

describe('LlmService', () => {
  const env = {
    LLM_PROVIDER: 'fake',
    LLM_DAILY_CALL_CAP: 100,
    LLM_MAX_OUTPUT_TOKENS: 200,
  } as Env;

  function serviceWith(provider: LlmProvider, redis = fakeRedis()) {
    const svc = new LlmService(
      env,
      new LlmGuardrails(redis, logger),
      logger,
      provider,
    );
    return { svc, redis };
  }

  const okVerdict = {
    score: 0.8,
    confidence: 'medium' as const,
    verdict: 'malicious' as const,
    categories: ['sqli' as const],
    reasoning: 'x',
  };
  const provider = (classify: LlmProvider['classify']): LlmProvider => ({
    name: 'test',
    model: 'test-model',
    classify,
  });

  it('calls the provider once, caches the verdict and serves the repeat from dedup', async () => {
    const classify = vi.fn(async () => okVerdict);
    const { svc } = serviceWith(provider(classify));
    const first = await svc.classify(envelope(), 1_000);
    expect(first).toMatchObject({ source: 'llm', verdict: okVerdict });
    expect(first.latencyMs).toBeGreaterThanOrEqual(0);
    const second = await svc.classify(envelope(), 1_000);
    expect(second.source).toBe('dedup');
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('retries once on malformed output and then gives up without throwing', async () => {
    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new LlmError('invalid_output', 'junk'))
      .mockResolvedValueOnce(okVerdict);
    const { svc } = serviceWith(
      provider(flaky as unknown as LlmProvider['classify']),
    );
    await expect(svc.classify(envelope(), 1_000)).resolves.toMatchObject({
      source: 'llm',
    });
    expect(flaky).toHaveBeenCalledTimes(2);

    const broken = vi
      .fn()
      .mockRejectedValue(new LlmError('invalid_output', 'junk'));
    const { svc: svc2 } = serviceWith(
      provider(broken as unknown as LlmProvider['classify']),
    );
    await expect(
      svc2.classify(envelope({ requestId: 'r2', bodySample: 'b2' }), 1_000),
    ).resolves.toMatchObject({
      source: 'error',
      detail: 'invalid_output',
      verdict: null,
    });
    expect(broken).toHaveBeenCalledTimes(2);
  });

  it('fails open on timeouts and does not retry them', async () => {
    const slow = vi.fn().mockRejectedValue(new LlmError('timeout', 'too slow'));
    const { svc } = serviceWith(
      provider(slow as unknown as LlmProvider['classify']),
    );
    await expect(svc.classify(envelope(), 10)).resolves.toMatchObject({
      source: 'error',
      detail: 'timeout',
      verdict: null,
    });
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('skips the model once the breaker is open or the daily cap is reached', async () => {
    const failing = vi.fn().mockRejectedValue(new LlmError('http', 'boom'));
    const { svc } = serviceWith(
      provider(failing as unknown as LlmProvider['classify']),
    );
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
      await svc.classify(
        envelope({ requestId: `r${i}`, bodySample: `b${i}` }),
        100,
      );
    }
    const skipped = await svc.classify(
      envelope({ requestId: 'after', bodySample: 'after' }),
      100,
    );
    expect(skipped).toMatchObject({
      source: 'skipped',
      detail: 'circuit_open',
    });
    expect(failing).toHaveBeenCalledTimes(BREAKER_FAILURE_THRESHOLD);

    const capped = new LlmService(
      { ...env, LLM_DAILY_CALL_CAP: 0 } as Env,
      new LlmGuardrails(fakeRedis(), logger),
      logger,
      provider(async () => okVerdict),
    );
    await expect(capped.classify(envelope(), 100)).resolves.toMatchObject({
      source: 'skipped',
      detail: 'daily_cap',
    });
  });

  it('never throws when the provider is misconfigured', async () => {
    const svc = new LlmService(
      env,
      new LlmGuardrails(fakeRedis(), logger),
      logger,
      createProviderOrDisabled({
        ...env,
        LLM_PROVIDER: 'openai',
        LLM_API_KEY: undefined,
      } as Env),
    );
    await expect(svc.classify(envelope(), 100)).resolves.toMatchObject({
      source: 'skipped',
      detail: 'config',
      verdict: null,
    });
  });
});
