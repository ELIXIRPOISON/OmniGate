# Anomaly detection evaluation (synthetic dataset)

> **Read [`anomaly-eval-csic.md`](anomaly-eval-csic.md) first.** The same detector scores recall
> 0.900 here and 0.210 against 97,065 real requests from CSIC 2010. The numbers on this page are a
> self-test against a dataset this project generated, kept because the pipeline was built and tuned
> against it, not because they measure detection quality.

Dataset: `docs/eval/anomaly-eval.jsonl`, 200 labelled rows (80 benign, 120 malicious) generated
deterministically by `pnpm --filter @omnigate/gateway eval:generate`. Harness:
`pnpm --filter @omnigate/gateway eval:anomaly`.

Decision threshold 0.7, gate 0.4. Only rows at or above the gate reach the model, as in production:
115 of 200 here, all of them malicious, because the set is adversarial by construction.

Results below are from `qwen2.5:7b` served locally by Ollama. The `fake` provider, a deterministic
rule stub, is kept as the baseline the pipeline was built against; its sweep is
[`anomaly-threshold-sweep-fake.csv`](anomaly-threshold-sweep-fake.csv). The stub scored recall 0.942
because it was written to weight the exact statistics this dataset turns on, which is a property of
the dataset rather than of the stub.

## Results

`local` / qwen2.5:7b via Ollama, 115 calls, 0 failures. Sweep:
[`anomaly-threshold-sweep-local.csv`](anomaly-threshold-sweep-local.csv).

| Stage | Precision | Recall | F1 | TP | FP | FN | TN |
|---|---|---|---|---|---|---|---|
| Heuristics only | 1.000 | 0.900 | 0.947 | 108 | 0 | 12 | 80 |
| Model only | 1.000 | 0.475 | 0.644 | 57 | 0 | 63 | 80 |
| Combined | 1.000 | 0.900 | 0.947 | 108 | 0 | 12 | 80 |

Targets from docs/06 section 8.3 (precision >= 0.85, recall >= 0.80) are met.

At the 0.7 operating point the model changes nothing: the heuristics already catch everything it
catches. It earns its place at the thresholds an operator would actually *block* on, where the two
stages disagree about different rows and the combination beats both:

| Decision threshold | Heuristics | Model | Combined |
|---|---|---|---|
| 0.70 | 0.900 | 0.475 | 0.900 |
| 0.80 | 0.600 | 0.475 | **0.808** |
| 0.90 | 0.375 | 0.475 | **0.583** |
| 0.95 | 0.008 | 0.475 | 0.475 |

Every number here comes from a synthetic dataset this project generated itself, which is the largest
caveat on the page: see *What these numbers cannot tell you* at the end.

Precision stays 1.000 at every row of that table. Heuristic scores are spread thinly, so raising the
bar drops traffic off a cliff; the model's are concentrated. Neither alone is good at 0.9. Together
they catch 70 of 120 where the better single stage catches 57.

## How this was arrived at, including the parts that did not work

The first run of this eval used a prompt that asked the model for a numeric score and showed it the
combined heuristic score in the envelope. Three things were wrong with it, and fixing them took two
attempts because the obvious fix was wrong.

### The prompt taught the model to copy

Every few-shot example set its answer within 0.04 of the heuristic score shown in the same envelope
(0.02 -> 0.05, 0.58 -> 0.62, 0.95 -> 0.97). The model complied to within 0.02 in production, measured
in [`anomaly-anchoring-probe.csv`](anomaly-anchoring-probe.csv).

### The calibration band collided with the decision threshold

The prompt said `suspicious 0.3-0.7, malicious >= 0.7` and the decision threshold was also 0.7. Any
request the model judged suspicious was, by construction, below the line that triggers action. The
seven id-enumeration rows it could have recovered came back `suspicious` at 0.65 to 0.68: the model
was obeying its instructions exactly.

Fixed by asking for a verdict and a confidence and deriving the score in code
(`CONFIDENCE_SCORE` in `anomaly/llm/provider.ts`), so a confidently suspicious request reaches 0.80
and clears the flag line while staying under the block line.

### Withholding the heuristic score made it much worse

The obvious next step was to stop showing the model the number it was copying. That was tried and
**recall fell from 0.900 to 0.433.**

Sampling 21 gated rows across the heuristic range explains why: without that field the model answers
`suspicious / medium` to 17 of them, including SQL injection rows it had scored 0.97 a moment before.
Its independent judgement on these envelopes is close to constant. The heuristic score was not noise
the model was lazily copying; it was the best feature it had.

So the score stays in the envelope. The anchoring is real and is left in place.

### The bug that actually mattered

That failed experiment exposed something worse than anchoring. The gateway took the model's number
outright, which meant a weak or badly configured model could **lower** a confident heuristic finding
and silently unflag an attack. A model answering `suspicious / medium` to everything took the whole
system from 0.900 to 0.433.

`anomaly/combine.ts` now makes the second stage escalate-only:

- any verdict may raise the score, never lower it;
- `benign` at high confidence may lower it, because that is the one case the model exists for: the
  named partner key doing a bulk sync that every behavioural signal reads as scraping.

This is what produces the ensemble gain in the table above, and it makes anchoring harmless as a side
effect. A model that echoes the heuristic score is now a no-op rather than an overwrite.

**The net of all this is that recall at the operating point did not move.** What changed is that
detection can no longer be degraded by the model, and the block-threshold range got materially
better. Given that the next step is to plug in models nobody here has tested, a floor at
heuristics-only is worth more than a point of recall.

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

## What these numbers cannot tell you

The dataset is generated by `eval:generate`, a script written alongside the heuristics it evaluates.
Precision 1.000 on data the project invented is a self-test, not a measurement, and the class balance
is wrong in a way that flatters everything above: the set is 60 percent malicious where real API
traffic is nearer 0.1 percent.

At a 0.1 percent base rate, recall 0.900 with a 1 percent false-positive rate gives precision of
about 8 percent, or eleven false alarms for every real attack. Nothing in this document rules that
out, because the set contains no hard negatives at all: all 115 gated rows are malicious, so the
false-positive rate is unmeasured rather than zero.

Closing that needs traffic this project did not write. The plan is the CSIC 2010 HTTP dataset for the
payload half, replayed access logs and honeypot capture for the behavioural half, and reporting
precision at a fixed recall plus alerts per million rather than a single operating point.
