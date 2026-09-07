import { Module } from '@nestjs/common';
import { ApiKeyService } from './api-key.service.js';
import { AuthGuard } from './auth.guard.js';
import { JwtVerifier } from './jwt.verifier.js';

@Module({
  providers: [JwtVerifier, ApiKeyService, AuthGuard],
  exports: [JwtVerifier, ApiKeyService, AuthGuard],
})
export class AuthModule {}
