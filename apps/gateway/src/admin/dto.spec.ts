import { ProblemException } from '../common/problem/problem.js';
import {
  logsQuery,
  pageQuery,
  policyBody,
  resolveRange,
  upstreamIssue,
} from './dto.js';

describe('upstreamIssue (SSRF guard, T11)', () => {
  it('accepts public http(s) targets', () => {
    expect(upstreamIssue('https://api.example.com', false)).toBeNull();
    expect(upstreamIssue('http://203.0.113.10:8080/base', false)).toBeNull();
    expect(upstreamIssue('https://[2001:db8::1]', false)).toBeNull();
  });

  it('rejects non-http schemes and malformed URLs', () => {
    expect(upstreamIssue('ftp://example.com', false)).toMatch(/http/);
    expect(upstreamIssue('file:///etc/passwd', false)).toMatch(/http/);
    expect(upstreamIssue('not a url', false)).toMatch(/absolute/);
  });

  it('rejects private, loopback, link-local and metadata addresses', () => {
    for (const host of [
      'http://127.0.0.1:3001',
      'http://10.0.0.5',
      'http://172.16.4.4',
      'http://192.168.1.10',
      'http://169.254.169.254',
      'http://100.64.0.1',
      'http://[::1]',
      'http://[fd00::1]',
      'http://[fe80::1]',
      'http://localhost:3001',
      'http://db.internal',
    ]) {
      expect(upstreamIssue(host, false)).not.toBeNull();
    }
  });

  it('allows them when the deployment opts in', () => {
    expect(upstreamIssue('http://mock-upstream:3001', true)).toBeNull();
    expect(upstreamIssue('http://127.0.0.1:3001', true)).toBeNull();
  });

  it('leaves ordinary DNS names to resolution time', () => {
    expect(upstreamIssue('http://mock-upstream:3001', false)).toBeNull();
  });
});

describe('resolveRange', () => {
  it('defaults to the last hour and honours explicit bounds', () => {
    const { from, to } = resolveRange({});
    expect(to.getTime() - from.getTime()).toBe(3_600_000);
    const explicit = resolveRange({
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-09-02T00:00:00Z'),
    });
    expect(explicit.to.getTime() - explicit.from.getTime()).toBe(86_400_000);
  });

  it('rejects an inverted window as a client error', () => {
    let thrown: unknown;
    try {
      resolveRange({
        from: new Date('2026-09-02'),
        to: new Date('2026-09-01'),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProblemException);
    expect((thrown as ProblemException).problem).toMatchObject({
      status: 400,
      detail: 'from must be before to',
    });
  });
});

describe('query schemas', () => {
  it('applies documented paging defaults and caps', () => {
    expect(pageQuery.parse({})).toEqual({ page: 1, pageSize: 50 });
    expect(pageQuery.parse({ page: '3', pageSize: '10' })).toEqual({
      page: 3,
      pageSize: 10,
    });
    expect(pageQuery.safeParse({ pageSize: '5000' }).success).toBe(false);
  });

  it('caps the log explorer at 1000 rows', () => {
    expect(logsQuery.parse({}).limit).toBe(100);
    expect(logsQuery.parse({ limit: '1000' }).limit).toBe(1_000);
    expect(logsQuery.safeParse({ limit: '1001' }).success).toBe(false);
  });

  it('validates policy bodies', () => {
    expect(
      policyBody.safeParse({ name: 'p', windowSeconds: 60, maxRequests: 100 })
        .success,
    ).toBe(true);
    expect(
      policyBody.safeParse({ name: 'p', windowSeconds: 0, maxRequests: 100 })
        .success,
    ).toBe(false);
    expect(
      policyBody.safeParse({ name: '', windowSeconds: 60, maxRequests: 100 })
        .success,
    ).toBe(false);
  });
});
