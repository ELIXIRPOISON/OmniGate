import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Principal } from '@omnigate/shared';
import type { GatewayRequest } from '../common/gateway-request.js';
import { type ProblemException, Problems } from '../common/problem/problem.js';
import type { RouteConfig } from '../config/routes.js';
import { ApiKeyService } from './api-key.service.js';
import { AuthError } from './auth-error.js';
import { JwtVerifier } from './jwt.verifier.js';

/**
 * Step 3 of the lifecycle (docs/02 §3). Credentials are checked in the documented order:
 * `Authorization: Bearer <JWT>` first, then `X-API-Key`. Presented credentials must be valid even
 * on open routes; only a request with no credentials at all becomes the anonymous principal.
 * A route that lists `scopes` implicitly requires authentication.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtVerifier,
    private readonly apiKeys: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<GatewayRequest>();
    const route = req.gw?.route;
    if (!route)
      throw new Error(
        'AuthGuard requires RouteResolverMiddleware to run first',
      );
    req.principal = await this.authenticate(req, route);
    return true;
  }

  private async authenticate(
    req: GatewayRequest,
    route: RouteConfig,
  ): Promise<Principal> {
    const authorization = single(req.headers.authorization);
    const apiKey = single(req.headers['x-api-key']);

    try {
      if (authorization !== undefined) {
        return this.requireScopes(
          await this.jwt.verify(bearerToken(authorization)),
          route,
        );
      }
      if (apiKey !== undefined) {
        return this.requireScopes(
          await this.apiKeys.authenticate(apiKey),
          route,
        );
      }
    } catch (err) {
      throw authErrorToProblem(err);
    }

    if (route.auth_required || route.scopes.length > 0) {
      throw Problems.unauthorized(
        'Missing credentials: send Authorization: Bearer <JWT> or X-API-Key: <key>',
      );
    }
    return {
      type: 'anon',
      id: req.ip ?? req.socket.remoteAddress ?? 'unknown',
      scopes: [],
    };
  }

  private requireScopes(principal: Principal, route: RouteConfig): Principal {
    if (
      route.scopes.length > 0 &&
      !route.scopes.some((s) => principal.scopes.includes(s))
    ) {
      throw new AuthError(
        'insufficient_scope',
        `This route requires one of the scopes: ${route.scopes.join(', ')}`,
      );
    }
    return principal;
  }
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Extract the token from `Bearer <token>`; any other scheme or an empty token is rejected. */
export function bearerToken(authorization: string): string {
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(authorization);
  if (!match)
    throw new AuthError(
      'malformed',
      'Authorization header must be "Bearer <token>"',
    );
  return match[1];
}

export function authErrorToProblem(err: unknown): ProblemException | Error {
  if (!(err instanceof AuthError))
    return err instanceof Error ? err : new Error(String(err));
  switch (err.reason) {
    case 'insufficient_scope':
      return Problems.insufficientScope(err.message);
    case 'revoked':
    case 'key_expired':
      return Problems.forbidden(err.message);
    case 'unavailable':
      return Problems.serviceUnavailable(err.message);
    default:
      return Problems.unauthorized(err.message);
  }
}
