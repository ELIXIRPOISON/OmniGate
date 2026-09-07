export type AuthFailure =
  | 'missing'
  | 'malformed'
  | 'invalid'
  | 'expired'
  | 'unsupported'
  | 'revoked'
  | 'key_expired'
  | 'insufficient_scope'
  | 'unavailable';

/** Thrown by the strategies; the AuthGuard maps it to 401/403/503 problem+json. */
export class AuthError extends Error {
  constructor(
    public readonly reason: AuthFailure,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
