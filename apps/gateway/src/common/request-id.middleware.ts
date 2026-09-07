import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ensureRequestId } from './request-id.js';

/** Step 1 of the request lifecycle (docs/02 §3): every request carries an id before anything else runs. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    ensureRequestId(req, res);
    next();
  }
}
