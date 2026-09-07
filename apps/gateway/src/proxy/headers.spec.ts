import type { IncomingHttpHeaders } from 'node:http';
import { prepareUpstreamHeaders } from './headers.js';

const ctx = {
  requestId: 'rid-1',
  remoteAddress: '10.0.0.9',
  protocol: 'http',
  host: 'gw.local:8080',
  trustProxy: false,
};

describe('prepareUpstreamHeaders', () => {
  it('strips hop-by-hop headers, Connection-listed tokens, X-API-Key and X-Gateway-*', () => {
    const headers: IncomingHttpHeaders = {
      host: 'gw.local:8080',
      connection: 'keep-alive, X-Custom-Hop',
      'keep-alive': 'timeout=5',
      'x-custom-hop': '1',
      te: 'trailers',
      'transfer-encoding': 'chunked',
      upgrade: 'h2c',
      'proxy-authorization': 'Basic x',
      'x-api-key': 'gw_live_secret',
      'x-gateway-principal': 'spoofed',
      authorization: 'Bearer keep-me',
      'content-type': 'application/json',
    };
    const out = prepareUpstreamHeaders(headers, ctx);
    for (const gone of [
      'connection',
      'keep-alive',
      'x-custom-hop',
      'te',
      'transfer-encoding',
      'upgrade',
      'proxy-authorization',
      'x-api-key',
      'x-gateway-principal',
    ]) {
      expect(out).not.toHaveProperty(gone);
    }
    expect(out.authorization).toBe('Bearer keep-me');
    expect(out['content-type']).toBe('application/json');
  });

  it('overwrites spoofed X-Forwarded-* when the proxy is not trusted', () => {
    const out = prepareUpstreamHeaders(
      {
        'x-forwarded-for': '1.2.3.4',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'evil.example',
      },
      ctx,
    );
    expect(out['x-forwarded-for']).toBe('10.0.0.9');
    expect(out['x-forwarded-proto']).toBe('http');
    expect(out['x-forwarded-host']).toBe('gw.local:8080');
  });

  it('appends to the inbound chain when the proxy is trusted', () => {
    const out = prepareUpstreamHeaders(
      { 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' },
      { ...ctx, trustProxy: true },
    );
    expect(out['x-forwarded-for']).toBe('1.2.3.4, 10.0.0.9');
    expect(out['x-forwarded-proto']).toBe('https');
  });

  it('always sets X-Request-Id to the gateway id', () => {
    const out = prepareUpstreamHeaders({ 'x-request-id': 'client-said' }, ctx);
    expect(out['x-request-id']).toBe('rid-1');
  });
});
