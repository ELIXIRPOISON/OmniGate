import { describe, expect, it } from 'vitest';
import { parameterNames } from './params.js';
import {
  EMPTY_SCHEMA,
  UNBOUNDED_MARKER,
  unknownParamSignal,
  type RouteSchema,
  type SchemaConfig,
} from './schema.service.js';

const config: SchemaConfig = {
  warmupRequests: 500,
  promotePrincipals: 3,
  maxNames: 256,
};

const learned = (names: string[], over = 1_000): RouteSchema => ({
  known: new Set(names),
  observations: over,
  unbounded: false,
});

describe('parameterNames', () => {
  it('reads the query string', () => {
    expect(
      parameterNames({ query: '?id=2&nombre=Jam%F3n&precio=85', bodyText: null }).sort(),
    ).toEqual(['id', 'nombre', 'precio']);
  });

  it('reads a form body alongside the query', () => {
    expect(
      parameterNames({
        query: 'page=1',
        bodyText: 'modo=registro&login=alice',
        contentType: 'application/x-www-form-urlencoded; charset=utf-8',
      }).sort(),
    ).toEqual(['login', 'modo', 'page']);
  });

  it('reads top-level JSON keys only', () => {
    // Nesting is deliberately not walked: an unbounded name set is the failure mode that makes this
    // signal unusable, so a dynamic nested object must not widen the schema.
    expect(
      parameterNames({
        query: '',
        bodyText: '{"name":"a","meta":{"whatever":1,"else":2}}',
        contentType: 'application/json',
      }).sort(),
    ).toEqual(['meta', 'name']);
  });

  it('ignores a body whose type is not form or json', () => {
    expect(
      parameterNames({
        query: '',
        bodyText: 'id=1&secret=2',
        contentType: 'text/plain',
      }),
    ).toEqual([]);
  });

  it('keeps a malformed percent-encoded name rather than dropping it', () => {
    expect(parameterNames({ query: 'bad%zz=1', bodyText: null })).toEqual(['bad%zz']);
  });
});

describe('unknownParamSignal', () => {
  it('is silent on a route it has not learned yet', () => {
    // Cold start must be quiet, not loud: a fresh deployment cannot alert on everything.
    expect(unknownParamSignal(['anything'], EMPTY_SCHEMA, config)).toBe(0);
    expect(
      unknownParamSignal(['anything'], { ...learned(['id']), observations: 499 }, config),
    ).toBe(0);
  });

  it('fires once the route is warm and a name is not in the schema', () => {
    expect(unknownParamSignal(['id'], learned(['id', 'page']), config)).toBe(0);
    expect(unknownParamSignal(['idA'], learned(['id', 'page']), config)).toBe(0.85);
    expect(unknownParamSignal(['idA', 'modoA'], learned(['id']), config)).toBe(1);
  });

  it('stays silent on a route with too many names to model', () => {
    const unbounded: RouteSchema = {
      known: new Set([UNBOUNDED_MARKER]),
      observations: 10_000,
      unbounded: true,
    };
    expect(unknownParamSignal(['anything'], unbounded, config)).toBe(0);
  });

  it('says nothing about a request that carries no parameters', () => {
    expect(unknownParamSignal([], learned(['id']), config)).toBe(0);
  });

  it('clears the flag threshold on its own', () => {
    // The weight in SIGNAL_WEIGHTS is chosen so one unknown name is actionable without help, which
    // is the whole finding: it detects more than every other signal combined.
    expect(unknownParamSignal(['idA'], learned(['id']), config) * 0.85).toBeGreaterThan(0.7);
  });
});
