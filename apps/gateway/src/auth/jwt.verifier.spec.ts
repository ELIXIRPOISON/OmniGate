import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AuthError } from './auth-error.js';
import { JwtVerifier, scopesFromClaims } from './jwt.verifier.js';

const secret = 's'.repeat(32);
const hs = (
  claims: Record<string, unknown>,
  opts: { exp?: string | number; secret?: string } = {},
) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(new TextEncoder().encode(opts.secret ?? secret));

describe('JwtVerifier (HS256)', () => {
  const verifier = new JwtVerifier({ hsSecret: secret });

  it('accepts a valid token and returns a user principal with scopes', async () => {
    const token = await hs({ sub: 'alice', scope: 'orders:read orders:write' });
    await expect(verifier.verify(token)).resolves.toEqual({
      type: 'user',
      id: 'alice',
      scopes: ['orders:read', 'orders:write'],
    });
  });

  it('rejects an expired token as expired', async () => {
    const token = await hs(
      { sub: 'alice' },
      { exp: Math.floor(Date.now() / 1000) - 3600 },
    );
    await expect(verifier.verify(token)).rejects.toMatchObject({
      reason: 'expired',
    });
  });

  it('tolerates up to 60 s of clock skew', async () => {
    const token = await hs(
      { sub: 'alice' },
      { exp: Math.floor(Date.now() / 1000) - 30 },
    );
    await expect(verifier.verify(token)).resolves.toMatchObject({
      id: 'alice',
    });
  });

  it('rejects a wrong secret, a missing sub and a missing exp', async () => {
    await expect(
      verifier.verify(await hs({ sub: 'a' }, { secret: 'x'.repeat(32) })),
    ).rejects.toMatchObject({ reason: 'invalid' });
    await expect(
      verifier.verify(await hs({ scope: 'x' })),
    ).rejects.toMatchObject({ reason: 'invalid' });
    const noExp = await new SignJWT({ sub: 'a' })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(secret));
    await expect(verifier.verify(noExp)).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('rejects alg=none, unsupported algorithms and garbage', async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"a"}').toString('base64url')}.`;
    await expect(verifier.verify(none)).rejects.toMatchObject({
      reason: 'unsupported',
    });
    await expect(verifier.verify('not-a-jwt')).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it('refuses RS256 tokens when no JWKS is configured', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({ sub: 'a' })
      .setProtectedHeader({ alg: 'RS256' })
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(verifier.verify(token)).rejects.toMatchObject({
      reason: 'unsupported',
    });
  });
});

describe('JwtVerifier (RS256 via JWKS)', () => {
  it('verifies against the matching kid and rejects unknown keys', async () => {
    const a = await generateKeyPair('RS256');
    const b = await generateKeyPair('RS256');
    const jwks = createLocalJWKSet({
      keys: [
        {
          ...(await exportJWK(a.publicKey)),
          kid: 'a',
          alg: 'RS256',
          use: 'sig',
        },
      ],
    });
    const verifier = new JwtVerifier({ jwks });

    const good = await new SignJWT({ sub: 'bob', scp: ['orders:read'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'a' })
      .setExpirationTime('5m')
      .sign(a.privateKey);
    await expect(verifier.verify(good)).resolves.toEqual({
      type: 'user',
      id: 'bob',
      scopes: ['orders:read'],
    });

    const rotated = await new SignJWT({ sub: 'bob' })
      .setProtectedHeader({ alg: 'RS256', kid: 'b' })
      .setExpirationTime('5m')
      .sign(b.privateKey);
    await expect(verifier.verify(rotated)).rejects.toMatchObject({
      reason: 'invalid',
    });
  });
});

describe('scopesFromClaims', () => {
  it('reads scope, scp and scopes in that order and ignores junk', () => {
    expect(scopesFromClaims({ scope: ' a  b ' })).toEqual(['a', 'b']);
    expect(scopesFromClaims({ scp: ['a', 1, 'b'] } as never)).toEqual([
      'a',
      'b',
    ]);
    expect(scopesFromClaims({ scopes: ['z'] } as never)).toEqual(['z']);
    expect(scopesFromClaims({})).toEqual([]);
  });
});
