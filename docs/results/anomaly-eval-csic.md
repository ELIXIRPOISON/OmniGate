# Anomaly detection against real traffic (CSIC 2010)

Everything in [`anomaly-eval.md`](anomaly-eval.md) was measured on a dataset this project generated
itself, with the generator and the heuristics written by the same hand. This page is the same
detector measured against traffic it did not write.

**Dataset:** HTTP DATASET CSIC 2010, published by the Spanish Research National Council: real HTTP
requests against a Spanish e-commerce application, labelled normal or anomalous. 97,065 requests
after import, 25,065 of them attacks. Attack classes include SQL injection, buffer overflow,
CRLF injection, XSS, server-side include, unintended resource access and parameter tampering.

**Import:** `pnpm --filter @omnigate/gateway eval:import-csic`. The file is 80 MB and is not
committed; the importer and the mirror it comes from are.

## The headline

| Dataset | Recall @ 0.7 | Precision |
|---|---|---|
| Our own generated set, 200 rows | 0.900 | 1.000 |
| CSIC 2010, 97,065 real requests | **0.065** | 1.000 |

A fourteen-fold gap. The generated set was measuring the detector against attacks it had been
designed to catch, which is the thing this exercise existed to find out.

Reading the misses produced five concrete pattern gaps (below). After fixing them:

| | Recall | Precision | FP |
|---|---|---|---|
| Before | 0.065 | 1.000 | 0 of 72,000 |
| After | **0.210** | 1.000 | 0 of 72,000 |

Still far from the 0.900 the synthetic set claimed. That number was not real.

## Why the behavioural features are held constant

CSIC is a payload benchmark: individual requests, no sender identity, no timeline. Inventing busy
sender statistics for the attack rows and quiet ones for the normal rows would push the label
straight into the features and reproduce exactly the flaw that makes the generated set untrustworthy.

So every row, both classes, gets identical, unremarkable statistics. The behavioural signals
contribute the same constant to both and cannot separate them. What is measured here is payload
detection alone, which is what CSIC is evidence about. The behavioural half needs replayed access
logs and honeypot capture and is not measured yet.

## The five gaps, each measured before it was added

Candidate patterns were run against all 97,065 rows and judged on what they caught **and** what they
cost, before any of them went in:

| Pattern | Attacks matched | Benign matched | Verdict |
|---|---|---|---|
| `waitfor delay '0:0:15'` | 535 | 0 | added |
| CRLF header injection | 266 | 0 | added |
| Poison null byte | 149 | 0 | added |
| Backup/source leftovers (`.BAK`, `.INC`, `.OLD`) | 2,132 | 0 | added |
| Tilde backups (`logo.gif~`) | 243 | 0 | added |
| Lone quote in a parameter | 16 | 19 | **rejected**, precision 0.457 |

The first one was a bug rather than a gap. The existing `time_based` rule was
`/\b(sleep|pg_sleep|waitfor\s+delay|benchmark)\s*\(/`, which requires a parenthesis. T-SQL's
`WAITFOR DELAY` takes a time string, so every blind-injection request in the set walked past it.

The last row is the one worth keeping in mind. It looked like an obvious win and the measurement said
no: it would have cost more in false positives than it gained.

## What is still missed, and why regexes will not fix it

19,802 attacks still get through, and 20,124 of the original misses scored 0.018, the floor, meaning
no signal fired at all. Reading them, they fall into three groups:

**Patterns we could still add.** Diminishing returns, but real. This is the group the five fixes came
from.

**Parameter tampering.** `idA=1` instead of `id=1`, `modoA=insertar` instead of `modo=insertar`,
`precio=2026` where the catalogue says otherwise. These are syntactically perfect requests that are
wrong only relative to the application's schema. No pattern can catch them; a gateway would have to
learn each route's valid parameter names and value ranges from traffic and flag departures. That is a
different mechanism, and it is the single largest category of misses.

**Weak labels.** Some rows are anomalous only in the sense that the original study fired them at the
app deliberately, such as fetching a static image. Even a perfect detector would leave these.

## The precision/recall tradeoff, visible for the first time

The synthetic set had no hard negatives at all, so every threshold looked free. On real traffic:

| Threshold | Recall | Precision | False positives |
|---|---|---|---|
| 0.3 | 0.309 | 0.695 | 3,410 |
| 0.5 | 0.213 | 1.000 | 2 |
| 0.7 | 0.210 | 1.000 | 0 |
| 0.9 | 0.210 | 1.000 | 0 |

Buying ten points of recall by dropping to 0.3 costs a 4.7 percent false-positive rate. The default
of 0.7 is in the right place, and now there is evidence for it rather than an assertion.

## Precision at realistic base rates

Zero false positives in 72,000 is a count, not a guarantee. By the rule of three, the 95 percent
upper bound on the false-positive rate is 3/72,000, about **1 in 24,000**. At that pessimistic bound:

| Base rate of attacks | True alerts per 1M | False alerts per 1M | Precision |
|---|---|---|---|
| 1% | 2,100 | 41 | 0.981 |
| 0.1% | 210 | 42 | 0.835 |
| 0.01% | 21 | 42 | 0.335 |

This is the table that decides whether the thing is usable, and it is reassuring in a way the earlier
numbers were not entitled to be. The detector is conservative: it catches roughly a fifth of attacks
and almost never cries wolf. For a gateway that flags for review, that is the right trade. Below
about 0.05 percent attack traffic the alerts stop being mostly true and an operator would want to
raise the bar or add a second condition.

## What the model contributes on real traffic

Run on a 4,854-row stratified sample (every 20th request), 334 of which clear the gate:

| Stage | Precision | Recall | TP | FP |
|---|---|---|---|---|
| Heuristics only | 1.000 | 0.228 | 286 | 0 |
| Model only | 1.000 | 0.108 | 136 | 0 |
| Combined | 1.000 | **0.231** | 290 | 0 |

`qwen2.5:7b` recovers **four** attacks out of 1,254 that the heuristics missed. That is the honest
size of its contribution on this data: 0.3 points of recall.

It does not make anything worse, which is the escalate-only rule in `anomaly/combine.ts` doing its
job, and it costs 7.7 s per call at concurrency 4.

The deeper problem is structural. The gate only lets through requests the heuristics already suspect,
so the model sees 24.6 percent of the attacks in the set and its ceiling is 24.6 percent recall no
matter how good it is. **The bottleneck is the gate, not the model.** Widening it means paying for
classification on traffic the heuristics think is fine, which the cost model has to absorb.

## What this changes

- The heuristics carry the system; the model is currently a rounding error on real attack data.
- The gate caps the model before the model gets a chance, so improving the model is not the next
  move. Improving recall at the gate, or sampling below it, is.
- Parameter tampering is the largest miss category and needs schema learning rather than patterns.
- The 0.7 default threshold is now evidence-backed.
- Conservative detection with a very low false-positive rate is usable at realistic base rates, which
  the synthetic numbers could not have told us either way.

## Reproducing

```bash
mkdir -p csic && cd csic
BASE=https://gitlab.fing.edu.uy/gsi/web-application-attacks-datasets/-/raw/master/csic_2010
for f in normalTrafficTraining.txt normalTrafficTest.txt anomalousTrafficTest.txt; do
  curl -sLO "$BASE/$f"
done
cd ..

pnpm --filter @omnigate/gateway build
pnpm --filter @omnigate/gateway eval:import-csic -- --src ./csic --out /tmp/csic-2010.jsonl
pnpm --filter @omnigate/gateway eval:anomaly -- --dataset /tmp/csic-2010.jsonl --provider fake

# with a model, on a sample, because 6,800 gated rows at 7 s each is two hours
pnpm --filter @omnigate/gateway eval:import-csic -- --src ./csic --out /tmp/csic-sample.jsonl --stride 20
pnpm --filter @omnigate/gateway eval:anomaly -- --dataset /tmp/csic-sample.jsonl \
  --provider local --model qwen2.5:7b --timeout 60000 --concurrency 4
```
