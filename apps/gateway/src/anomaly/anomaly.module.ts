import { Module } from '@nestjs/common';
import { AnomalyInterceptor } from './anomaly.interceptor.js';
import { AnomalyEventsService } from './events.service.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { LlmGuardrails } from './llm/guardrails.js';
import {
  createProviderOrDisabled,
  LLM_PROVIDER_TOKEN,
} from './llm/llm.factory.js';
import { LlmService } from './llm/llm.service.js';
import { AnomalyProcessor } from './queue/anomaly.processor.js';
import { AnomalyQueue } from './queue/anomaly.queue.js';
import { AnomalyWorker } from './queue/anomaly.worker.js';

@Module({
  providers: [
    AnomalyQueue,
    AnomalyProcessor,
    AnomalyWorker,
    AnomalyInterceptor,
    AnomalyEventsService,
    LlmGuardrails,
    LlmService,
    {
      provide: LLM_PROVIDER_TOKEN,
      inject: [ENV],
      useFactory: (env: Env) => createProviderOrDisabled(env),
    },
  ],
  exports: [
    AnomalyQueue,
    AnomalyWorker,
    AnomalyInterceptor,
    AnomalyEventsService,
    LlmService,
    LLM_PROVIDER_TOKEN,
  ],
})
export class AnomalyModule {}
