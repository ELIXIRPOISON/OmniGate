import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { ProblemType } from '@omnigate/shared';
import { pathOf } from '../gateway-request.js';
import { markProblem } from '../../audit/audit.middleware.js';
import { ensureRequestId } from '../request-id.js';
import {
  ProblemException,
  type ProblemInput,
  sendProblem,
  titleFor,
  typeFor,
} from './problem.js';

/** Map anything thrown inside the Nest pipeline to an RFC 7807 problem (FR-1.2, S1-07). */
export function toProblem(exception: unknown): ProblemInput {
  if (exception instanceof ProblemException) return exception.problem;

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();
    let detail: string | undefined;
    if (typeof response === 'string') detail = response;
    else if (
      response &&
      typeof response === 'object' &&
      'message' in response
    ) {
      const message = (response as { message: unknown }).message;
      detail = Array.isArray(message)
        ? message.map(String).join('; ')
        : String(message);
    } else detail = exception.message;
    return { type: typeFor(status), title: titleFor(status), status, detail };
  }

  // Errors raised by Express/body-parser style middleware carry a numeric status.
  const raw = (exception as { status?: unknown; statusCode?: unknown }) ?? {};
  const status = [raw.status, raw.statusCode].find(
    (s): s is number => typeof s === 'number' && s >= 400 && s <= 599,
  );
  if (status !== undefined) {
    if (status === 413) {
      return {
        type: ProblemType.BadRequest,
        title: titleFor(400),
        status: 400,
        detail: 'Request body exceeds the maximum allowed size',
      };
    }
    return {
      type: typeFor(status),
      title: titleFor(status),
      status,
      detail: status < 500 ? (exception as Error).message : undefined,
    };
  }

  return {
    type: ProblemType.Internal,
    title: titleFor(500),
    status: 500,
    detail: 'An unexpected error occurred',
  };
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(ProblemDetailsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const requestId = ensureRequestId(req, res);
    const problem = toProblem(exception);

    if (problem.status >= 500) {
      // Stack traces are logged here and never returned to the client (T7).
      this.logger.error(
        { err: exception, request_id: requestId, status: problem.status },
        'request failed with a server error',
      );
    }
    markProblem(res, problem);
    sendProblem(res, problem, requestId, pathOf(req.originalUrl ?? req.url));
  }
}
