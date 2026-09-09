import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import type { FeatureEnvelope } from '../envelope.js';
import { dedupHash, LlmGuardrails, type SkipReason } from './guardrails.js';
import { LLM_PROVIDER_TOKEN } from './llm.factory.js';
import { LlmError, type LlmProvider, type Verdict } from './provider.js';

export type ClassificationSource = 'llm' | 'dedup' | 'skipped' | 'error';

export interface Classification {
  verdict: Verdict | null;
  source: ClassificationSource;
  /** Why no model ran, or what went wrong. */
  detail?: SkipReason | string;
  latencyMs: number | null;
  model: string;
}

/**
 * Everything between the queue (or a sync route) and a provider: dedup, budget, breaker, timeout,
 * one retry on malformed output, and validation. Never throws - callers get a null verdict and
 * fall back to the heuristic score (docs/06 section 6.3, ADR-003 fail-open).
 */
@Injectable()
export class LlmService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly guardrails: LlmGuardrails,
    private readonly logger: PinoLogger,
    @Inject(LLM_PROVIDER_TOKEN) private readonly provider: LlmProvider,
  ) {
    this.logger.setContext(LlmService.name);
    this.logger.info(
      { provider: this.provider.name, model: this.provider.model },
      'llm provider ready',
    );
  }

  get model(): string {
    return this.provider.model;
  }

  get providerName(): string {
    return this.provider.name;
  }

  async classify(
    envelope: FeatureEnvelope,
    timeoutMs: number,
  ): Promise<Classification> {
    const model = this.provider.model;
    const hash = dedupHash(envelope);
    const cached = await this.guardrails.cachedVerdict(hash);
    if (cached)
      return { verdict: cached, source: 'dedup', latencyMs: 0, model };

    const blocked = await this.guardrails.blockedReason(
      this.env.LLM_DAILY_CALL_CAP,
    );
    if (blocked)
      return {
        verdict: null,
        source: 'skipped',
        detail: blocked,
        latencyMs: null,
        model,
      };

    await this.guardrails.countCall();
    const startedAt = Date.now();
    try {
      const verdict = await this.callWithRetry(envelope, timeoutMs);
      const latencyMs = Date.now() - startedAt;
      await this.guardrails.recordSuccess();
      await this.guardrails.cacheVerdict(hash, verdict);
      return { verdict, source: 'llm', latencyMs, model };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const kind = err instanceof LlmError ? err.kind : 'unknown';
      if (kind === 'config') {
        // Nothing was actually called, so this must not count toward the circuit breaker.
        return {
          verdict: null,
          source: 'skipped',
          detail: 'config',
          latencyMs: null,
          model,
        };
      }
      await this.guardrails.recordFailure();
      this.logger.warn(
        {
          request_id: envelope.requestId,
          kind,
          err_message: (err as Error).message,
          latency_ms: latencyMs,
        },
        'llm classification failed; keeping the heuristic score',
      );
      return { verdict: null, source: 'error', detail: kind, latencyMs, model };
    }
  }

  /** One retry, only for malformed output; timeouts and HTTP errors are not worth a second wait. */
  private async callWithRetry(
    envelope: FeatureEnvelope,
    timeoutMs: number,
  ): Promise<Verdict> {
    try {
      return await this.provider.classify(envelope, { timeoutMs });
    } catch (err) {
      if (err instanceof LlmError && err.kind === 'invalid_output') {
        this.logger.debug(
          { request_id: envelope.requestId },
          'retrying llm call after invalid output',
        );
        return this.provider.classify(envelope, { timeoutMs });
      }
      throw err;
    }
  }
}
