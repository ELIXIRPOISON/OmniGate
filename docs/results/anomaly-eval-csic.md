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

> Updated after Phase 2. The evaluation below is now properly held out: the schema is learned from
> `normalTrafficTraining` and every scored row comes from `normalTrafficTest` and
> `anomalousTrafficTest`, which the learner never saw.

| Detector | Recall | FP / 36,000 benign | Precision |
|---|---|---|---|
| Pattern and behavioural signals | 0.210 | 0 | 1.000 |
| **+ learned parameter names** (default) | **0.494** | **0** | **1.000** |
| + learned value shapes (opt in) | **0.772** | 28 | 0.999 |

Learning which parameter names each route accepts, 42 names across 28 paths, more than doubles
recall at no measurable cost in false positives. It detects more on its own than all eight of the
original signals combined. Learning what those parameters normally *contain* adds another 28 points
of recall, and is the first signal in the gateway to cost anything.

It also unblocks the model. Gated attacks go from 6,171 to 13,114 with names, and 19,672 with
shapes, so the ceiling on what the classification stage can ever contribute rises from 24.6 percent
to 52.3 and then 78.5.

## The original finding

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

The synthetic set had no hard negatives at all, so every threshold looked free. On real traffic,
with the schema signal in place:

| Threshold | Recall | Precision | False positives |
|---|---|---|---|
| 0.3 | 0.562 | 0.892 | 1,707 |
| 0.5 | 0.498 | 1.000 | 1 |
| 0.7 | 0.494 | 1.000 | 0 |
| 0.9 | 0.210 | 1.000 | 0 |

The default of 0.7 is in the right place, and now there is evidence for it rather than an assertion.
Note the cliff at 0.9: above the schema signal's weight the detector falls back to patterns alone.
Anyone raising the threshold that far is turning off the strongest signal without meaning to.

## Precision at realistic base rates

Zero false positives in 36,000 held-out benign requests is a count, not a guarantee. By the rule of
three, the 95 percent upper bound on the false-positive rate is 3/36,000, about **1 in 12,000**. At
that pessimistic bound, with recall 0.494:

| Base rate of attacks | True alerts per 1M | False alerts per 1M | Precision |
|---|---|---|---|
| 1% | 4,940 | 83 | 0.983 |
| 0.1% | 494 | 83 | 0.856 |
| 0.01% | 49 | 83 | 0.373 |

This is the table that decides whether the thing is usable. The detector catches about half of
attacks and rarely cries wolf, which for a gateway that flags for review is the right trade. Below
roughly 0.02 percent attack traffic the alerts stop being mostly true and an operator would want to
raise the bar or require a second condition.

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

The deeper problem is structural. The gate only lets through requests the inline pass already
suspects, so at the time of that run the model saw 24.6 percent of the attacks and its ceiling was
24.6 percent recall no matter how good it is. **The bottleneck is the gate, not the model.**

The schema signal has since raised that ceiling to 52.3 percent by gating 13,114 attacks instead of
6,171. Whether a model can do anything with the extra traffic is unmeasured; that run has not been
repeated, and on current evidence it would be optimistic to expect much.

## What this changes

- The learned schema carries the system, the patterns come second, and the model is a rounding error
  on real attack data.
- The gate caps the model before the model gets a chance. Improving recall at the gate was the next
  move, and it worked: the ceiling went from 24.6 to 52.3 percent.
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

## Phase 2: the learned schema

Reading the misses said parameter tampering was the largest category and that no pattern could reach
it: `idA=1` for `id=1`, a price that does not match the catalogue. Syntactically perfect requests,
wrong only against the application's schema.

So the gateway learns the schema. `anomaly/schema.service.ts` keeps, per route, the set of parameter
names that route has legitimately accepted, and `unknown_param` fires when a request carries one that
is not in it.

Measured on the held-out split, it is the strongest single detector in the gateway:

| Signal | Recall | FP / 36,000 |
|---|---|---|
| All eight original signals | 0.210 | 0 |
| `unknown_param` alone | 0.494 | 0 |

### The detection is the easy part

Almost all of the work is in not making it dangerous:

- **Poisoning.** A schema learned from all traffic is a schema an attacker can teach. Only requests
  the upstream answered with a 2xx *and* that scored below the gate are learned from, so a request
  must look benign to two independent judges before it can widen a route's schema.
- **Cold start.** The signal stays silent until a route has contributed `SCHEMA_WARMUP_REQUESTS`
  observations. A fresh deployment does not alert on everything it has never seen.
- **Drift.** A new parameter is held as a candidate and promoted only once
  `SCHEMA_PROMOTE_PRINCIPALS` *distinct* callers have used it successfully. A real API rollout
  satisfies that immediately; one attacker does not.
- **Unbounded routes.** Search facets and similar are not schema-able. Past `SCHEMA_MAX_NAMES` the
  route is marked unmodellable and the signal disables itself there rather than alerting forever.

The eval applies the promotion rule exactly as the gateway does, which is why it scores 0.494 rather
than the 0.504 an idealised "any name seen once" learner reaches.

### Value shapes, and why they are off by default

Per known parameter, the schema also records the *kinds* of value it has carried, as a four-bit
character-class signature, and the longest one seen. A value whose class the parameter has never
carried, or one far longer than anything before it, is flagged.

It is the largest single recall gain available and the first signal with a false-positive count that
is not zero:

| | Recall | FP / 36,000 | Precision |
|---|---|---|---|
| Names only | 0.494 | 0 | 1.000 |
| Names + value shapes | 0.772 | 28 | 0.999 |

Precision 0.999 sounds free. At realistic base rates it is not:

| Base rate | Names only | Names + shapes |
|---|---|---|
| 1% | 0.984 | 0.909 |
| 0.1% | **0.856** | **0.498** |
| 0.01% | 0.372 | 0.090 |

At one attack in a thousand requests, turning shapes on takes recall from 0.494 to 0.772 and
precision from 0.856 to a coin flip. That is a real trade rather than an upgrade, so the operator
makes it: `SCHEMA_VALUE_SHAPES`, off unless set. Worth turning on where missing an attack costs more
than chasing a false one, and where somebody is actually reading the queue.

The class signature is deliberately coarse, four bits. Finer representations were not tried, and a
better one is the obvious place to look for the same recall at lower cost.

Shapes are only learned for names already promoted, so a parameter cannot have a value profile
before the route admits the name. That is why this scores 0.772 where an unconstrained learner
reaches 0.891: the safety rules cost about twelve points of recall, and they are worth it.

### What it does not tell us

CSIC's application has 28 paths and 42 parameter names. Real APIs are larger and churn more, so the
zero-false-positive result is optimistic. The mechanism is sound; the numbers are from a small,
stable application and will not transfer unchanged. The safeguards above are what decide whether it
survives a real API, and none of them can be tested against CSIC, because CSIC has no timeline,
no deployments and no attackers who arrive during the learning window.

That is the argument for the honeypot: it is the only way to watch schema learning meet traffic
nobody curated.
