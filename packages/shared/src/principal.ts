/** Who is making a gateway request, as resolved by the AuthGuard. */
export type PrincipalType = 'user' | 'api_key' | 'anon';

export interface Principal {
  type: PrincipalType;
  /** JWT `sub`, API key id, or client IP for anonymous traffic. */
  id: string;
  scopes: string[];
}

/** Wire format used in the X-Gateway-Principal header and audit rows: "<type>:<id>". */
export function formatPrincipal(p: Pick<Principal, 'type' | 'id'>): string {
  return `${p.type}:${p.id}`;
}
