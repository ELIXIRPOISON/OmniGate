import { describe, expect, it } from 'vitest';
import { parameterFields, parameterNames } from './params.js';
import {
  EMPTY_SCHEMA,
  UNBOUNDED_MARKER,
  unknownParamSignal,
  valueShapeSignal,
  shapeOf,
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
  shapes: new Map(),
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
      shapes: new Map(),
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

describe('valueShapeSignal', () => {
  const shapesOn: SchemaConfig = { ...config, valueShapes: true };
  /** A route that has only ever seen digits in `id` and letters in `modo`. */
  const withShapes = (): RouteSchema => ({
    known: new Set(['id', 'modo']),
    shapes: new Map([
      ['id', { shapes: 1 << shapeOf('42'), maxLength: 4 }],
      ['modo', { shapes: 1 << shapeOf('registro'), maxLength: 8 }],
    ]),
    observations: 1_000,
    unbounded: false,
  });
  const f = (name: string, value: string) => [{ name, value }];

  it('is off unless the operator turns it on', () => {
    // It is the only signal with a non-zero false-positive count, so it is not a default.
    expect(valueShapeSignal(f('id', "1' OR 1=1--"), withShapes(), config)).toBe(0);
  });

  it('accepts a value shaped like what the parameter has carried', () => {
    expect(valueShapeSignal(f('id', '1234'), withShapes(), shapesOn)).toBe(0);
    expect(valueShapeSignal(f('modo', 'insertar'), withShapes(), shapesOn)).toBe(0);
  });

  it('flags a value whose character make-up is new for that parameter', () => {
    expect(valueShapeSignal(f('id', "1' OR 1=1--"), withShapes(), shapesOn)).toBe(0.85);
    expect(
      valueShapeSignal(
        [
          { name: 'id', value: "1'--" },
          { name: 'modo', value: '<script>' },
        ],
        withShapes(),
        shapesOn,
      ),
    ).toBe(1);
  });

  it('flags a value far longer than anything seen, even in the right shape', () => {
    expect(valueShapeSignal(f('id', '1'.repeat(200)), withShapes(), shapesOn)).toBe(0.85);
    // Ordinary growth is not an alert: the ceiling leaves room above the longest seen value.
    expect(valueShapeSignal(f('id', '12345'), withShapes(), shapesOn)).toBe(0);
  });

  it('leaves unknown names to the other signal rather than double-counting them', () => {
    expect(valueShapeSignal(f('idA', "1' OR 1=1"), withShapes(), shapesOn)).toBe(0);
  });

  it('says nothing about a parameter it has no profile for', () => {
    const noProfile: RouteSchema = { ...withShapes(), shapes: new Map() };
    expect(valueShapeSignal(f('id', "1' OR 1=1"), noProfile, shapesOn)).toBe(0);
  });

  it('is silent during warmup', () => {
    const cold: RouteSchema = { ...withShapes(), observations: 10 };
    expect(valueShapeSignal(f('id', "1' OR 1=1"), cold, shapesOn)).toBe(0);
  });
});

describe('parameterFields', () => {
  it('carries values alongside names, decoded', () => {
    expect(
      parameterFields({ query: 'id=2&nombre=Jam%C3%B3n+Ib%C3%A9rico', bodyText: null }),
    ).toEqual([
      { name: 'id', value: '2' },
      { name: 'nombre', value: 'Jam\u00f3n Ib\u00e9rico' },
    ]);
  });

  it('keeps a latin-1 percent-encoded value rather than dropping the field', () => {
    // CSIC 2010 is latin-1, and plenty of real traffic is not valid UTF-8 either. A value that
    // cannot be decoded is kept raw: losing the field would blind both schema signals.
    expect(parameterFields({ query: 'nombre=Jam%F3n', bodyText: null })).toEqual([
      { name: 'nombre', value: 'Jam%F3n' },
    ]);
  });
});
