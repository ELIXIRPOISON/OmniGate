import {
  buildCacheKey,
  cacheIndexKey,
  cacheLockKey,
  normalizeQuery,
} from './cache-key.js';

describe('normalizeQuery', () => {
  it('sorts by name then value and drops the leading ?', () => {
    expect(normalizeQuery('?b=2&a=1')).toBe('a=1&b=2');
    expect(normalizeQuery('a=1&b=2')).toBe('a=1&b=2');
    expect(normalizeQuery('?x=2&x=1')).toBe('x=1&x=2');
    expect(normalizeQuery('')).toBe('');
    expect(normalizeQuery('?')).toBe('');
  });
});

describe('buildCacheKey', () => {
  const base = { method: 'GET', path: '/api/mock/items', query: '?b=2&a=1' };

  it('is stable across query order and case of the method', () => {
    const a = buildCacheKey('mock', base);
    const b = buildCacheKey('mock', {
      ...base,
      method: 'get',
      query: '?a=1&b=2',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^cache:mock:[0-9a-f]{40}$/);
  });

  it('changes with path, principal, accept header and route', () => {
    const a = buildCacheKey('mock', base);
    expect(
      buildCacheKey('mock', { ...base, path: '/api/mock/other' }),
    ).not.toBe(a);
    expect(
      buildCacheKey('mock', { ...base, principal: 'user:alice' }),
    ).not.toBe(a);
    expect(buildCacheKey('mock', { ...base, accept: 'text/html' })).not.toBe(a);
    expect(buildCacheKey('orders', base)).not.toBe(a);
  });

  it('derives index and lock keys', () => {
    expect(cacheIndexKey('mock')).toBe('cache:idx:mock');
    expect(cacheLockKey('cache:mock:abc')).toBe('lock:cache:mock:abc');
  });
});
