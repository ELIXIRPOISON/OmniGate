# Anomaly detection evaluation (Sprint 6)

Dataset: `docs/eval/anomaly-eval.jsonl`, 200 labelled rows (80 benign, 120 malicious) generated
deterministically by `pnpm --filter @omnigate/gateway eval:generate`. Harness:
`pnpm --filter @omnigate/gateway eval:anomaly`. Sweep: `docs/results/anomaly-threshold-sweep.csv`.

Decision threshold 0.7, gate 0.4 (only rows at or above the gate reach the model, as in production).

## Results

| Stage | Precision | Recall | F1 | TP | FP | FN | TN |
|---|---|---|---|---|---|---|---|
| Heuristics only | 1.000 | 0.900 | 0.947 | 108 | 0 | 12 | 80 |
| Model only (`fake` stub) | 1.000 | 0.942 | 0.970 | 113 | 0 | 7 | 80 |
| Combined | 1.000 | 0.942 | 0.970 | 113 | 0 | 7 | 80 |

Targets from docs/06 section 8.3 (precision >= 0.85, recall >= 0.80) are met by the heuristics alone
and improved by the classification stage.

## What these numbers do and do not show

The run above used `LLM_PROVIDER=fake`, a deterministic rule stub, because this project has no paid
model account. It is not a language model and its numbers are **not** evidence of model quality. What
the run does establish:

- the full pipeline works end to end: gate, envelope, provider call, verdict validation, dedup,
  breaker, budget, persistence and enforcement;
- the heuristics alone already separate the classes on this dataset, so the gateway is useful with no
  model configured at all;
- the stub lifts recall from 0.900 to 0.942 by weighting the ten-minute sender statistics
  (distinct paths, error rate) that the inline pass keeps deliberately cheap. A real model is expected
  to help on the same rows, which are the behavioural ones rather than the injection ones.

To produce real model numbers, run the same harness against any backend and replace this section:

```bash
# a model running locally through Ollama (no account, no cost)
pnpm --filter @omnigate/gateway eval:anomaly -- --provider local --model qwen2.5:7b

# any OpenAI-compatible endpoint, for example a free Groq key
LLM_API_KEY=... pnpm --filter @omnigate/gateway eval:anomaly -- \
  --provider openai --base-url https://api.groq.com/openai/v1 --model llama-3.3-70b-versatile
```

## The 7 remaining misses

All seven are behavioural rows whose statistics sit just under the ramps: id-enumeration and
scraping sequences with moderate distinct-path counts, and credential-stuffing bursts with fewer
than ten failures in the minute observed. They are visible in the sweep CSV as the recall gap between
thresholds 0.6 and 0.7. Lowering the decision threshold to 0.6 recovers them without introducing a
false positive on this dataset, which is the tuning lever to revisit once real traffic exists.

## Cost model

With the documented production gate rate of 0.5 percent plus a 2 percent sample, one million requests
produce roughly 25,000 classification calls, which the daily cap (`LLM_DAILY_CALL_CAP`, default
20,000) bounds. Dedup within a ten-minute window and the circuit breaker reduce this further. At
roughly 900 input and 100 output tokens per call, a small hosted model or a free tier stays inside a
few dollars a day; a locally hosted model costs nothing but CPU. The eval set's own gate rate is 57.5
percent because it is adversarial by construction, and must not be read as a traffic estimate.

## Reproducing

```bash
pnpm --filter @omnigate/gateway build
pnpm --filter @omnigate/gateway eval:generate    # regenerate the dataset (deterministic)
pnpm --filter @omnigate/gateway eval:anomaly     # score it and write the sweep CSV
```
