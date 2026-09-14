/**
 * Converts the HTTP DATASET CSIC 2010 into the evaluation format, so detection can be measured
 * against traffic this project did not write.
 *
 *   pnpm --filter @omnigate/gateway eval:import-csic -- --src <dir> --out ../../docs/eval/csic-2010.jsonl
 *
 * The dataset is 36,000 normal and 25,000 anomalous real HTTP requests against a Spanish e-commerce
 * application, published by the Spanish Research National Council. Mirrors:
 * https://gitlab.fing.edu.uy/gsi/web-application-attacks-datasets (csic_2010/).
 *
 * ## Why the behavioural features are held constant
 *
 * CSIC is a payload benchmark: individual requests with no sender identity and no timeline. There is
 * no honest way to derive "distinct paths in ten minutes" from it.
 *
 * The tempting move is to synthesise busy statistics for the anomalous rows and quiet ones for the
 * normal rows. That would leak the label straight into the features and reproduce exactly the flaw
 * that makes the project's own generated dataset untrustworthy: the detector would score perfectly by
 * reading back a number the importer wrote.
 *
 * So every row, normal and anomalous alike, gets identical, unremarkable sender statistics. The
 * behavioural signals therefore contribute the same constant to both classes and cannot separate
 * them. Whatever detection this measures comes from the payload, the path, the method and the user
 * agent, which is precisely what CSIC is evidence about. The behavioural half needs replayed logs
 * and honeypot capture instead, and is measured separately.
 */
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scoreHeuristics } from '../anomaly/heuristics.js';
import { parameterNames } from '../anomaly/params.js';
import {
  unknownParamSignal,
  type RouteSchema,
  type SchemaConfig,
} from '../anomaly/schema.service.js';
import { redactQuery, redactText, truncate } from '../anomaly/redactor.js';
import type { FeatureEnvelope } from '../anomaly/envelope.js';
import type { EvalRow } from './generate-dataset.js';

/** One parsed request from the raw dump. */
interface RawRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Identical for every row, chosen to look like an ordinary caller: a few requests, a couple of
 * distinct paths, no auth failures. Holding it constant is the point; see the note above.
 */
const NEUTRAL_STATS = {
  burstCount10s: 3,
  policyMax: 100,
  distinctPaths60s: 6,
  authFailures60s: 0,
  routeBody: null,
} as const;

const NEUTRAL_STATS_10M = { requests: 40, errorRate: 0.02, distinctPaths: 6 };

/**
 * The dump is request blocks separated by blank lines, but a POST body is itself preceded by a blank
 * line, so blocks cannot simply be split on "\n\n": a request line has to start a new block.
 */
export function parseDump(text: string): RawRequest[] {
  const out: RawRequest[] = [];
  const lines = text.split(/\r?\n/);
  const isRequestLine = (l: string) =>
    /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|TRACE|CONNECT) \S+ HTTP\/\d/.test(
      l,
    );

  let i = 0;
  while (i < lines.length) {
    if (!isRequestLine(lines[i])) {
      i++;
      continue;
    }
    const [method, url] = lines[i].split(' ');
    i++;
    const headers: Record<string, string> = {};
    while (i < lines.length && lines[i].trim() !== '') {
      const colon = lines[i].indexOf(':');
      if (colon > 0)
        headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i]
          .slice(colon + 1)
          .trim();
      i++;
    }
    i++; // the blank line that ends the headers
    // Anything before the next request line is body.
    const bodyLines: string[] = [];
    while (i < lines.length && !isRequestLine(lines[i])) {
      bodyLines.push(lines[i]);
      i++;
    }
    out.push({
      method,
      url,
      headers,
      body: bodyLines.join('\n').trim(),
    });
  }
  return out;
}

/** CSIC urls are absolute: http://localhost:8080/tienda1/publico/anadir.jsp?id=2 */
function splitUrl(url: string): { path: string; query: string } {
  const withoutOrigin = url.replace(/^https?:\/\/[^/]+/i, '');
  const q = withoutOrigin.indexOf('?');
  return q === -1
    ? { path: withoutOrigin, query: '' }
    : { path: withoutOrigin.slice(0, q), query: withoutOrigin.slice(q + 1) };
}

/**
 * The session cookie is the only sender identity the dump carries. It is used so repeated requests
 * group the way they would in production, and nothing else: it is not a label, and both classes
 * carry cookies of the same shape.
 */
function principalOf(headers: Record<string, string>, index: number): string {
  const match = /JSESSIONID=([A-Za-z0-9]+)/.exec(headers.cookie ?? '');
  return match ? `session:${match[1].slice(0, 12)}` : `anon:csic-${index % 97}`;
}

/** The app is one service, so every row shares a route; method restrictions are not part of CSIC. */
const ROUTE = 'tienda1';
const ROUTE_METHODS = ['*'];

/**
 * Learns a route schema from a corpus using the shipped functions, including the promotion rule: a
 * parameter name only counts as legitimate once `promotePrincipals` distinct callers have used it.
 * The eval therefore measures what the gateway actually does, not an idealised version of it.
 */
export function learnSchema(
  requests: RawRequest[],
  config: SchemaConfig,
): Map<string, RouteSchema> {
  const candidates = new Map<string, Map<string, Set<string>>>();
  const schemas = new Map<string, RouteSchema>();

  for (const [i, req] of requests.entries()) {
    const { path, query } = splitUrl(req.url);
    const names = parameterNames({
      query,
      bodyText: req.body || null,
      contentType: req.headers['content-type'] ?? 'application/x-www-form-urlencoded',
    });
    if (!schemas.has(path))
      schemas.set(path, { known: new Set(), observations: 0, unbounded: false });
    const schema = schemas.get(path)!;
    schema.observations++;
    if (schema.unbounded) continue;

    if (!candidates.has(path)) candidates.set(path, new Map());
    const perPath = candidates.get(path)!;
    const caller = principalOf(req.headers, i);

    for (const name of names) {
      if (schema.known.has(name)) continue;
      if (!perPath.has(name)) perPath.set(name, new Set());
      const seen = perPath.get(name)!;
      seen.add(caller);
      if (seen.size < config.promotePrincipals) continue;
      if (schema.known.size >= config.maxNames) {
        schema.unbounded = true;
        break;
      }
      schema.known.add(name);
      perPath.delete(name);
    }
  }
  return schemas;
}

export function toEvalRow(
  req: RawRequest,
  label: 'benign' | 'malicious',
  index: number,
  schemas?: Map<string, RouteSchema>,
  config?: SchemaConfig,
): EvalRow {
  const { path, query } = splitUrl(req.url);
  const bodyText = req.body.length > 0 ? req.body : null;
  const userAgent = req.headers['user-agent'] ?? null;

  const schema = schemas?.get(path) ?? {
    known: new Set<string>(),
    observations: 0,
    unbounded: false,
  };
  const names = parameterNames({
    query,
    bodyText,
    contentType: req.headers['content-type'] ?? 'application/x-www-form-urlencoded',
  });

  const heuristics = scoreHeuristics({
    method: req.method,
    path,
    query,
    bodyText,
    bodyBytes: Buffer.byteLength(req.body),
    userAgent: userAgent ?? undefined,
    routeMethods: ROUTE_METHODS,
    unknownParam:
      schemas && config ? unknownParamSignal(names, schema, config) : 0,
    stats: { ...NEUTRAL_STATS },
  });

  const envelope: FeatureEnvelope = {
    requestId: `csic-${label === 'malicious' ? 'a' : 'n'}-${index}`,
    route: ROUTE,
    method: req.method,
    path: truncate(redactText(path), 200),
    principal: principalOf(req.headers, index),
    clientCountry: null,
    userAgent: userAgent ? truncate(userAgent, 200) : null,
    querySample: truncate(redactQuery(query), 500),
    bodySample: bodyText ? truncate(redactText(bodyText), 500) : '',
    heuristics: {
      score: heuristics.score,
      signals: heuristics.signals,
      categories: heuristics.categories,
      matchedPatterns: heuristics.matchedPatterns,
    },
    principalStats10m: { ...NEUTRAL_STATS_10M },
  };

  return {
    id: envelope.requestId,
    label,
    categories: label === 'malicious' ? heuristics.categories : [],
    note:
      label === 'malicious'
        ? 'CSIC 2010 anomalous request'
        : 'CSIC 2010 normal request',
    envelope,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      src: { type: 'string' },
      out: { type: 'string' },
      /** Keep every nth row, so a smaller file can be produced for quick runs. */
      stride: { type: 'string' },
      /** Skip schema learning, to measure the pattern signals on their own. */
      'no-schema': { type: 'boolean' },
    },
  });

  const src = resolve(values.src ?? './csic');
  const out = resolve(values.out ?? '../../docs/eval/csic-2010.jsonl');
  const stride = Math.max(1, Number(values.stride ?? 1));

  const config: SchemaConfig = {
    // CSIC has no warmup phase to speak of: the training corpus is the warmup, and it is 36,000
    // requests. The promotion rule is applied exactly as the gateway applies it.
    warmupRequests: 500,
    promotePrincipals: 3,
    maxNames: 256,
  };

  const read = async (name: string): Promise<RawRequest[]> =>
    parseDump(await readFile(join(src, name), 'latin1'));

  // normalTrafficTraining is the learning corpus and never appears in the output. Everything scored
  // below is held out from it, so the schema cannot have seen the request it is judging.
  let schemas: Map<string, RouteSchema> | undefined;
  if (!values['no-schema']) {
    const training = await read('normalTrafficTraining.txt');
    schemas = learnSchema(training, config);
    const names = [...schemas.values()].reduce((n, s2) => n + s2.known.size, 0);
    console.log(
      `learned   ${schemas.size} paths, ${names} parameter names from ${training.length} training requests`,
    );
  } else {
    console.log('learned   nothing (--no-schema)');
  }

  const files: Array<{ name: string; label: 'benign' | 'malicious' }> = [
    { name: 'normalTrafficTest.txt', label: 'benign' },
    { name: 'anomalousTrafficTest.txt', label: 'malicious' },
  ];

  const stream = createWriteStream(out);
  const counts = { benign: 0, malicious: 0 };
  const gated = { benign: 0, malicious: 0 };

  for (const { name, label } of files) {
    const requests = await read(name);
    let kept = 0;
    for (const [i, req] of requests.entries()) {
      if (i % stride !== 0) continue;
      const row = toEvalRow(req, label, i, schemas, config);
      stream.write(`${JSON.stringify(row)}\n`);
      counts[label]++;
      kept++;
      if (row.envelope.heuristics.score >= 0.4) gated[label]++;
    }
    console.log(
      `${name.padEnd(26)} parsed ${String(requests.length).padStart(6)}  kept ${String(kept).padStart(6)}  (${label})`,
    );
  }

  await new Promise<void>((r) => stream.end(r));
  const total = counts.benign + counts.malicious;
  console.log(`\nwrote ${total} held-out rows to ${out}`);
  console.log(
    `  benign     ${counts.benign}  (${gated.benign} at or above the 0.4 gate)`,
  );
  console.log(
    `  malicious  ${counts.malicious}  (${gated.malicious} at or above the 0.4 gate)`,
  );
  console.log(
    '\nBehavioural features are identical for both classes by design, so any separation here is',
  );
  console.log('payload and schema detection. See the note at the top of import-csic.ts.');
}

if (process.argv[1]?.endsWith('import-csic.js')) await main();
