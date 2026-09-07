import type { IncomingMessage, ServerResponse } from 'node:http';
import { ensureRequestId, isValidRequestId } from './request-id.js';

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}
function fakeRes() {
  const headers = new Map<string, string>();
  return {
    headersSent: false,
    getHeader: (k: string) => headers.get(k.toLowerCase()),
    setHeader: (k: string, v: string) => headers.set(k.toLowerCase(), v),
    headers,
  } as unknown as ServerResponse & { headers: Map<string, string> };
}

describe('ensureRequestId', () => {
  it('reuses a valid inbound id and mirrors it on the response', () => {
    const req = fakeReq({ 'x-request-id': 'abc-123' });
    const res = fakeRes();
    expect(ensureRequestId(req, res)).toBe('abc-123');
    expect(res.headers.get('x-request-id')).toBe('abc-123');
  });

  it('mints a uuid when the inbound id is missing or malformed', () => {
    const uuid = /^[0-9a-f-]{36}$/;
    const res = fakeRes();
    expect(ensureRequestId(fakeReq(), res)).toMatch(uuid);
    expect(
      ensureRequestId(fakeReq({ 'x-request-id': 'has spaces!' }), fakeRes()),
    ).toMatch(uuid);
    expect(
      ensureRequestId(fakeReq({ 'x-request-id': 'x'.repeat(65) }), fakeRes()),
    ).toMatch(uuid);
  });

  it('is idempotent and rewrites the inbound header for forwarding', () => {
    const req = fakeReq();
    const res = fakeRes();
    const first = ensureRequestId(req, res);
    expect(ensureRequestId(req, res)).toBe(first);
    expect(req.headers['x-request-id']).toBe(first);
  });
});

describe('isValidRequestId', () => {
  it.each(['a', 'trace-1:2.3_4', '01J8ZX', 'x'.repeat(64)])(
    'accepts %s',
    (v) => {
      expect(isValidRequestId(v)).toBe(true);
    },
  );
  it.each(['', ' a', 'a b', '-lead', 'x'.repeat(65), 42, undefined])(
    'rejects %s',
    (v) => {
      expect(isValidRequestId(v)).toBe(false);
    },
  );
});
