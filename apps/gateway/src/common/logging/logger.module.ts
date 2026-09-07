import { Module } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { pathOf } from '../gateway-request.js';
import { ensureRequestId } from '../request-id.js';

type Res = ServerResponse & { locals?: Record<string, unknown> };
type Req = IncomingMessage & {
  gw?: { service: string };
  ip?: string;
  originalUrl?: string;
};

/** The one JSON line written per request (FR-1.4). Flat keys so log tooling needs no nesting. */
function requestSummary(req: Req, res: Res, responseTimeMs: number) {
  const upstreamMs = res.locals?.upstream_ms;
  return {
    method: req.method,
    path: pathOf(req.originalUrl ?? req.url),
    status: res.statusCode,
    latency_ms: Math.round(responseTimeMs),
    ...(req.gw ? { service: req.gw.service } : {}),
    ...(typeof upstreamMs === 'number' ? { upstream_ms: upstreamMs } : {}),
    ...(req.ip ? { client_ip: req.ip } : {}),
  };
}

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          genReqId: (req, res) => ensureRequestId(req, res),
          quietReqLogger: true,
          customAttributeKeys: { reqId: 'request_id' },
          autoLogging: {
            ignore: (req) => req.url === '/healthz' || req.url === '/readyz',
          },
          customLogLevel: (_req, res, err) =>
            err || res.statusCode >= 500
              ? 'error'
              : res.statusCode >= 400
                ? 'warn'
                : 'info',
          customSuccessMessage: () => 'request completed',
          customErrorMessage: () => 'request failed',
          customSuccessObject: (req, res, val: { responseTime: number }) =>
            requestSummary(req, res, val.responseTime),
          customErrorObject: (
            req,
            res,
            err,
            val: { responseTime: number },
          ) => ({
            ...requestSummary(req, res, val.responseTime),
            err,
          }),
          // The completion line is built by requestSummary(); drop pino-http's default `req`
          // binding so no headers (and therefore no credentials) ever reach the log.
          serializers: { req: () => undefined },
          transport:
            env.NODE_ENV === 'development'
              ? {
                  target: 'pino-pretty',
                  options: {
                    colorize: true,
                    singleLine: true,
                    translateTime: 'SYS:HH:MM:ss.l',
                  },
                }
              : undefined,
        },
      }),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
