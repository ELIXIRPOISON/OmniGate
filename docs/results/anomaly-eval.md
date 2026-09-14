# Anomaly detection evaluation

Dataset: `docs/eval/anomaly-eval.jsonl`, 200 labelled rows (80 benign, 120 malicious) generated
deterministically by `pnpm --filter @omnigate/gateway eval:generate`. Harness:
`pnpm --filter @omnigate/gateway eval:anomaly`.

Decision threshold 0.7, gate 0.4. Only rows at or above the gate reach the model, as in production:
115 of 200 here, all of them malicious, because the set is adversarial by construction.

Two runs are recorded. The first uses `qwen2.5:7b` served locally by Ollama and is the real result.
The second uses the `fake` provider, a deterministic rule stub, and is kept only as the baseline the
pipeline was built against.

## Results

**`local` / qwen2.5:7b via Ollama** — 115 calls, 0 failures. Sweep:
[`anomaly-threshold-sweep-local.csv`](anomaly-threshold-sweep-local.csv).

| Stage | Precision | Recall | F1 | TP | FP | FN | TN |
|---|---|---|---|---|---|---|---|
| Heuristics only | 1.000 | 0.900 | 0.947 | 108 | 0 | 12 | 80 |
| Model only | 1.000 | 0.900 | 0.947 | 108 | 0 | 12 | 80 |
| Combined | 1.000 | 0.900 | 0.947 | 108 | 0 | 12 | 80 |

**`fake` stub** — sweep: [`anomaly-threshold-sweep-fake.csv`](anomaly-threshold-sweep-fake.csv).

| Stage | Precision | Recall | F1 | TP | FP | FN | TN |
|---|---|---|---|---|---|---|---|
| Heuristics only | 1.000 | 0.900 | 0.947 | 108 | 0 | 12 | 80 |
| Model only | 1.000 | 0.942 | 0.970 | 113 | 0 | 7 | 80 |
| Combined | 1.000 | 0.942 | 0.970 | 113 | 0 | 7 | 80 |

Targets from docs/06 section 8.3 (precision >= 0.85, recall >= 0.80) are met by the heuristics alone
in both runs.

## What the real model did and did not do

**It did not change a single decision at threshold 0.7.** Every metric is identical to the heuristics
alone. The stub beat it, which is not surprising once you know the stub was written to weight the
ten-minute sender statistics that the inline pass keeps deliberately cheap. A stub tuned to the
dataset is not a model.

**It did make the system far less sensitive to where the threshold sits.** This is the real benefit
and it does not show up in a single-threshold table:

| Decision threshold | Heuristic recall | Model recall |
|---|---|---|
| 0.70 | 0.900 | 0.900 |
| 0.75 | 0.717 | 0.892 |
| 0.80 | 0.600 | 0.700 |
| 0.85 | 0.458 | 0.575 |
| 0.95 | 0.008 | 0.342 |

Heuristic scores are spread thinly across the range, so raising the bar drops traffic off a cliff:
at 0.95 the heuristics catch one malicious request in 120. The model concentrates its confidence on
requests that really are attacks, so the same threshold still catches 41. An operator who wants to
block rather than flag has to run a high threshold, and at that end the model is the difference
between a usable control and a useless one.

## The twelve misses, and why the model does not recover them

Five of the twelve never reach the model at all: they score below the 0.4 gate, so the model's
ceiling on this dataset is seven. All seven are id-enumeration probing 404s, behavioural rows rather
than payload rows.

The model recognises them. Classifying those seven directly returns verdict `suspicious`, category
`enumeration`, and reasoning like *"High distinct path count and scripting user agent suggest
automated enumeration."* That is the correct reading.

It then scores them 0.65 to 0.68, just under the line.

### Measured: the model anchors on the score we show it

The envelope includes `heuristics.score`. Classifying the same seven rows twice, once as the gateway
sends them and once with only that field removed, gives
[`anomaly-anchoring-probe.csv`](anomaly-anchoring-probe.csv):

| | Model score | Verdict |
|---|---|---|
| Heuristic score shown | 0.65 – 0.68, within 0.02 of the heuristic every time | `suspicious` 7/7 |
| Heuristic score hidden | 0.45 – 0.55, clustered on round numbers | `suspicious` 7/7 |

Shown the number, the model reproduces it. Hidden, it falls back to a generic mid-range guess and
becomes *less* confident, not more. So removing the field does not fix recall; it makes it worse.

**The verdict was right in all fourteen classifications while the score was never useful.** The
pipeline currently enforces on the number alone (`score >= ANOMALY_BLOCK_THRESHOLD` in
`anomaly.interceptor.ts`), so the one signal this model got consistently right is discarded. Treating
a `suspicious` verdict as a floor under the score would have caught all seven. That is the change to
make before reaching for a bigger model, and it is filed for v1.1 rather than done here because it
alters enforcement semantics and deserves its own eval.

Lowering the decision threshold to 0.6 also recovers all seven without a false positive on this
dataset, which remains the cheapest lever.

## Latency, and why sync mode cannot use a local 7B

| | |
|---|---|
| Warm, one call at a time | p50 1.29 s (range 1.27 – 1.41 s over 7 calls) |
| Concurrency 4 against one Ollama instance | mean 6.24 s, p50 6.29 s, p95 6.66 s |
| Full run | 181.8 s wall clock for 115 calls |

The concurrency-4 figure is queueing, not per-call cost: one local model serves one request at a
time, so four in flight quadruples the observed latency. The honest per-classification number is the
serial one, 1.29 s.

Either way it is above `LLM_TIMEOUT_SYNC_MS` (800 ms) by a wide margin, so a route in `sync` mode
backed by a local 7B fails open on every request and the model never affects the response. Sync mode
needs a hosted model with sub-second first-token latency. This is the measurement behind async being
the default and sync being opt-in.

## Cost model

With the documented production gate rate of 0.5 percent plus a 2 percent sample, one million requests
produce roughly 25,000 classification calls, which `LLM_DAILY_CALL_CAP` (default 20,000) bounds.
Dedup within a ten-minute window and the circuit breaker reduce it further. Locally hosted, that
costs nothing but CPU; at 1.29 s per call it is about 9 hours of single-stream compute per million
requests, which is why the gate exists. The eval set's own gate rate is 57.5 percent because it is
adversarial by construction and must not be read as a traffic estimate.

## Reproducing

```bash
brew install ollama && ollama serve &
ollama pull qwen2.5:7b

pnpm --filter @omnigate/gateway build
pnpm --filter @omnigate/gateway eval:generate      # regenerate the dataset (deterministic)
pnpm --filter @omnigate/gateway eval:anomaly -- \
  --provider local --model qwen2.5:7b --timeout 60000 --concurrency 4 \
  --csv ../../docs/results/anomaly-threshold-sweep-local.csv
```

Any OpenAI-compatible endpoint works the same way, for example a free Groq key:

```bash
LLM_API_KEY=... pnpm --filter @omnigate/gateway eval:anomaly -- \
  --provider openai --base-url https://api.groq.com/openai/v1 --model llama-3.3-70b-versatile
```
