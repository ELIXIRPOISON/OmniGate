/** Names only, never values: the schema records what a route accepts, not what anyone sent. */
const MAX_NAMES = 64;
const MAX_NAME_LENGTH = 64;

const clean = (name: string): string | null => {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) return null;
  return trimmed;
};

/** `a=1&b[0]=2` -> `a`, `b[0]`. Decoding failures keep the raw name rather than dropping the field. */
function fromUrlEncoded(source: string, into: Set<string>): void {
  for (const pair of source.split('&')) {
    if (into.size >= MAX_NAMES) return;
    const eq = pair.indexOf('=');
    const raw = eq === -1 ? pair : pair.slice(0, eq);
    if (raw.length === 0) continue;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw.replace(/\+/g, ' '));
    } catch {
      /* malformed percent-encoding is itself interesting; keep the raw form */
    }
    const name = clean(decoded);
    if (name) into.add(name);
  }
}

/**
 * Parameter names carried by a request: query string plus, for form and JSON bodies, the top level
 * of the body.
 *
 * Nested JSON is deliberately not walked. A schema of top-level keys is cheap, bounded and stable;
 * walking arbitrary nesting invites unbounded name sets and false positives on legitimately dynamic
 * payloads, which is the failure mode that makes this kind of signal unusable in production.
 */
export function parameterNames(input: {
  query: string;
  bodyText: string | null;
  contentType?: string;
}): string[] {
  const names = new Set<string>();
  fromUrlEncoded(input.query.replace(/^\?/, ''), names);

  const body = input.bodyText;
  const type = (input.contentType ?? '').toLowerCase();
  if (body && body.length > 0) {
    if (type.includes('application/x-www-form-urlencoded')) {
      fromUrlEncoded(body, names);
    } else if (type.includes('json')) {
      try {
        const parsed: unknown = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const key of Object.keys(parsed)) {
            if (names.size >= MAX_NAMES) break;
            const name = clean(key);
            if (name) names.add(name);
          }
        }
      } catch {
        /* unparseable JSON contributes no names; the entropy signal covers that case */
      }
    }
  }

  return [...names];
}
