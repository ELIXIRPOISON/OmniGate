import {
  redactBody,
  redactHeaders,
  redactJson,
  redactQuery,
  redactText,
  REDACTED,
  UNPARSEABLE,
} from './redactor.js';

describe('redactText', () => {
  it('masks emails, card-like and phone-like digit runs but keeps ordinary numbers', () => {
    expect(redactText('mail alice@example.com now')).toBe('mail [EMAIL] now');
    expect(redactText('card 4111 1111 1111 1111 ok')).toBe('card [NUM] ok');
    expect(redactText('4111111111111111')).toBe('[NUM]');
    expect(redactText('call 9876543210')).toBe('call [NUM]');
    expect(redactText('order 12345 qty 2 price 19.99')).toBe(
      'order 12345 qty 2 price 19.99',
    );
  });
});

describe('redactJson', () => {
  it('masks values under sensitive keys at any depth and text-redacts strings', () => {
    const out = redactJson({
      user: {
        email: 'a@b.co',
        password: 'hunter2',
        profile: { ssn: '123', nested: [{ token: 'x' }, 'ok'] },
      },
      cardNumber: '4111111111111111',
      note: 'ping 9876543210',
      count: 3,
    }) as Record<string, unknown>;
    expect(out).toEqual({
      user: {
        email: '[EMAIL]',
        password: REDACTED,
        profile: { ssn: REDACTED, nested: [{ token: REDACTED }, 'ok'] },
      },
      cardNumber: REDACTED,
      note: 'ping [NUM]',
      count: 3,
    });
  });
});

describe('redactHeaders', () => {
  it('replaces credential headers and redacts the rest', () => {
    expect(
      redactHeaders({
        authorization: 'Bearer abc',
        cookie: 'sid=1',
        'x-api-key': 'gw_live_x',
        'user-agent': 'curl/8 a@b.co',
        accept: '*/*',
      }),
    ).toEqual({
      authorization: REDACTED,
      cookie: REDACTED,
      'x-api-key': REDACTED,
      'user-agent': 'curl/8 [EMAIL]',
      accept: '*/*',
    });
  });
});

describe('redactQuery', () => {
  it('masks sensitive parameters, redacts values and truncates to 500 chars', () => {
    expect(redactQuery('?id=1&token=abc&email=a@b.co')).toBe(
      `id=1&token=${REDACTED}&email=[EMAIL]`,
    );
    const long = redactQuery('?q=' + 'x'.repeat(600));
    expect(long.length).toBeLessThan(520);
    expect(long.endsWith('…[truncated]')).toBe(true);
    expect(redactQuery('')).toBe('');
  });
});

describe('redactBody', () => {
  it('handles JSON, forms, plain text, binary, empty and garbage without throwing', () => {
    expect(
      redactBody(
        Buffer.from('{"password":"p","name":"Bob","email":"b@x.io"}'),
        'application/json',
      ),
    ).toBe(`{"password":"${REDACTED}","name":"Bob","email":"[EMAIL]"}`);
    expect(
      redactBody('user=a%40b.co&secret=1', 'application/x-www-form-urlencoded'),
    ).toBe(`user=[EMAIL]&secret=${REDACTED}`);
    expect(redactBody('hello 4111111111111111', 'text/plain')).toBe(
      'hello [NUM]',
    );
    expect(redactBody(Buffer.from([0, 1, 2, 3]), 'image/png')).toBe(
      '[BINARY 4 bytes image/png]',
    );
    expect(redactBody(Buffer.alloc(0), 'application/json')).toBe('');
    expect(redactBody(null)).toBe('');
    expect(redactBody('{not json', 'application/json')).toBe('{not json');
  });

  it('truncates long bodies to 2,000 characters', () => {
    const out = redactBody(
      JSON.stringify({ data: 'y'.repeat(5000) }),
      'application/json',
    );
    expect(out.length).toBeLessThanOrEqual(2000 + '…[truncated]'.length);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  it('falls back to [UNPARSEABLE] on internal errors', () => {
    const evil = {
      toString: () => {
        throw new Error('boom');
      },
    } as unknown as string;
    expect(redactBody(evil, 'text/plain')).toBe(UNPARSEABLE);
  });
});
