import {
  API_KEY_REGEX,
  generateApiKey,
  hashApiKey,
  hashesMatch,
  isApiKeyFormat,
  lookupPrefixOf,
} from './api-key.js';

describe('api-key primitives', () => {
  it('generates keys in the documented format with a 16-char lookup prefix', () => {
    const k = generateApiKey('pepper');
    expect(k.raw).toMatch(API_KEY_REGEX);
    expect(k.prefix).toBe(k.raw.slice(0, 16));
    expect(k.prefix.startsWith('gw_live_')).toBe(true);
    expect(k.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never repeats and spreads over the alphabet', () => {
    const keys = new Set(
      Array.from({ length: 200 }, () => generateApiKey('p').raw),
    );
    expect(keys.size).toBe(200);
    const chars = new Set([...keys].join('').slice(8));
    expect(chars.size).toBeGreaterThan(40);
  });

  it('hashes deterministically and depends on the pepper', () => {
    const raw = generateApiKey('p1').raw;
    expect(hashApiKey(raw, 'p1')).toBe(hashApiKey(raw, 'p1'));
    expect(hashApiKey(raw, 'p1')).not.toBe(hashApiKey(raw, 'p2'));
  });

  it('compares hashes in constant time and rejects length mismatches', () => {
    const h = hashApiKey('gw_live_x', 'p');
    expect(hashesMatch(h, h)).toBe(true);
    expect(hashesMatch(h, h.slice(0, -2) + '00')).toBe(false);
    expect(hashesMatch(h, h.slice(0, 10))).toBe(false);
    expect(hashesMatch('', '')).toBe(false);
  });

  it('validates the wire format strictly', () => {
    expect(isApiKeyFormat('gw_live_' + 'a'.repeat(32))).toBe(true);
    expect(isApiKeyFormat('gw_live_' + 'a'.repeat(31))).toBe(false);
    expect(isApiKeyFormat('gw_test_' + 'a'.repeat(32))).toBe(false);
    expect(isApiKeyFormat('gw_live_' + 'a'.repeat(31) + '!')).toBe(false);
    expect(isApiKeyFormat(undefined)).toBe(false);
    expect(lookupPrefixOf('gw_live_abcdefgh' + 'z'.repeat(24))).toBe(
      'gw_live_abcdefgh',
    );
  });
});
