import { Inject, Injectable } from '@nestjs/common';
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type KeyObject,
} from 'jose';
import type { Principal } from '@omnigate/shared';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { AuthError } from './auth-error.js';

export interface JwtVerifierOptions {
  /** HS256 shared secret (JWT_SECRET). */
  hsSecret?: string;
  /** RS256 key resolver, normally createRemoteJWKSet(JWT_JWKS_URL). Injectable for tests. */
  jwks?: JWTVerifyGetKey;
  /** Accepted clock skew in seconds for exp/nbf/iat (T1: <= 60 s). */
  clockToleranceSeconds?: number;
}

/** Turn the `scope` (space-delimited, RFC 8693) or `scp`/`scopes` (array) claim into a string list. */
export function scopesFromClaims(payload: JWTPayload): string[] {
  const raw = payload.scope ?? payload.scp ?? payload.scopes;
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  if (Array.isArray(raw))
    return raw.filter((s): s is string => typeof s === 'string');
  return [];
}

@Injectable()
export class JwtVerifier {
  private readonly hsKey?: Uint8Array | KeyObject;
  private readonly jwks?: JWTVerifyGetKey;
  private readonly clockTolerance: number;

  constructor(@Inject(ENV) env: Env | JwtVerifierOptions) {
    const opts: JwtVerifierOptions = isEnv(env)
      ? {
          hsSecret: env.JWT_SECRET,
          jwks: env.JWT_JWKS_URL
            ? createRemoteJWKSet(new URL(env.JWT_JWKS_URL))
            : undefined,
        }
      : env;
    this.hsKey = opts.hsSecret
      ? new TextEncoder().encode(opts.hsSecret)
      : undefined;
    this.jwks = opts.jwks;
    this.clockTolerance = opts.clockToleranceSeconds ?? 60;
  }

  /** Verify signature, exp/nbf and required claims; return the user principal. */
  async verify(token: string): Promise<Principal> {
    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      throw new AuthError('malformed', 'Malformed bearer token');
    }

    // The algorithm is pinned per key type; `none` and mismatched algorithms can never verify (T1).
    let key: Uint8Array | KeyObject | JWTVerifyGetKey;
    if (alg === 'HS256' && this.hsKey) key = this.hsKey;
    else if (alg === 'RS256' && this.jwks) key = this.jwks;
    else
      throw new AuthError(
        'unsupported',
        `Unsupported token algorithm "${alg ?? 'none'}"`,
      );

    try {
      const { payload } = await jwtVerify(token, key as Uint8Array, {
        algorithms: [alg],
        clockTolerance: this.clockTolerance,
        requiredClaims: ['sub', 'exp'],
      });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new AuthError('invalid', 'Token has no subject');
      }
      return {
        type: 'user',
        id: payload.sub,
        scopes: scopesFromClaims(payload),
      };
    } catch (err) {
      if (err instanceof AuthError) throw err;
      if (err instanceof joseErrors.JWTExpired)
        throw new AuthError('expired', 'Token expired');
      if (
        err instanceof joseErrors.JWKSNoMatchingKey ||
        err instanceof joseErrors.JWKSTimeout
      ) {
        throw new AuthError('invalid', 'Token signed by an unknown key');
      }
      throw new AuthError('invalid', 'Invalid token');
    }
  }
}

function isEnv(value: Env | JwtVerifierOptions): value is Env {
  return 'REDIS_URL' in value;
}
