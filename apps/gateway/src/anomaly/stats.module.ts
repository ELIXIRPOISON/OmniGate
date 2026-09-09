import { Global, Module } from '@nestjs/common';
import { AnomalyStatsService } from './stats.service.js';

/** Global so the AuthGuard can report failed credentials without a module cycle. */
@Global()
@Module({ providers: [AnomalyStatsService], exports: [AnomalyStatsService] })
export class AnomalyStatsModule {}
