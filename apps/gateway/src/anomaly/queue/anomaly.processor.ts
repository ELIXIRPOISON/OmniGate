import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import type { AnomalyJobData } from '../envelope.js';
import { AnomalyEventsService } from '../events.service.js';
import { LlmService } from '../llm/llm.service.js';

export interface ProcessedAnomaly {
  requestId: string;
  heuristicScore: number;
  llmScore: number | null;
  verdict: string | null;
  categories: string[];
  source: string;
  eventId: string | null;
  throttled: boolean;
}

/**
 * Off the hot path (ADR-003): classify the queued envelope with the configured provider, store the
 * event, and let repeated high scores trip the reactive throttle. Failures never bubble up as job
 * failures for reasons the model is responsible for - the heuristic score is still recorded.
 */
@Injectable()
export class AnomalyProcessor {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly llm: LlmService,
    private readonly events: AnomalyEventsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AnomalyProcessor.name);
  }

  async process(job: Job<AnomalyJobData>): Promise<ProcessedAnomaly> {
    const { envelope, reason } = job.data;
    const classification = await this.llm.classify(
      envelope,
      this.env.LLM_TIMEOUT_ASYNC_MS,
    );
    const recorded = await this.events.record(envelope, classification, {
      blocked: false,
    });

    const result: ProcessedAnomaly = {
      requestId: envelope.requestId,
      heuristicScore: envelope.heuristics.score,
      llmScore: classification.verdict?.score ?? null,
      verdict: classification.verdict?.verdict ?? null,
      categories:
        classification.verdict?.categories ?? envelope.heuristics.categories,
      source: classification.source,
      eventId: recorded.id,
      throttled: recorded.throttled,
    };

    this.logger.info(
      {
        job_id: job.id,
        request_id: envelope.requestId,
        reason,
        route: envelope.route,
        principal: envelope.principal,
        heuristic_score: envelope.heuristics.score,
        llm_score: result.llmScore,
        verdict: result.verdict,
        source: classification.source,
        llm_latency_ms: classification.latencyMs,
        event_id: recorded.id,
        throttled: recorded.throttled,
        queue_lag_ms: Date.now() - job.data.enqueuedAt,
      },
      'anomaly job processed',
    );
    return result;
  }
}
