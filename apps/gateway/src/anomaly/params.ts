/** Names only, never values: the schema records what a route accepts, not what anyone sent. */
const MAX_NAMES = 64;
const MAX_NAME_LENGTH = 64;

const clean = (name: string): string | null => {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) return null;
  return trimmed;
};

/** One parameter as sent: the name the schema is keyed on and the value its shape is learned from. */
export interface ParamField {
  name: string;
  value: string;
}

const decode = (raw: string): string => {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    // Malformed percent-encoding is itself interesting; keep the raw form rather than dropping it.
    return raw;
  }
};

/** `a=1&b[0]=2` -> `a`, `b[0]`. Decoding failures keep the raw name rather than dropping the field. */
function fromUrlEncoded(source: string, into: Map<string, string>): void {
  for (const pair of source.split('&')) {
    if (into.size >= MAX_NAMES) return;
    const eq = pair.indexOf('=');
    const raw = eq === -1 ? pair : pair.slice(0, eq);
    if (raw.length === 0) continue;
    const name = clean(decode(raw));
    if (name && !into.has(name))
      into.set(name, eq === -1 ? '' : decode(pair.slice(eq + 1)));
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
export function parameterFields(input: {
  query: string;
  bodyText: string | null;
  contentType?: string;
}): ParamField[] {
  const names = new Map<string, string>();
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
          for (const [key, value] of Object.entries(parsed)) {
            if (names.size >= MAX_NAMES) break;
            const name = clean(key);
            if (name && !names.has(name))
              names.set(
                name,
                typeof value === 'string' ? value : JSON.stringify(value),
              );
          }
        }
      } catch {
        /* unparseable JSON contributes no names; the entropy signal covers that case */
      }
    }
  }

  return [...names].map(([name, value]) => ({ name, value }));
}

/** Names alone, for the schema's promotion and membership rules. */
export function parameterNames(input: {
  query: string;
  bodyText: string | null;
  contentType?: string;
}): string[] {
  return parameterFields(input).map((f) => f.name);
}
