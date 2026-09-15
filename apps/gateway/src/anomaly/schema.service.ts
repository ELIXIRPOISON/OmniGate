import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { RedisService } from '../redis/redis.service.js';
import { noisyOr, type SignalScores } from './heuristics.js';
import type { ParamField } from './params.js';

/**
 * The score used to decide whether a successful request may teach the schema.
 *
 * It must exclude the schema's own signal. Once a route is warm, a request carrying a genuinely new
 * parameter fires `unknown_param` and clears the gate on that alone, so gating learning on the full
 * score meant no new name could ever be observed, let alone promoted: drift handling was dead on
 * arrival. Judging learnability on every *other* signal restores the intended rule - two independent
 * judges, the upstream's 2xx and the pattern/behavioural pass - without letting the schema veto its
 * own updates.
 */
export function learnableScore(signals: SignalScores): number {
  return noisyOr({ ...signals, unknown_param: 0 });
}

/**
 * Per-route parameter schema, learned from traffic.
 *
 * Measured on CSIC 2010 (docs/results/anomaly-eval-csic.md): knowing which parameter names a route
 * accepts flags 50.4 percent of attacks with no false positive across 36,000 held-out normal
 * requests, against 21.0 percent for all eight pattern and behavioural signals combined. It is the
 * single strongest detector in the gateway and the cheapest.
 *
 * Everything difficult about it is in the safety rules rather than the detection:
 *
 * **Poisoning.** A schema learned from all traffic is a schema an attacker can teach. Only requests
 * that the upstream answered successfully *and* that the existing signals found unremarkable are
 * learned from, so a request has to look benign to two independent judges before it can widen the
 * schema.
 *
 * **Cold start.** An unlearned route must be silent, not loud. The signal stays off until the route
 * has contributed `warmupRequests` observations, so a fresh deployment does not alert on everything.
 *
 * **Drift.** A new API version adds a parameter, and without care every request using it becomes an
 * alert. A new name is held as a candidate and promoted only once `promotePrincipals` *distinct*
 * callers have used it successfully, which a single attacker cannot fake cheaply but a real rollout
 * satisfies immediately.
 *
 * **Unbounded growth.** Routes whose parameter names are genuinely open-ended, search facets and the
 * like, are not schema-able. Past `maxNames` the route is marked unbounded and the signal disables
 * itself there rather than alerting forever.
 */
export interface SchemaConfig {
  warmupRequests: number;
  promotePrincipals: number;
  maxNames: number;
  /** Learn and check value shapes as well as names. Off by default; see valueShapeSignal. */
  valueShapes?: boolean;
}

/**
 * A value's character make-up, reduced to four bits. Deliberately coarse: the question is "has this
 * parameter ever carried this *kind* of value", not "is this value in a whitelist". Anything finer
 * turns every legitimately varied field into an alert.
 */
export function shapeOf(value: string): number {
  let bits = 0;
  if (/[a-zA-Z]/.test(value)) bits |= 1;
  if (/[0-9]/.test(value)) bits |= 2;
  if (/[ .,\-_@]/.test(value)) bits |= 4;
  if (/[^a-zA-Z0-9 .,\-_@]/.test(value)) bits |= 8;
  return bits;
}

/** What a parameter has been seen to carry: the set of shapes, and the longest value. */
export interface ValueProfile {
  /** Bit i set means shape i has been observed. Sixteen possible shapes, so one 16-bit integer. */
  shapes: number;
  maxLength: number;
}

/** Room to grow before a value counts as out of range, so ordinary variation is not an alert. */
const lengthCeiling = (maxLength: number): number =>
  Math.max(maxLength * 3, maxLength + 20);

export interface RouteSchema {
  /** Names promoted to "this route accepts it". */
  known: Set<string>;
  /** Learned value profile per known name; empty unless value shapes are enabled. */
  shapes: Map<string, ValueProfile>;
  /** Observations learned so far; the signal stays off below the warmup threshold. */
  observations: number;
  /** Too many distinct names to model; the signal is disabled for this route. */
  unbounded: boolean;
}

const TTL_S = 30 * 24 * 3600;
const CANDIDATE_TTL_S = 7 * 24 * 3600;

const knownKey = (route: string): string => `aschema:${route}:known`;
const countKey = (route: string): string => `aschema:${route}:n`;
const candidateKey = (route: string, name: string): string =>
  `aschema:${route}:cand:${createHash('sha1').update(name).digest('hex').slice(0, 16)}`;

/** Callers are counted, never stored: a short hash is enough to count distinct ones. */
const callerTag = (principal: string): string =>
  createHash('sha1').update(principal).digest('hex').slice(0, 12);

export const EMPTY_SCHEMA: RouteSchema = {
  known: new Set(),
  shapes: new Map(),
  observations: 0,
  unbounded: false,
};

const shapeKey = (route: string): string => `aschema:${route}:shape`;
const encodeProfile = (p: ValueProfile): string => `${p.shapes}:${p.maxLength}`;
const decodeProfile = (raw: string): ValueProfile => {
  const [shapes, maxLength] = raw.split(':').map(Number);
  return {
    shapes: Number.isFinite(shapes) ? shapes : 0,
    maxLength: Number.isFinite(maxLength) ? maxLength : 0,
  };
};

@Injectable()
export class RouteSchemaService {
  constructor(
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RouteSchemaService.name);
  }

  /** One round trip on the hot path. Redis being down degrades to "no schema", never to an alert. */
  async read(route: string, withShapes = false): Promise<RouteSchema> {
    const result = await this.redis.safe(
      'route schema read',
      async (c) => {
        const tx = c.multi().smembers(knownKey(route)).get(countKey(route));
        if (withShapes) tx.hgetall(shapeKey(route));
        const results = (await tx.exec()) ?? [];
        return {
          names: (results[0]?.[1] as string[] | undefined) ?? [],
          count: Number((results[1]?.[1] as string | null) ?? 0),
          shapes: withShapes
            ? ((results[2]?.[1] as Record<string, string> | undefined) ?? {})
            : {},
        };
      },
      null,
    );
    if (!result) return EMPTY_SCHEMA;
    return {
      known: new Set(result.names),
      shapes: new Map(
        Object.entries(result.shapes).map(([name, raw]) => [
          name,
          decodeProfile(raw),
        ]),
      ),
      observations: result.count,
      unbounded: result.names.includes(UNBOUNDED_MARKER),
    };
  }

  /**
   * Learn from a request the upstream accepted and the inline pass found unremarkable. Called after
   * the response, off the request's critical path.
   */
  async observe(input: {
    route: string;
    principal: string;
    fields: ParamField[];
    config: SchemaConfig;
  }): Promise<void> {
    const { route, principal, fields, config } = input;
    const schema = await this.read(route, config.valueShapes === true);
    if (schema.unbounded) return;

    const names = fields.map((f) => f.name);
    const unknown = names.filter((n) => !schema.known.has(n));
    const tag = callerTag(principal);

    // Value profiles are only learned for names the route already accepts, so a parameter cannot
    // have a shape before it has a name.
    if (config.valueShapes) {
      const widened = new Map<string, ValueProfile>();
      for (const { name, value } of fields) {
        if (!schema.known.has(name)) continue;
        const current = schema.shapes.get(name) ?? { shapes: 0, maxLength: 0 };
        const next: ValueProfile = {
          shapes: current.shapes | (1 << shapeOf(value)),
          maxLength: Math.max(current.maxLength, value.length),
        };
        if (next.shapes !== current.shapes || next.maxLength !== current.maxLength)
          widened.set(name, next);
      }
      if (widened.size > 0)
        await this.redis.safe(
          'route schema shapes',
          async (c) => {
            const tx = c.multi();
            for (const [name, profile] of widened)
              tx.hset(shapeKey(route), name, encodeProfile(profile));
            tx.expire(shapeKey(route), TTL_S);
            await tx.exec();
          },
          null,
        );
    }

    await this.redis.safe(
      'route schema observe',
      async (c) => {
        const tx = c.multi();
        tx.incr(countKey(route));
        tx.expire(countKey(route), TTL_S);

        for (const name of unknown) {
          const key = candidateKey(route, name);
          tx.sadd(key, tag);
          tx.expire(key, CANDIDATE_TTL_S);
        }
        await tx.exec();

        // Promote candidates that enough distinct callers have used successfully.
        for (const name of unknown) {
          const key = candidateKey(route, name);
          const distinct = await c.scard(key);
          if (distinct < config.promotePrincipals) continue;
          const size = await c.scard(knownKey(route));
          if (size >= config.maxNames) {
            await c.sadd(knownKey(route), UNBOUNDED_MARKER);
            this.logger.warn(
              { route, names: size },
              'route has too many distinct parameter names to model; schema signal disabled for it',
            );
            return;
          }
          await c
            .multi()
            .sadd(knownKey(route), name)
            .expire(knownKey(route), TTL_S)
            .del(key)
            .exec();
        }
      },
      null,
    );
  }
}

/**
 * Stored in the known-names set to mark a route as unmodellable. A real parameter name cannot
 * collide with it: the space is reserved and names are trimmed non-empty strings.
 */
export const UNBOUNDED_MARKER = ' unbounded';

/**
 * Values that do not look like anything this parameter has carried before.
 *
 * Off by default, and the reason is in the measurement. On CSIC 2010 it takes recall from 0.494 to
 * 0.891, which is the largest single gain available, but it is the first signal in the gateway with
 * a non-zero false-positive count: 28 in 36,000 held-out benign requests against zero for everything
 * else. At a 0.1 percent attack rate that trades precision 0.856 for 0.533.
 *
 * That is a real choice rather than an obvious win, so the operator makes it: `SCHEMA_VALUE_SHAPES`.
 * Enable it where missing an attack costs more than chasing a false one.
 */
export function valueShapeSignal(
  fields: ParamField[],
  schema: RouteSchema,
  config: SchemaConfig,
): number {
  if (!config.valueShapes) return 0;
  if (schema.unbounded) return 0;
  if (schema.observations < config.warmupRequests) return 0;

  let violations = 0;
  for (const { name, value } of fields) {
    // An unknown name is the other signal's business; judging its shape would double-count it.
    if (!schema.known.has(name)) continue;
    const profile = schema.shapes.get(name);
    if (!profile || profile.shapes === 0) continue;
    if ((profile.shapes & (1 << shapeOf(value))) === 0) violations++;
    else if (value.length > lengthCeiling(profile.maxLength)) violations++;
  }
  if (violations === 0) return 0;
  return violations === 1 ? 0.85 : 1;
}

/**
 * The signal itself, kept pure so it is testable without Redis.
 *
 * Silent during warmup and on unbounded routes. Otherwise one unknown name is already strong
 * evidence, since the whole point is that the route has never legitimately accepted it.
 */
export function unknownParamSignal(
  names: string[],
  schema: RouteSchema,
  config: SchemaConfig,
): number {
  if (schema.unbounded) return 0;
  if (schema.observations < config.warmupRequests) return 0;
  if (names.length === 0) return 0;
  const unknown = names.filter((n) => !schema.known.has(n)).length;
  if (unknown === 0) return 0;
  return unknown === 1 ? 0.85 : 1;
}
