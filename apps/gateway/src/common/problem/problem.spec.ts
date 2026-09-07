import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { ProblemType } from '@omnigate/shared';
import { toProblem } from './problem-details.filter.js';
import { Problems, sendProblem } from './problem.js';

describe('toProblem', () => {
  it('passes ProblemException through untouched', () => {
    const p = toProblem(Problems.routeNotFound('nope'));
    expect(p).toMatchObject({
      type: ProblemType.RouteNotFound,
      status: 404,
      title: 'Not Found',
    });
    expect(p.detail).toContain('nope');
  });

  it('maps Nest HttpExceptions using their status and message', () => {
    expect(toProblem(new NotFoundException('Cannot GET /x'))).toMatchObject({
      type: ProblemType.NotFound,
      status: 404,
      detail: 'Cannot GET /x',
    });
    expect(toProblem(new BadRequestException(['a', 'b']))).toMatchObject({
      status: 400,
      detail: 'a; b',
    });
  });

  it('maps body-parser style errors and turns 413 into the documented 400', () => {
    expect(
      toProblem(Object.assign(new Error('too large'), { status: 413 })),
    ).toMatchObject({
      status: 400,
      type: ProblemType.BadRequest,
    });
    expect(
      toProblem(Object.assign(new Error('bad json'), { statusCode: 400 })),
    ).toMatchObject({
      status: 400,
      detail: 'bad json',
    });
  });

  it('hides details of unknown errors behind a 500', () => {
    const p = toProblem(new Error('secret internal state'));
    expect(p).toMatchObject({ status: 500, type: ProblemType.Internal });
    expect(JSON.stringify(p)).not.toContain('secret');
  });
});

describe('sendProblem', () => {
  function fakeRes() {
    const headers = new Map<string, string>();
    const res = {
      headersSent: false,
      statusCode: 200,
      body: '',
      getHeader: (k: string) => headers.get(k.toLowerCase()),
      setHeader: (k: string, v: string) => headers.set(k.toLowerCase(), v),
      end(chunk?: string) {
        this.body = chunk ?? '';
        this.headersSent = true;
      },
      headers,
    };
    return res as unknown as Response & {
      body: string;
      headers: Map<string, string>;
    };
  }

  it('writes application/problem+json with requestId, instance and Retry-After', () => {
    const res = fakeRes();
    sendProblem(
      res,
      Problems.rateLimited('slow down', 12).problem,
      'req-1',
      '/api/x',
    );
    expect(res.statusCode).toBe(429);
    expect(res.headers.get('content-type')).toContain(
      'application/problem+json',
    );
    expect(res.headers.get('retry-after')).toBe('12');
    expect(res.headers.get('x-request-id')).toBe('req-1');
    expect(JSON.parse(res.body)).toEqual({
      type: ProblemType.RateLimited,
      title: 'Too Many Requests',
      status: 429,
      detail: 'slow down',
      instance: '/api/x',
      requestId: 'req-1',
      retryAfter: 12,
    });
  });

  it('only ends the response when headers were already sent', () => {
    const res = fakeRes();
    res.headersSent = true;
    sendProblem(res, Problems.badGateway('x').problem, 'req-2');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });
});
