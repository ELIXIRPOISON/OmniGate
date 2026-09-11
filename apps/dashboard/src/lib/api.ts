import type { ProblemDetails } from '@omnigate/shared';

/**
 * Admin API client. The dashboard is served from the gateway in production and proxied by Vite in
 * development, so every URL is relative and no CORS configuration is needed.
 */

const TOKEN_KEY = 'omnigate.admin.token';

/** In memory first, sessionStorage as the fallback so a refresh keeps the session but a new tab does not. */
let memoryToken: string | null = null;

export function getToken(): string | null {
  if (memoryToken) return memoryToken;
  try {
    memoryToken = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    memoryToken = null;
  }
  return memoryToken;
}

export function setToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the in-memory copy still works for this tab */
  }
}

/** An API failure carrying the RFC 7807 body the gateway returns, so the UI can show `detail`. */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: Partial<ProblemDetails>;

  constructor(status: number, problem: Partial<ProblemDetails>) {
    super(problem.detail || problem.title || `Request failed with ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
}

/** Fires when a request comes back 401 so the shell can bounce to the login screen. */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => undefined;
export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal } = options;
  const token = getToken();

  const response = await fetch(withQuery(path, query), {
    method,
    signal,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text ? safeJson(text) : undefined;

  if (!response.ok) {
    const problem = (parsed ?? {}) as Partial<ProblemDetails>;
    if (response.status === 401) {
      setToken(null);
      onUnauthorized();
    }
    throw new ApiError(response.status, problem);
  }
  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text.slice(0, 300) };
  }
}
