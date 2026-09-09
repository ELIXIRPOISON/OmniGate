import { Inject, Injectable } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import {
  createProxyMiddleware,
  type RequestHandler,
} from 'http-proxy-middleware';
import type { ClientRequest } from 'node:http';
import type { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { format } from 'node:util';
import { PinoLogger } from 'nestjs-pino';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { pathOf, type GatewayRequest } from '../common/gateway-request.js';
import { formatPrincipal } from '@omnigate/shared';
import { Problems, sendProblem } from '../common/problem/problem.js';
import { ensureRequestId } from '../common/request-id.js';
import { prepareUpstreamHeaders } from './headers.js';

interface ProxyState {
  timedOut: boolean;
  startedAt: number;
  proxyReq?: ClientRequest;
  timer?: NodeJS.Timeout;
}

/** Error codes that mean "could not talk to the upstream at all" -> 502. Anything else is still 502, just worded differently. */
const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EPIPE',
]);

/**
 * Step 7 of the lifecycle (docs/02 §3): stream the request to the resolved upstream.
 * Bodies are never parsed here (Nest body parsing is disabled for the app), so any method and
 * content type passes through untouched. 502 on connection failure, 504 when the upstream sends
 * no response headers within the route's timeout.
 */
@Injectable()
export class ProxyService {
  private readonly proxy: RequestHandler<GatewayRequest, Response>;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ProxyService.name);
    this.proxy = createProxyMiddleware<GatewayRequest, Response>({
      router: (req) => this.resolved(req).route.upstream,
      pathRewrite: (_path, req) => this.resolved(req).upstreamPath,
      changeOrigin: true,
      // X-Forwarded-* are written by prepareUpstreamHeaders so the trust-proxy rule is applied.
      xfwd: false,
      ws: false,
      logger: {
        info: (...args: unknown[]) => this.logger.debug(format(...args)),
        warn: (...args: unknown[]) => this.logger.warn(format(...args)),
        error: (...args: unknown[]) => this.logger.error(format(...args)),
      },
      on: {
        proxyReq: (proxyReq, req, res) => {
          const state = this.state(res);
          state.proxyReq = proxyReq;
          if (state.timedOut) {
            proxyReq.destroy();
            return;
          }
          // The pre-screen consumed the stream; send the exact bytes it buffered (docs/08 R4).
          if (req.rawBody !== undefined) {
            proxyReq.removeHeader('transfer-encoding');
            proxyReq.setHeader('content-length', String(req.rawBody.length));
            if (req.rawBody.length > 0) proxyReq.write(req.rawBody);
          }
        },
        proxyRes: (_proxyRes, _req, res) => {
          const state = this.state(res);
          clearTimeout(state.timer);
          res.locals.upstream_ms = Math.round(
            performance.now() - state.startedAt,
          );
        },
        error: (err, req, res) =>
          this.onError(err as NodeJS.ErrnoException, req, res),
      },
    });
  }

  async forward(
    req: GatewayRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const { route } = this.resolved(req);
    const requestId = ensureRequestId(req, res);

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > this.env.MAX_BODY_BYTES) {
      throw Problems.badRequest(
        `Request body of ${declared} bytes exceeds the limit of ${this.env.MAX_BODY_BYTES} bytes`,
      );
    }

    prepareUpstreamHeaders(req.headers, {
      requestId,
      remoteAddress: req.socket.remoteAddress ?? 'unknown',
      protocol: req.protocol,
      host: req.headers.host,
      trustProxy: this.env.TRUST_PROXY,
      principal: req.principal ? formatPrincipal(req.principal) : undefined,
    });

    const state = this.state(res);
    state.startedAt = performance.now();
    state.timer = setTimeout(
      () => this.onTimeout(req, res, route.timeout_ms),
      route.timeout_ms,
    );
    res.once('close', () => clearTimeout(state.timer));

    try {
      await this.proxy(req, res, next);
    } catch (err) {
      this.onError(err as NodeJS.ErrnoException, req, res);
    }
  }

  private resolved(req: GatewayRequest) {
    if (!req.gw)
      throw new Error('ProxyService.forward called before route resolution');
    return req.gw;
  }

  private state(res: Response): ProxyState {
    const locals = res.locals as { __proxy?: ProxyState };
    locals.__proxy ??= { timedOut: false, startedAt: performance.now() };
    return locals.__proxy;
  }

  private onTimeout(
    req: GatewayRequest,
    res: Response,
    timeoutMs: number,
  ): void {
    const state = this.state(res);
    state.timedOut = true;
    this.logger.warn(
      {
        request_id: req.id,
        service: req.gw?.service,
        upstream: req.gw?.route.upstream,
        timeout_ms: timeoutMs,
      },
      'upstream timed out',
    );
    sendProblem(
      res,
      Problems.gatewayTimeout(`Upstream did not respond within ${timeoutMs} ms`)
        .problem,
      ensureRequestId(req, res),
      pathOf(req.originalUrl),
    );
    state.proxyReq?.destroy();
  }

  private onError(
    err: NodeJS.ErrnoException,
    req: GatewayRequest,
    res: Response | Socket,
  ): void {
    if (!('setHeader' in res)) {
      (res as Socket).destroy();
      return;
    }
    const state = this.state(res);
    clearTimeout(state.timer);
    if (state.timedOut) return; // 504 already written

    const code = err.code ?? err.name ?? 'UNKNOWN';
    this.logger.warn(
      {
        request_id: req.id,
        service: req.gw?.service,
        upstream: req.gw?.route.upstream,
        code,
        err_message: err.message,
      },
      'upstream request failed',
    );

    if (res.headersSent) {
      // Failed mid-stream: the status is already on the wire, so the only honest option is to cut the connection.
      res.destroy();
      return;
    }
    const problem =
      code === 'ETIMEDOUT'
        ? Problems.gatewayTimeout('Upstream connection timed out').problem
        : Problems.badGateway(
            UNREACHABLE.has(code)
              ? `Upstream unreachable (${code})`
              : `Upstream request failed (${code})`,
          ).problem;
    sendProblem(
      res,
      problem,
      ensureRequestId(req, res),
      pathOf(req.originalUrl),
    );
  }
}
