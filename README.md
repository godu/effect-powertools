# AWS Lambda Observability Guide

A practical guide for adding production-grade observability to AWS Lambda
functions in **Python** and **TypeScript**, targeting the native AWS stack:
**CloudWatch Logs**, **CloudWatch Metrics (EMF)**, **AWS X-Ray**, and
**Application Signals**.

The three signals you wire up:

| Signal | What it gives you | Where it lands |
|---|---|---|
| **Structured logs** | One-line-per-event JSON with severity, message key, and arbitrary fields | CloudWatch Logs Insights |
| **Custom metrics (EMF)** | Counters, gauges, histograms emitted as embedded metric format inside log lines | CloudWatch Metrics |
| **Distributed traces** | Subsegments per AWS SDK call, custom code, and cross-Lambda hops | X-Ray Trace Map, Application Signals |

Both language tracks rely on **AWS Lambda Powertools** at the wire level.
Python uses Powertools directly. TypeScript uses an **Effect** wrapper on top
of Powertools so the same logger / tracer / metrics surface is reachable from
idiomatic Effect code (`Effect.logInfo`, `Effect.withSpan`, `Metric.update`).

---

## Prerequisites

1. **Lambda execution role** with permissions for:
   - `logs:CreateLogStream`, `logs:PutLogEvents` (CloudWatch Logs)
   - `xray:PutTraceSegments`, `xray:PutTelemetryRecords` (X-Ray)
2. **Active tracing** on the Lambda function (`tracingMode = Active`). This is
   what makes X-Ray context propagate **for free** through SQS, SNS, and
   EventBridge via the `AWSTraceHeader` system attribute — no manual W3C
   tracecontext extraction required.
3. **Powertools Lambda layer** attached to the function. Pin a specific
   version per region. Example ARNs (eu-west-3, arm64):

   ```
   arn:aws:lambda:eu-west-3:017000801446:layer:AWSLambdaPowertoolsPythonV3-python312-arm64:32
   arn:aws:lambda:eu-west-3:094274105915:layer:AWSLambdaPowertoolsTypeScriptV2:47
   ```

   Discover the latest version with:

   ```sh
   aws lambda list-layer-versions --region <region> \
     --layer-name AWSLambdaPowertoolsPythonV3-python312-arm64 --max-items 1
   ```

4. **Environment variables** (set on the Lambda):
   - `POWERTOOLS_SERVICE_NAME=my-service` (used by all three signals)
   - `POWERTOOLS_METRICS_NAMESPACE=my-namespace` (CloudWatch Metrics namespace)
   - `POWERTOOLS_LOG_LEVEL=INFO` (or `DEBUG` to see debug events)

---

## Python (Powertools)

### Setup

The Powertools layer brings `aws-lambda-powertools` onto `sys.path`. No
`pip install` needed for runtime; for local typing, install the package as a
dev dependency.

```python
from aws_lambda_powertools import Logger, Metrics, Tracer
from aws_lambda_powertools.metrics import MetricUnit

logger = Logger()    # service name from POWERTOOLS_SERVICE_NAME
tracer = Tracer()    # auto-patches boto3, botocore, aiohttp, requests
metrics = Metrics()  # namespace from POWERTOOLS_METRICS_NAMESPACE
```

### Logger

```python
@logger.inject_lambda_context(log_event=False)
def handler(event, context):
    logger.info("order_received", extra={"orderId": "abc"})
    logger.warning("high_amount", extra={"orderId": "abc", "amountCents": 250000})
    logger.error("validation_failed", extra={"orderId": "abc", "reason": "negative"})
    logger.debug("payload_serialized", extra={"bytes": 187})
```

What you get for free with `inject_lambda_context`:

- `correlation_id` field set to the **X-Ray trace id** — joins logs across
  every Lambda in the same trace
- `function_arn`, `function_name`, `function_memory_size`, `cold_start`
- `service` field from `POWERTOOLS_SERVICE_NAME`

Convention: use a short snake_case **event key** as the message
(`"order_received"`), put structured data in `extra={...}`. This makes Logs
Insights queries trivial:

```
fields @timestamp, level, correlation_id, orderId, amountCents
| filter message = "high_amount"
| sort @timestamp desc
```

### Tracer

```python
sqs = boto3.client("sqs")  # automatically captured as a CLIENT subsegment

@tracer.capture_method
def _build_order() -> dict:
    return {"orderId": "..."}

@tracer.capture_lambda_handler
def handler(event, context):
    order = _build_order()
    tracer.put_annotation("orderId", order["orderId"])  # indexed, queryable
    tracer.put_metadata("order", order)                  # stored, not indexed
    sqs.send_message(QueueUrl=..., MessageBody=...)      # auto-traced
```

- `@capture_lambda_handler` opens the root segment and closes it.
- `@capture_method` opens a named subsegment around any function.
- **Annotations** (key/value, ≤500 chars) are indexed for filtering in the
  X-Ray console and in Insights queries. Use them for the few high-value
  fields you want to filter on (`orderId`, `customerId`, `region`).
- **Metadata** (arbitrary JSON, large) is attached to the segment but not
  indexed. Use it for full payloads, debug context, lists.
- **AWS SDK calls auto-trace**: `boto3.client(...)` is patched at import
  time. Every call becomes a `CLIENT` subsegment with service, operation,
  region, response code, and retry count.

### Metrics (EMF)

```python
@metrics.log_metrics(capture_cold_start_metric=True)
def handler(event, context):
    metrics.add_metric(name="OrdersEmitted", unit=MetricUnit.Count, value=1)
    metrics.add_metric(name="PayloadBytes", unit=MetricUnit.Bytes, value=187)
    metrics.add_metric(name="EmitLatencyMs", unit=MetricUnit.Milliseconds, value=12.3)
```

- `@log_metrics` flushes the buffered metrics as a single EMF JSON line at
  handler exit. Without this decorator nothing is emitted.
- `capture_cold_start_metric=True` adds a `ColdStart` counter (1 on the
  first invocation per container, 0 thereafter).
- **Per-emission dimensions** with `metrics.add_dimension(name, value)`.
  Dimensions multiply cardinality, so keep them low — `region`,
  `environment`, `event_type`, **never** `orderId`.

### Full Python handler

```python
import json
import os
import time
import uuid
from datetime import datetime, timezone

import boto3
from aws_lambda_powertools import Logger, Metrics, Tracer
from aws_lambda_powertools.metrics import MetricUnit

logger = Logger()
tracer = Tracer()
metrics = Metrics()

QUEUE_URL = os.environ["QUEUE_URL"]
sqs = boto3.client("sqs")

HIGH_AMOUNT_CENTS = 100_000


@tracer.capture_method
def _build_order() -> dict:
    return {
        "orderId": str(uuid.uuid4()),
        "amountCents": 12345,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }


@tracer.capture_method
def _send_order(order: dict) -> None:
    sqs.send_message(QueueUrl=QUEUE_URL, MessageBody=json.dumps(order))


@logger.inject_lambda_context(log_event=False)
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def handler(event, _context):
    order = _build_order()
    tracer.put_annotation("orderId", order["orderId"])
    tracer.put_metadata("order", order)

    started = time.perf_counter()
    _send_order(order)
    elapsed_ms = (time.perf_counter() - started) * 1000

    metrics.add_metric(name="OrdersEmitted", unit=MetricUnit.Count, value=1)
    metrics.add_metric(name="EmitLatencyMs", unit=MetricUnit.Milliseconds, value=elapsed_ms)

    if order["amountCents"] >= HIGH_AMOUNT_CENTS:
        logger.warning("high_amount", extra={
            "orderId": order["orderId"],
            "amountCents": order["amountCents"],
        })

    logger.info("order_emitted", extra={
        "orderId": order["orderId"],
        "elapsedMs": round(elapsed_ms, 2),
    })
    return {"orderId": order["orderId"]}
```

The decorator order matters: `inject_lambda_context` (outermost) →
`capture_lambda_handler` → `log_metrics` (innermost). This way the trace id
is set before the first log line is emitted and metrics flush before the
trace closes.

---

## TypeScript (Effect + Powertools bridge)

This track wraps Powertools' three SDKs in an Effect layer so handlers can
write `Effect.logInfo(...)`, `Effect.withSpan(...)`, and
`yield* Metric.update(...)` and have everything land in CloudWatch / X-Ray
the same way Python does. The bridge code lives at
[`lambdas/shared/effect-powertools/`](lambdas/shared/effect-powertools).

### Setup

```ts
import { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import { Metrics as PowertoolsMetricsCtor } from "@aws-lambda-powertools/metrics";
import { Tracer as PowertoolsTracer } from "@aws-lambda-powertools/tracer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { PowertoolsLayer } from "./effect-powertools";

const ptLogger = new PowertoolsLogger();
const ptTracer = new PowertoolsTracer();
const ptMetrics = new PowertoolsMetricsCtor();

const layer = PowertoolsLayer({
  logger: ptLogger,
  tracer: ptTracer,
  metrics: ptMetrics,
});

const runtime = ManagedRuntime.make(layer);

process.on("SIGTERM", () => {
  runtime.dispose().finally(() => process.exit(0));
});
```

The Powertools instances and the Effect runtime are constructed **at module
scope**, so they survive across warm invocations — no per-invocation setup
cost. `SIGTERM` lets the runtime flush any scoped resources during the ~500
ms graceful-shutdown window Lambda gives a container before recycling it.

### Logging

```ts
yield* Effect.logInfo("order_received").pipe(
  Effect.annotateLogs({ orderId: order.orderId, messageId: record.messageId }),
);

yield* Effect.logWarning("high_amount").pipe(
  Effect.annotateLogs({ orderId: order.orderId, amountCents: order.amountCents }),
);

yield* Effect.logError("validation_failed").pipe(
  Effect.annotateLogs({ orderId: order.orderId, reason: "negative_amount" }),
);
```

Effect's log levels map to Powertools methods:

| Effect | Powertools |
|---|---|
| `logFatal` | `critical` |
| `logError` | `error` |
| `logWarning` | `warn` |
| `logInfo` | `info` |
| `logDebug` / `logTrace` | `debug` |

`annotateLogs` fields land as top-level extras on the JSON log line.
`correlation_id`, `function_arn`, and the Lambda context come from the
Powertools logger automatically — call `ptLogger.addContext(context)` once
in the handler.

When an `Effect` fails inside a span and you log the failure with
`Effect.tapError(...)`, the bridge formats the cause via `Cause.pretty` and
attaches it to the log line as `cause`.

### Tracing

```ts
const observeRecord = (record: S3EventRecord) =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan("orderId", record.s3.object.key);
    // ... business logic ...
  }).pipe(
    Effect.withSpan("observeRecord", {
      attributes: {
        bucket: record.s3.bucket.name,
        key: record.s3.object.key,
      },
    }),
  );
```

`Effect.withSpan` opens an X-Ray subsegment with the given name and
attributes. `Effect.annotateCurrentSpan` adds X-Ray annotations (the indexed
kind) to the current span.

The bridge handles span lifecycle: a successful Effect closes the
subsegment cleanly; a failed Effect calls `addError(Cause.pretty(cause))`
and sets the **fault flag** (or **error flag** for typed failures). That
turns the span red in the X-Ray Trace Map automatically.

For AWS SDK calls, keep using the Powertools tracer's
`captureAWSv3Client` — it adds a `CLIENT` subsegment for every SDK call
under whichever Effect span is currently active:

```ts
const s3 = ptTracer.captureAWSv3Client(new S3Client({}));
```

### Metrics

The bridge exports thin wrappers around Effect's `Metric` API that pre-tag
the unit so the EMF emission carries the right CloudWatch unit:

```ts
import { counter, histogram, gauge, frequency, timed } from "./effect-powertools";
import { MetricUnit } from "@aws-lambda-powertools/metrics";
import * as Metric from "effect/Metric";

const ordersObserved = counter("OrdersObserved", { unit: MetricUnit.Count });
const orderAmountHistogram = histogram(
  "OrderAmountCents",
  [100, 500, 1000, 5000, 10000, 50000, 100000],
  { unit: MetricUnit.NoUnit },
);
const observeLatency = Metric.timer("ObserveLatency");
const eventLoopLag = gauge("EventLoopLagMs", { unit: MetricUnit.Milliseconds });
```

Emit values:

```ts
yield* Metric.update(ordersObserved, 1);
yield* Metric.update(orderAmountHistogram, order.amountCents);
yield* Metric.update(eventLoopLag, lagSample);
```

Wrap a whole effect in a timer:

```ts
observeRecord(record).pipe(
  Metric.trackDuration(observeLatency),
)
```

Add **per-emission dimensions** by tagging the metric:

```ts
const rejected = counter("OrdersRejected", { unit: MetricUnit.Count });
const rejectedNegative = Metric.tagged(rejected, "reason", "negative_amount");
yield* Metric.update(rejectedNegative, 1);
```

The bridge strips the `unit` / `time_unit` tags (they carry the unit, not a
dimension) and forwards every other tag as a Powertools dimension via
`metrics.singleMetric()`.

### Imperative escape hatches

For the handful of operations that don't fit Effect's `Metric.*` API
(adding a static dimension to all metrics in the invocation, capturing
cold start, manually flushing), the bridge exposes a service:

```ts
import { PowertoolsMetricsService } from "./effect-powertools";

Effect.gen(function* () {
  const metrics = yield* PowertoolsMetricsService;
  yield* metrics.captureColdStart();
  yield* metrics.addDimension("region", process.env.AWS_REGION ?? "unknown");
  // ... handler body ...
  yield* metrics.flush();
})
```

In practice the cold-start counter and the final flush are cleaner to call
on the Powertools instance directly at the handler boundary
(`ptMetrics.captureColdStartMetric()` / `ptMetrics.publishStoredMetrics()`),
keeping the Effect body pure — see the handler skeleton below.

### Full TypeScript handler

```ts
import { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import {
  Metrics as PowertoolsMetricsCtor,
  MetricUnit,
} from "@aws-lambda-powertools/metrics";
import { Tracer as PowertoolsTracer } from "@aws-lambda-powertools/tracer";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Context, S3Event, S3EventRecord } from "aws-lambda";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Metric from "effect/Metric";

import { counter, histogram, PowertoolsLayer } from "./effect-powertools";

const ptLogger = new PowertoolsLogger();
const ptTracer = new PowertoolsTracer();
const ptMetrics = new PowertoolsMetricsCtor();

const s3 = ptTracer.captureAWSv3Client(new S3Client({}));

const runtime = ManagedRuntime.make(
  PowertoolsLayer({ logger: ptLogger, tracer: ptTracer, metrics: ptMetrics }),
);
process.on("SIGTERM", () => { runtime.dispose().finally(() => process.exit(0)); });

const ordersObserved = counter("OrdersObserved", { unit: MetricUnit.Count });
const orderAmountHistogram = histogram(
  "OrderAmountCents",
  [100, 500, 1000, 5000, 10000, 50000, 100000],
  { unit: MetricUnit.NoUnit },
);
const observeLatency = Metric.timer("ObserveLatency");

const observeRecord = (record: S3EventRecord) =>
  Effect.gen(function* () {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    const response = yield* Effect.tryPromise(() =>
      s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })),
    );
    const text = yield* Effect.tryPromise(() =>
      response.Body!.transformToString(),
    );
    const order = JSON.parse(text) as { orderId: string; amountCents: number };

    yield* Metric.update(ordersObserved, 1);
    yield* Metric.update(orderAmountHistogram, order.amountCents);
    yield* Effect.annotateCurrentSpan("orderId", order.orderId);
    yield* Effect.logInfo("order_observed").pipe(
      Effect.annotateLogs({ orderId: order.orderId, amountCents: order.amountCents }),
    );
  }).pipe(
    Metric.trackDuration(observeLatency),
    Effect.withSpan("observeRecord", {
      attributes: { bucket: record.s3.bucket.name, key: record.s3.object.key },
    }),
    Effect.tapError((error) =>
      Effect.logError("observe_failed").pipe(
        Effect.annotateLogs({ error: String(error) }),
      ),
    ),
  );

export const handler = async (event: S3Event, context: Context): Promise<void> => {
  ptMetrics.captureColdStartMetric();
  ptLogger.addContext(context);
  try {
    for (const record of event.Records) {
      await runtime.runPromise(
        observeRecord(record).pipe(Effect.catchAll(() => Effect.void)),
      );
    }
  } finally {
    ptMetrics.publishStoredMetrics();
  }
};
```

The handler boundary is intentionally tiny: cold-start capture, context
binding, loop, flush. The Effect program inside `observeRecord` is what you
extend with new logic.

---

## Cross-cutting: end-to-end correlation

Once both producer and consumer Lambdas have `tracingMode = Active`, the
X-Ray context is carried **automatically** through:

- **SQS**: `AWSTraceHeader` system attribute — set on `SendMessage`, read on
  poll
- **SNS**: same `AWSTraceHeader` attribute
- **EventBridge**: same
- **HTTP via the AWS SDK**: `X-Amzn-Trace-Id` header

No code changes, no manual W3C tracecontext extraction. The same trace id
appears as the `correlation_id` field on the log lines in **every** Lambda
in the chain, so you can pivot from a metric anomaly to logs to traces:

```
fields @timestamp, level, correlation_id, message, orderId
| filter correlation_id = "1-66400000-aabbccddeeff0011"
| sort @timestamp asc
```

---

## Where to look in the AWS console

| Surface | What you see |
|---|---|
| **CloudWatch → Log groups → `/aws/lambda/<fn>`** | Structured Powertools JSON: `service`, `level`, `correlation_id`, `cold_start`, `function_arn`, message key, plus your `extra` / `annotateLogs` fields |
| **CloudWatch → Logs Insights** | Run cross-function queries joined on `correlation_id` |
| **CloudWatch → Metrics → `<your namespace>`** | Custom EMF metrics with `service` dimension; `ColdStart` counter |
| **CloudWatch → X-Ray → Trace Map** | Service edges (Lambda → SQS → Lambda → S3) with latency / error overlays |
| **CloudWatch → X-Ray → Traces** | Per-trace timeline of subsegments, annotations, metadata |
| **CloudWatch → Application Signals → SLOs** | Metric-based SLOs (latency P95, availability) attainment |
| **CloudWatch → Application Signals → Service Map** | **Empty** for Powertools-only deployments — needs ADOT/OTel layers. Use the X-Ray Trace Map instead |
| **CloudWatch → Lambda Insights** | Enhanced per-function metrics (CPU, memory, init duration) if the Lambda Insights extension layer is attached |

---

## Worked examples in this repo

The handlers in this repo implement the patterns above end-to-end. Read them
alongside this guide:

- [`lambdas/python/src/handler.py`](lambdas/python/src/handler.py) — Python
  producer (Powertools direct)
- [`lambdas/typescript/src/handler.ts`](lambdas/typescript/src/handler.ts) —
  TypeScript SQS consumer (Effect + bridge)
- [`lambdas/typescript-s3/src/handler.ts`](lambdas/typescript-s3/src/handler.ts) —
  TypeScript S3-triggered observer (Effect + bridge)
- [`lambdas/shared/effect-powertools/`](lambdas/shared/effect-powertools) —
  the Effect ↔ Powertools bridge implementation, shared by both TypeScript
  Lambdas
