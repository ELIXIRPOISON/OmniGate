import { Module } from '@nestjs/common';
import { CacheInterceptor } from './cache.interceptor.js';
import { CacheService } from './cache.service.js';

@Module({
  providers: [CacheService, CacheInterceptor],
  exports: [CacheService, CacheInterceptor],
})
export class CacheModule {}
