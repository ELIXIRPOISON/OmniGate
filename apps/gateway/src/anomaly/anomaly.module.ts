import { Module } from '@nestjs/common';
import { AnomalyInterceptor } from './anomaly.interceptor.js';
import { AnomalyProcessor } from './queue/anomaly.processor.js';
import { AnomalyQueue } from './queue/anomaly.queue.js';
import { AnomalyWorker } from './queue/anomaly.worker.js';

@Module({
  providers: [
    AnomalyQueue,
    AnomalyProcessor,
    AnomalyWorker,
    AnomalyInterceptor,
  ],
  exports: [AnomalyQueue, AnomalyWorker, AnomalyInterceptor],
})
export class AnomalyModule {}
