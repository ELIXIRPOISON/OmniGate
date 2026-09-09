import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadDotenv } from '../config/dotenv.js';
import { loadEnv } from '../config/env.js';
import type { EvalRow } from './generate-dataset.js';
import { createLlmProvider } from '../anomaly/llm/llm.factory.js';
import type { LlmProvider } from '../anomaly/llm/provider.js';

/**
 * Evaluation harness (docs/06 section 8.2, docs/08 S6-05).
 *
 *   pnpm --filter @omnigate/gateway eval:anomaly -- --provider fake
 *   pnpm --filter @omnigate/gateway eval:anomaly -- --provider local --model qwen2.5:7b
 *
 * Prints the confusion matrix, precision/recall/F1 and mean latency for heuristics-only,
 * LLM-only and combined, then writes a threshold sweep as CSV. It talks to the provider
 * directly (no Redis, no queue) so it can run against any backend from a laptop.
 */

export interface Scored {
  row: EvalRow;
  heuristic: number;
  llm: number | null;
  /** What the gateway would conclude: the model verdict when it ran, else the heuristic score. */
  combined: number;
  latencyMs: number | null;
  error?: string;
}

export interface Metrics {
  precision: number;
  recall: number;
  f1: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export function metricsAt(
  scores: Array<{ score: number; malicious: boolean }>,
  threshold: number,
): Metrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const { score, malicious } of scores) {
    const flagged = score >= threshold;
    if (malicious) {
      if (flagged) tp++;
      else fn++;
    } else if (flagged) fp++;
    else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 =
    precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, tp, fp, fn, tn };
}

export function loadRows(path: string, limit?: number): EvalRow[] {
  const rows = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EvalRow);
  return limit ? rows.slice(0, limit) : rows;
}

/** Only rows the gate would forward reach the model in production, so the harness mirrors that. */
export function gated(row: EvalRow, gateThreshold: number): boolean {
  return row.envelope.heuristics.score >= gateThreshold;
}

async function pool<T, R>(
  items: T[],
  size: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length }) as R[];
  let next = 0;
  const runners = Array.from(
    { length: Math.min(size, items.length) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

export async function scoreRows(
  rows: EvalRow[],
  provider: LlmProvider,
  opts: {
    gateThreshold: number;
    timeoutMs: number;
    concurrency: number;
    onProgress?: (done: number) => void;
  },
): Promise<Scored[]> {
  let done = 0;
  return pool(rows, opts.concurrency, async (row) => {
    const heuristic = row.envelope.heuristics.score;
    const base: Scored = {
      row,
      heuristic,
      llm: null,
      combined: heuristic,
      latencyMs: null,
    };
    if (!gated(row, opts.gateThreshold)) {
      opts.onProgress?.(++done);
      return base;
    }
    const startedAt = Date.now();
    try {
      const verdict = await provider.classify(row.envelope, {
        timeoutMs: opts.timeoutMs,
      });
      const latencyMs = Date.now() - startedAt;
      opts.onProgress?.(++done);
      return {
        ...base,
        llm: verdict.score,
        combined: verdict.score,
        latencyMs,
      };
    } catch (err) {
      opts.onProgress?.(++done);
      // Fail-open, exactly like production: keep the heuristic score.
      return {
        ...base,
        latencyMs: Date.now() - startedAt,
        error: (err as Error).message,
      };
    }
  });
}

const pct = (x: number): string => (x * 100).toFixed(1).padStart(5) + '%';
const num = (x: number, d = 3): string => x.toFixed(d);

function table(name: string, m: Metrics): string {
  return [
    `${name.padEnd(16)} precision ${num(m.precision)}  recall ${num(m.recall)}  f1 ${num(m.f1)}`,
    `${' '.repeat(16)} tp ${String(m.tp).padStart(3)}  fp ${String(m.fp).padStart(3)}  fn ${String(m.fn).padStart(3)}  tn ${String(m.tn).padStart(3)}`,
  ].join('\n');
}

export function sweepCsv(scored: Scored[]): string {
  const lines = ['threshold,mode,precision,recall,f1,tp,fp,fn,tn'];
  const modes: Array<[string, (s: Scored) => number]> = [
    ['heuristic', (s) => s.heuristic],
    ['llm', (s) => s.llm ?? s.heuristic],
    ['combined', (s) => s.combined],
  ];
  for (let t = 0.05; t <= 0.951; t += 0.05) {
    const threshold = Math.round(t * 100) / 100;
    for (const [mode, pick] of modes) {
      const m = metricsAt(
        scored.map((s) => ({
          score: pick(s),
          malicious: s.row.label === 'malicious',
        })),
        threshold,
      );
      lines.push(
        [
          threshold,
          mode,
          num(m.precision),
          num(m.recall),
          num(m.f1),
          m.tp,
          m.fp,
          m.fn,
          m.tn,
        ].join(','),
      );
    }
  }
  return lines.join('\n') + '\n';
}

async function main(): Promise<void> {
  loadDotenv();
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      dataset: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      threshold: { type: 'string' },
      gate: { type: 'string' },
      limit: { type: 'string' },
      concurrency: { type: 'string' },
      timeout: { type: 'string' },
      csv: { type: 'string' },
      'gate-rate': { type: 'string' },
    },
  });

  const env = loadEnv({
    ...process.env,
    LLM_PROVIDER: values.provider ?? process.env.LLM_PROVIDER ?? 'fake',
    ...(values.model ? { LLM_MODEL: values.model } : {}),
    ...(values['base-url'] ? { LLM_BASE_URL: values['base-url'] } : {}),
  });

  const datasetPath = resolve(
    values.dataset ?? '../../docs/eval/anomaly-eval.jsonl',
  );
  const csvPath = resolve(
    values.csv ?? '../../docs/results/anomaly-threshold-sweep.csv',
  );
  const threshold = Number(values.threshold ?? 0.7);
  const gateThreshold = Number(values.gate ?? env.ANOMALY_GATE_THRESHOLD);
  const concurrency = Number(values.concurrency ?? 4);
  const timeoutMs = Number(values.timeout ?? env.LLM_TIMEOUT_ASYNC_MS);

  const rows = loadRows(
    datasetPath,
    values.limit ? Number(values.limit) : undefined,
  );
  const provider = createLlmProvider(env);
  const gatedCount = rows.filter((r) => gated(r, gateThreshold)).length;

  console.log(
    `dataset  ${datasetPath} (${rows.length} rows, ${rows.filter((r) => r.label === 'malicious').length} malicious)`,
  );
  console.log(
    `provider ${provider.name} / ${provider.model}${env.LLM_BASE_URL ? ` @ ${env.LLM_BASE_URL}` : ''}`,
  );
  console.log(
    `gate     ${gateThreshold} -> ${gatedCount}/${rows.length} rows reach the model; decision threshold ${threshold}`,
  );
  if (provider.name === 'fake') {
    console.log(
      'NOTE: the fake provider is a deterministic rule stub, not a model. Its numbers show that the',
    );
    console.log(
      '      pipeline works end to end; they are not evidence of model quality.',
    );
  }
  console.log('');

  const startedAt = Date.now();
  const scored = await scoreRows(rows, provider, {
    gateThreshold,
    timeoutMs,
    concurrency,
  });
  const wallMs = Date.now() - startedAt;

  const labelled = (pick: (s: Scored) => number) =>
    scored.map((s) => ({
      score: pick(s),
      malicious: s.row.label === 'malicious',
    }));
  const heuristicM = metricsAt(
    labelled((s) => s.heuristic),
    threshold,
  );
  const llmM = metricsAt(
    labelled((s) => s.llm ?? s.heuristic),
    threshold,
  );
  const combinedM = metricsAt(
    labelled((s) => s.combined),
    threshold,
  );

  console.log(table('heuristics only', heuristicM));
  console.log(table('llm only', llmM));
  console.log(table('combined', combinedM));

  const called = scored.filter((s) => s.llm !== null);
  const errors = scored.filter((s) => s.error);
  const latencies = called.map((s) => s.latencyMs ?? 0).sort((a, b) => a - b);
  const mean = latencies.length
    ? latencies.reduce((a, b) => a + b, 0) / latencies.length
    : 0;
  console.log('');
  console.log(
    `model calls      ${called.length} ok, ${errors.length} failed (failed rows fall back to the heuristic score)`,
  );
  if (latencies.length) {
    console.log(
      `model latency    mean ${Math.round(mean)} ms, p50 ${latencies[Math.floor(latencies.length * 0.5)]} ms, p95 ${latencies[Math.floor(latencies.length * 0.95)]} ms`,
    );
  }
  console.log(
    `wall clock       ${(wallMs / 1000).toFixed(1)} s at concurrency ${concurrency}`,
  );

  // docs/06 section 9. The eval set is adversarial by construction, so its own gate rate says
  // nothing about production volume; the traffic estimate uses the documented rate instead.
  const evalGateRate = gatedCount / rows.length;
  const trafficGateRate = Number(values['gate-rate'] ?? 0.005);
  const perMillion = Math.round(
    (trafficGateRate + env.ANOMALY_SAMPLE_RATE) * 1_000_000,
  );
  console.log(
    `gate rate        ${pct(evalGateRate)} on this (adversarial) eval set; assuming ${pct(trafficGateRate)} on real traffic`,
  );
  console.log(
    `cost model       ~${perMillion.toLocaleString('en-US')} calls per 1M requests (gate + ${pct(env.ANOMALY_SAMPLE_RATE)} sample), capped at ${env.LLM_DAILY_CALL_CAP.toLocaleString('en-US')}/day`,
  );
  console.log(
    '                 dedup within 10 min and the circuit breaker reduce this further in production',
  );

  mkdirSync(dirname(csvPath), { recursive: true });
  writeFileSync(csvPath, sweepCsv(scored));
  console.log('');
  console.log(`threshold sweep  ${csvPath}`);

  const targetsMet = combinedM.precision >= 0.85 && combinedM.recall >= 0.8;
  console.log(
    `targets (P>=0.85, R>=0.80) ${targetsMet ? 'MET' : 'NOT MET'} for combined at threshold ${threshold}`,
  );
  if (process.env.EVAL_STRICT === 'true' && !targetsMet) process.exit(1);
}

await main();
