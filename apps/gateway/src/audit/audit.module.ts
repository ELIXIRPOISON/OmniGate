import { Global, Module } from '@nestjs/common';
import { AuditMaintenance } from './audit-maintenance.js';
import { AuditWriter } from './audit-writer.service.js';
import { AuditMiddleware } from './audit.middleware.js';

/** Global so the problem filter and any module can reach the writer without an import cycle. */
@Global()
@Module({
  providers: [AuditWriter, AuditMiddleware, AuditMaintenance],
  exports: [AuditWriter, AuditMiddleware],
})
export class AuditModule {}
