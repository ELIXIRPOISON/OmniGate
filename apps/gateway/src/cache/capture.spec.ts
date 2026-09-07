import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { captureResponse, type CapturedResponse } from './capture.js';

async function roundTrip(
  maxBytes: number,
  write: (res: import('node:http').ServerResponse) => void,
) {
  let captured: CapturedResponse | undefined;
  const server: Server = createServer((_req, res) => {
    captureResponse(res, maxBytes, (c) => (captured = c));
    write(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}/`);
  const text = await response.text();
  await new Promise<void>((r) => server.close(() => r()));
  return { captured: captured!, text, status: response.status };
}

describe('captureResponse', () => {
  it('records status, headers and the concatenated body without altering the response', async () => {
    const { captured, text, status } = await roundTrip(1024, (res) => {
      res.statusCode = 203;
      res.setHeader('content-type', 'text/plain');
      res.write('hello ');
      res.write(Buffer.from('wor'));
      res.end('ld');
    });
    expect(status).toBe(203);
    expect(text).toBe('hello world');
    expect(captured.status).toBe(203);
    expect(captured.headers['content-type']).toBe('text/plain');
    expect(captured.body?.toString()).toBe('hello world');
  });

  it('abandons capture (body null) but keeps streaming when the body exceeds maxBytes', async () => {
    const big = 'x'.repeat(5000);
    const { captured, text } = await roundTrip(1000, (res) => {
      res.write(big);
      res.end(big);
    });
    expect(text).toHaveLength(10000);
    expect(captured.body).toBeNull();
  });

  it('handles end() without a body', async () => {
    const { captured, text } = await roundTrip(1000, (res) => {
      res.statusCode = 204;
      res.end();
    });
    expect(text).toBe('');
    expect(captured.status).toBe(204);
    expect(captured.body?.length).toBe(0);
  });
});
