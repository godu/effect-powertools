---
name: cloudwatch-dashboard-design
description: Design CloudWatch dashboards and matching alarms for AWS Lambda + Powertools pipelines. Use when building a new dashboard, adding metric widgets, debugging an empty/broken widget, or wiring CloudWatch alarms — covers SEARCH() syntax, the addDimension vs Metric.tagged dimension-schema split, alarm-vs-dashboard differences, the "metrics is array of array of strings" validation gotcha, and the stakeholder-audience layout patterns.
---

# CloudWatch dashboard design — a Powertools-flavored guide

A working reference for dashboards and alarms on AWS Lambda pipelines that
emit metrics via [Powertools EMF](https://docs.powertools.aws.dev/lambda/typescript/latest/features/metrics/).
Every section maps to a real failure or pattern from a deployed pipeline;
every code snippet has a working version checked into this repo.

## When to use this guide

Reach for this guide when you're:

- Building a CloudWatch dashboard from scratch and want a layout that
  survives review.
- Wiring CloudWatch alarms next to that dashboard and hitting confusing
  errors (`"Period must not be null"`, `"SEARCH is not supported on Metric
  Alarms"`).
- Debugging a widget that renders empty even though `aws cloudwatch
  list-metrics` shows the metric exists.
- Trying to figure out why two metrics from the same Lambda end up under
  *different* dimension schemas.

Skip this guide for: Application Signals SLOs / service maps, ADOT
(OpenTelemetry collector) setup, the generic "what is CloudWatch"
introduction, or anything that lives in `AWS/X-Ray` namespaces only.

## 1. Core concepts (90-second primer)

A CloudWatch dashboard is a single JSON document submitted via
`PutDashboard`. With Pulumi:

```ts
const dashboardBody = pulumi
  .all([fn1.name, fn2.name])
  .apply(([n1, n2]) =>
    JSON.stringify(buildDashboard({ region, stack, n1, n2 }))
  );

new aws.cloudwatch.Dashboard("dash", {
  dashboardName: namePrefix,
  dashboardBody,
});
```

The grid is **24 columns wide**. Widgets place via `(x, y, width, height)`
with `y` tracked manually (no auto-flow).

Widget types you'll use:

| `type` | What it is |
|---|---|
| `metric` with `view: "timeSeries"` | The default chart. Multi-line, stacked or unstacked. |
| `metric` with `view: "singleValue"` | KPI tile. One big number, optional sparkline. |
| `metric` with `view: "gauge"` | Half-circle dial. Rarely useful. |
| `text` | Markdown. Use for section headers. |

The `metrics` field is `Array<Array<MetricEntry>>`. Each *inner* array is
**one chart line**. The single most common bug:

```ts
// ❌ Wrong — `[entry]` (one array of objects)
metrics: [{ expression: "SEARCH(...)", id: "e1", label: "x" }]
// → CloudWatch rejects: "Field metrics has to be an array of array of strings"

// ✅ Right — `[[entry]]` (array of arrays)
metrics: [[{ expression: "SEARCH(...)", id: "e1", label: "x" }]]
```

A small helper makes this hard to forget:

```ts
function expressionMetric(entry: ExpressionEntry): unknown[][] {
  return [[entry]];
}
```

## 2. Audience-driven layout

Decide before designing. Three lenses, each implies a different shape:

| Lens | Top concern | Layout |
|---|---|---|
| **Oncall triage** | "Is the system on fire?" | Top-row stat tiles, big alerts, sparser diagnostic widgets, faults emphasized. |
| **Eng review / debug** | "Why is X slow?" | Percentiles, breakdowns, trends. Trade scan-time for diagnostic depth. |
| **Stakeholder / product** | "How is the business performing?" | Traffic + success + perceived latency. Hide infra (memory, throttles, init duration). |

The stakeholder lens that worked here:

```
Top KPI tiles (Orders/min, Orders written/min, Failure rate %, DLQ depth)
## Orders          — paired widgets (total + per-shape stack)
## Failures        — RecordFailures by reason + BatchRecordFailures + DLQ
## Latency         — combined p95 overlay + histogram percentiles
## Traffic & faults — slim Lambda Invocations + Errors only
## Trace map       — link to X-Ray Trace Map
```

For oncall: replace `## Latency` with `## Saturation` (concurrency,
throttles, memory) and beef up the top tile row to four-wide health
checks.

## 3. Metric references — three flavors

Inside a `metrics` widget, each line is one of:

### Direct metric reference

```ts
["AWS/Lambda", "Errors", "FunctionName", "fn-name", { stat: "Sum" }]
```

The last entry can be an options object: `stat`, `label`,
`yAxis: "left" | "right"`, `color`, `period`, `visible`. The dimensions
are positional pairs: `dimName, dimValue, dimName, dimValue, …`.

### Expression (math, SEARCH, conditional)

```ts
[{ expression: "100 * fail / emit", label: "Failure rate %", id: "rate" }]
```

The `id` is referenced by other expressions; `visible: false` hides it
from the chart (use for input expressions whose only role is feeding a
final expression).

### Percentile

Set `stat: "p95"` (or `"p50"` / `"p99"`). For three lines per histogram:

```ts
metrics: [
  ["NS", "OrderAmountHistogram", "service", consumerName, "orderShape", "normal", { stat: "p50", label: "p50" }],
  [".", ".", ".", ".", ".", ".", { stat: "p95", label: "p95" }],
  [".", ".", ".", ".", ".", ".", { stat: "p99", label: "p99" }],
]
```

The `"."` entries inherit the previous row's value at that position —
shorthand to keep widgets readable.

## 4. SEARCH() — when, why, how

SEARCH lets one widget chart a *family* of metrics matching a filter,
without knowing the dimension values up front.

### Syntax that works

```
SEARCH('{Namespace,Dim1,Dim2,Dim3} MetricName="X" Dim1="value"', 'Stat', PeriodSeconds)
```

- The `{…}` braces explicitly select a dimension schema. Without them,
  SEARCH pattern-matches across every schema in the namespace, which
  almost never does what you want.
- Values are filtered with `=`.
- A bare dimension key (without `=`) acts as **fan-out**: SEARCH
  returns one series per distinct value of that dimension.

### Three common SEARCH patterns

**Aggregate across a dimension** (collapse the per-shape buckets back to
one global series):

```ts
SUM(SEARCH('{NS,environment,orderShape,service} MetricName="OrdersEmitted" service="my-producer"', 'Sum', 60))
```

Returns one series. Use when the metric is over-dimensioned (see §5)
and the dashboard wants the global view.

**Fan out by a dimension** (one chart line per shape):

```ts
SEARCH('{NS,environment,orderShape,service} MetricName="OrdersEmitted" service="my-producer"', 'Sum', 60)
```

Returns N series (one per `orderShape` value). Pair with
`stacked: true` on the widget for a stacked time series.

**Math on SEARCH results** (e.g. failure rate):

```ts
metrics: [
  [{ expression: "SUM(SEARCH('… RecordFailures consumer', 'Sum', 300))", id: "fail", visible: false, label: "fail" }],
  [{ expression: "SUM(SEARCH('… OrdersEmitted producer', 'Sum', 300))", id: "emit", visible: false, label: "emit" }],
  [{ expression: "IF(emit > 0, 100 * fail / emit, 0)", id: "rate", label: "Failure rate %" }],
]
```

The `IF(emit > 0, …, 0)` guards the no-traffic divide-by-zero; without
it the chart shows `NaN` during quiet windows.

## 5. Powertools dimension-schema gotchas (the most important section)

Powertools serializes each metric under exactly the dimension schema
present at flush time. With the Effect bridge there are **two emission
paths** that produce *different schemas* for the same metric source:

| Path | Trigger from Effect | Resulting dimension schema |
|---|---|---|
| Main metrics object | `Metric.update(untaggedMetric, …)` | `[service, environment, *every-key-from-addDimension]` |
| `singleMetric()` | `Metric.update(Metric.tagged(metric, "k", "v"), …)` | `[service, *Effect-side tags only]` (does **not** inherit `addDimension` values) |

### The bug this creates

If Effect-side code calls `ptMetrics.addDimension("orderShape", shape)`
inside the program, *every untagged* metric in that invocation lands
under `[service, environment, orderShape]`. The `[service, environment]`
global series — which is what most dashboards default-query — never
receives a datapoint. Widgets show empty even though the metric is being
emitted at high rate.

Symptom in `aws cloudwatch list-metrics`:

```
[
  [service],                                 # stale, from old code
  [service, environment],                    # stale, from old code
  [service, environment, orderShape=normal], # current
  [service, environment, orderShape=high],   # current
  [service, environment, orderShape=poison], # current
]
```

The first two entries are *cached* — they linger in `list-metrics` for
~14 days after the last datapoint was emitted under that schema.
Querying them returns no data.

### Two ways out

**Recovery (no code change)** — SEARCH the over-dimensioned schema and
SUM:

```ts
SUM(SEARCH('{NS,environment,orderShape,service} MetricName="OrdersEmitted" service="…"', 'Sum', 60))
```

This collapses `orderShape` back out, yielding the global series the
widget wanted.

**Cleaner (code change)** — use `Metric.tagged(metric, "k", "v")` for
per-emission breakdown. It goes via `singleMetric()` and doesn't poison
the main metrics object, so the global `[service, environment]` series
keeps receiving data.

```ts
// Effect-side: per-shape break without poisoning the global counter.
yield* Metric.update(
  Metric.tagged(ordersEmitted, "orderShape", shape),
  1,
);
```

### Rule of thumb

- Reach for `addDimension(...)` only when the dimension is genuinely
  invocation-wide and *not* already broken down per-event (e.g. a
  customer tier you only know once at handler entry).
- For per-emission breakdown, always prefer `Metric.tagged(...)`.

### Diagnosing an empty widget

1. `aws cloudwatch list-metrics --namespace <ns> --metric-name <name>`
2. Look at every dimension combination present.
3. The widget's filter must match one of those *exactly*.
4. Recent datapoints only show up under the *current* schema; ignore
   stale entries from older deploys.
5. If no current schema matches what the widget queries, the widget is
   on the wrong dimension set — fix the widget, not the metric.

## 6. Alarms — what differs from dashboards

CloudWatch alarms speak a *subset* of the metric query language:

### `SEARCH()` is not supported

```
ValidationError: SEARCH is not supported on Metric Alarms.
```

Direct metric references only, in `metricQueries[].metric`. If you need
to alarm across a fan-out dimension, either enumerate the values
explicitly or pre-aggregate at emission time (e.g., a single
`BatchRecordFailures` counter alongside the per-reason breakdown — see
"useful pattern" below).

### Period is required on every `metricQueries` entry

```
ValidationError: Period must not be null
```

Even on expression entries. Even though `SEARCH(..., period)` embeds the
period inside the expression string, the alarm API rejects entries
without an explicit `period` field.

```ts
metricQueries: [
  {
    id: "total",
    metric: { namespace: "...", metricName: "X", dimensions: { … }, period: 300, stat: "Sum" },
    returnData: false,
  },
  {
    id: "poison",
    metric: { namespace: "...", metricName: "Y", dimensions: { … }, period: 300, stat: "Sum" },
    returnData: false,
  },
  {
    id: "diff",
    expression: "total - poison",
    period: 300,                      // required even though it's an expression
    returnData: true,
  },
]
```

### Math expressions work fine

Pattern: m1 + m2 = direct metrics, e1 = expression with
`returnData: true`. The alarm fires on `e1`'s value vs `threshold`.

### Useful pattern: `BatchRecordFailures - RecordFailures{reason=expected}`

To alarm on *unexpected* failures only (without enumerating every
"unexpected" reason):

- `BatchRecordFailures` is bridge-side and counts every failed record
  regardless of reason.
- `RecordFailures{reason=PoisonOrderError}` is user-emitted via the
  `onRecordFailure` hook for explicitly-classified expected failures.
- `BatchRecordFailures - RecordFailures{reason=PoisonOrderError}` =
  unexpected failures.

This auto-tracks new failure variants. The day someone adds a new error
type to the consumer, the alarm picks it up without infra change.

## 7. Validation — pre and post deploy

### Pre-deploy

1. **`pulumi preview --diff`** — the dashboard JSON diff is large but the
   resource counts (`+ N to create`, `~ N to update`) catch
   misalignments fast. If you see resources you didn't expect, stop.
2. **Typecheck** — `tsc --noEmit` in the infra package. The widget JSON
   shapes are typed as `unknown` by Pulumi but your widget builders can
   be stricter.

### Post-deploy

Three error messages to recognize on sight:

- **`Field "metrics" has to be an array of array of strings`** —
  passing `[entry]` instead of `[[entry]]`. Use the `expressionMetric`
  helper to wrap once.
- **`Period must not be null`** — alarm `metricQueries` expression
  entry missing `period: <seconds>`.
- **`SEARCH is not supported on Metric Alarms`** — move SEARCH() out of
  the alarm; replace with direct metric refs + math.

After the dashboard apply succeeds:

1. Open the dashboard URL.
2. Drive a burst of representative traffic (~60 invocations is plenty
   for a low-rate event probability of 5–10 %).
3. Refresh. Empty widgets are usually a dimension-schema mismatch — see
   §5 to debug.

## 8. Cookbook — concrete patterns

Each pattern below is lifted from `examples/infra/src/dashboard.ts` or
`examples/infra/src/alarms.ts`; the working version is in-repo.

### 8.1 Top-row KPI tile

```ts
function kpiOrdersEmitted(x, y, w, h, d) {
  return singleValueWidget(
    x, y, w, h,
    d.region,
    "Orders/min (last)",
    expressionMetric({
      expression: `SUM(${searchByShape("OrdersEmitted", d.producerName, "Sum", 60)})`,
      label: "OrdersEmitted",
      id: "ord",
    }),
  );
}
```

`view: "singleValue"` + `sparkline: true` + `period: 60` = "what's the
rate right now". Use 4 across the top row for stakeholder dashboards.

### 8.2 Per-shape stack widget

```ts
function ordersEmittedByShape(x, y, w, h, d) {
  return metricWidget(
    x, y, w, h,
    d.region,
    "OrdersEmitted — by orderShape",
    expressionMetric({
      expression: searchByShape("OrdersEmitted", d.producerName, "Sum", 60),
      label: "",
      id: "shape",
    }),
    { stacked: true },
  );
}
```

SEARCH fan-out + `stacked: true` = one stacked area per shape, total
height = global rate.

### 8.3 Total widget aggregating an over-dimensioned metric

```ts
function ordersEmittedTotal(x, y, w, h, d) {
  return metricWidget(
    x, y, w, h,
    d.region,
    "OrdersEmitted — total/min",
    expressionMetric({
      expression: `SUM(${searchByShape("OrdersEmitted", d.producerName, "Sum", 60)})`,
      label: "Total",
      id: "tot",
    }),
  );
}
```

`SUM(SEARCH(...))` collapses the over-dimensioned schema (see §5) back
to a single series. Pair this widget with §8.2 — total on the left,
per-shape stack on the right.

### 8.4 End-to-end latency overlay

```ts
function e2ePipelineLatency(x, y, w, h, d) {
  const trigger = (name) => [
    POWERTOOLS_NAMESPACE, name, "service", d.triggerName, "environment", d.stack,
    { stat: "p95", label: name },
  ];
  // … producer, consumer helpers similarly …
  return metricWidget(
    x, y, w, h, d.region,
    "End-to-end pipeline latency (p95, 5 min)",
    [
      trigger("TriggerProcessDuration"),
      trigger("TriggerLatency"),
      producer("EmitLatencyMs"),
      [
        "AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", d.mainQueueName,
        { stat: "Maximum", label: "SQS queue age (s)", yAxis: "right" },
      ],
      consumer("WriteLatency"),
      consumer("OrderProcessDuration"),
    ],
    { period: 300, stat: "p95" },
  );
}
```

Notes:

- Mixed units (ms for Lambda timers, seconds for SQS age) — put the
  outlier on `yAxis: "right"`.
- All p95 at 300s for a smooth distribution; 60s is too noisy for tail
  visualization.
- `SQS ApproximateAgeOfOldestMessage` uses `stat: "Maximum"` since age
  is already a max-style quantity.

### 8.5 Histogram percentile triple (p50/p95/p99)

```ts
const search = (stat) =>
  `SEARCH('{NS,orderShape,service} MetricName="OrderAmountHistogram" service="${d.consumerName}"', '${stat}', 300)`;

return metricWidget(x, y, w, h, d.region,
  "OrderAmountHistogram — p50 / p95 / p99 (5 min)",
  [
    [{ expression: search("p50"), label: "p50", id: "p50" }],
    [{ expression: search("p95"), label: "p95", id: "p95" }],
    [{ expression: search("p99"), label: "p99", id: "p99" }],
  ],
  { period: 300 },
);
```

Three percentiles from the same SEARCH source. Reads the tail correctly
— averages on histograms hide outliers, which are usually what you
actually need to see.

### 8.6 Failure rate KPI tile (math expression)

```ts
const fail = `SUM(SEARCH('{NS,reason,service} MetricName="RecordFailures" service="${d.consumerName}"', 'Sum', 300))`;
const emit = `SUM(${searchByShape("OrdersEmitted", d.producerName, "Sum", 300)})`;

return singleValueWidget(x, y, w, h, d.region,
  "Failure rate % (5 min)",
  [
    [{ expression: fail, label: "fail", id: "fail", visible: false }],
    [{ expression: emit, label: "emit", id: "emit", visible: false }],
    [{ expression: "IF(emit > 0, 100 * fail / emit, 0)", label: "Failure rate %", id: "rate" }],
  ],
  { period: 300 },
);
```

Two SEARCH inputs (hidden via `visible: false`), one math expression
that produces the displayed value. The `IF` guards divide-by-zero
during quiet windows.

### 8.7 Math-derived alarm — non-poison failures

```ts
new aws.cloudwatch.MetricAlarm("record-failures-non-poison", {
  comparisonOperator: "GreaterThanOrEqualToThreshold",
  evaluationPeriods: 1,
  threshold: 1,
  treatMissingData: "notBreaching",
  metricQueries: [
    {
      id: "total",
      metric: {
        namespace: POWERTOOLS_NAMESPACE,
        metricName: "BatchRecordFailures",
        dimensions: { service: consumer.name, environment: stack },
        period: 300,
        stat: "Sum",
      },
      returnData: false,
    },
    {
      id: "poison",
      metric: {
        namespace: POWERTOOLS_NAMESPACE,
        metricName: "RecordFailures",
        dimensions: { service: consumer.name, reason: "PoisonOrderError" },
        period: 300,
        stat: "Sum",
      },
      returnData: false,
    },
    {
      id: "nonPoison",
      expression: "total - poison",
      label: "Non-poison failures",
      returnData: true,
    },
  ],
});
```

The alarm fires on `nonPoison`. Auto-tracks new failure reasons:
anything counted in `BatchRecordFailures` but not classified as
`PoisonOrderError` increments the alarm metric.

### 8.8 Section header (text widget)

```ts
function header(x, y, w, h, markdown) {
  return {
    type: "text",
    x, y, width: w, height: h,
    properties: { markdown },
  };
}

// Usage: a 24-wide × 1-tall row that visually separates sections.
header(0, 30, 24, 1, "## Failures");
```

CloudWatch renders Markdown in `text` widgets — use `## Heading` for
section headers, `**bold**` for emphasis, and link out to runbooks /
trace maps. A taller text widget (`h: 4`) becomes a "more info" panel.

## 9. Reference

- `examples/infra/src/dashboard.ts` — full working source for the
  dashboard described in this guide.
- `examples/infra/src/alarms.ts` — matching alarm set with severity
  tags.
- `examples/README.md` — what each metric in the dashboard *measures*
  and the underlying Lambda code that emits it.
- `effect-powertools/metrics.ts` — the Effect ↔ Powertools bridge that
  produces the over-dimensioned vs `singleMetric()` schemas described
  in §5.

To open the live dashboard:

```sh
pulumi --cwd examples/infra stack output dashboardUrl
```

To list every dimension combination a metric is currently emitted with
(use this when a widget renders empty):

```sh
aws cloudwatch list-metrics \
  --namespace cloudwatch-observability-demo \
  --metric-name OrdersEmitted \
  --query 'Metrics[].Dimensions'
```

## 10. Anti-patterns

A few things to *not* do, encoded from things that broke:

- **Don't query `[service]` only when the metric also has `environment` and
  `orderShape`.** It will be empty. Either match the full schema, or
  `SUM(SEARCH(…))` over the over-dimensioned schema.
- **Don't put SEARCH() in alarms.** It silently fails-deploy with
  `ValidationError: SEARCH is not supported on Metric Alarms`. Use direct
  metric refs + math expressions.
- **Don't use averages on histogram metrics.** Averages on bucketed data
  hide the tail behavior that's almost always the question being asked.
  Use p95 or three-line p50/p95/p99.
- **Don't hardcode `environment: "dev"`.** Thread the Pulumi stack name
  through. The dashboard works fine on dev and silently mismatches on
  prod.
- **Don't reach for `addDimension` to express per-event breakdown.** It
  pollutes every metric in the invocation. Use `Metric.tagged` instead;
  it's the only path that goes via `singleMetric()` and stays out of the
  main metrics object's dimension list.
- **Don't add an "OK on no data" treatMissingData policy when the metric
  is already 0 during quiet windows.** `treatMissingData: "notBreaching"`
  is for genuinely missing data, not for "fail metric is zero".
