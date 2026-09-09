import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import type { AnomalyJobData } from '../envelope.js';

export interface ProcessedAnomaly {
  requestId: string;
  heuristicScore: number;
  categories: string[];
  /** Filled in by the LLM stage in Sprint 6; heuristic-only until then. */
  llmScore: number | null;
}

/**
 * Job handler for the `anomaly` queue. Sprint 5 ships the plumbing; Sprint 6 adds the LLM
 * classification and persistence to anomaly_events (docs/08 S6-01..S6-03).
 */
@Injectable()
export class AnomalyProcessor {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AnomalyProcessor.name);
  }

  async process(job: Job<AnomalyJobData>): Promise<ProcessedAnomaly> {
    const { envelope, reason } = job.data;
    const result: ProcessedAnomaly = {
      requestId: envelope.requestId,
      heuristicScore: envelope.heuristics.score,
      categories: envelope.heuristics.categories,
      llmScore: null,
    };
    this.logger.info(
      {
        job_id: job.id,
        request_id: envelope.requestId,
        reason,
        route: envelope.route,
        principal: envelope.principal,
        heuristic_score: envelope.heuristics.score,
        categories: envelope.heuristics.categories,
        queue_lag_ms: Date.now() - job.data.enqueuedAt,
      },
      'anomaly job processed (heuristic only; LLM classification arrives in Sprint 6)',
    );
    return result;
  }
}
