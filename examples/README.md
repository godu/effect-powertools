# AWS Lambda Observability Guide

A reference for adding logs, traces, and metrics to AWS Lambda functions
in **Python** (AWS Lambda Powertools) and **TypeScript / Effect** (Effect
on top of an Effect↔Powertools bridge). Targets the AWS-native stack:
**CloudWatch Logs**, **CloudWatch Metrics (EMF)**, **AWS X-Ray**,
**Application Signals**.

The tables below catalogue every way to define a log, span, or metric
in either language. The two demo Lambdas in this repo exercise every
row — see [Worked example](#worked-example).

---

## Setup

| Step | Python | TypeScript / Effect |
|---|---|---|
| Lambda layer | `AWSLambdaPowertoolsPythonV3-python312-arm64` | `AWSLambdaPowertoolsTypeScriptV2` |
| Active tracing | `tracingMode = Active` (free X-Ray context propagation through SQS/SNS/EventBridge) | same |
| Service name | env: `POWERTOOLS_SERVICE_NAME=my-service` | same |
| Metrics namespace | env: `POWERTOOLS_METRICS_NAMESPACE=my-namespace` | same |
| Default log level | env: `POWERTOOLS_LOG_LEVEL=INFO` | same |
| Construct | `Logger()`, `Tracer()`, `Metrics()` at module scope | `new Logger()`, `new Tracer()`, `new Metrics()` then `PowertoolsBridgeLayer({...})` and `ManagedRuntime.make(layer)` |
| Bind Lambda context | `@logger.inject_lambda_context` | `ptLogger.addContext(context)` once at handler start |
| Flush metrics | `@metrics.log_metrics` | `ptMetrics.publishStoredMetrics()` in a `finally` |
| Cold-start counter | `@metrics.log_metrics(capture_cold_start_metric=True)` | `ptMetrics.captureColdStartMetric()` in the handler |

---

## Logs

### Severity levels

| Level | Python | TypeScript / Effect |
|---|---|---|
| DEBUG | `logger.debug("msg", extra={...})` | `Effect.logDebug("msg")` |
| INFO | `logger.info("msg", extra={...})` | `Effect.logInfo("msg")` |
| WARN | `logger.warning("msg", extra={...})` | `Effect.logWarning("msg")` |
| ERROR | `logger.error("msg", extra={...})` | `Effect.logError("msg")` |
| FATAL / CRITICAL | `logger.critical("msg", extra={...})` | `Effect.logFatal("msg")` |

### Structured fields, correlation, errors

| Capability | Python | TypeScript / Effect |
|---|---|---|
| Per-call structured fields | `extra={"orderId": ..., "amountCents": ...}` | `Effect.logInfo("...").pipe(Effect.annotateLogs({ orderId, amountCents }))` |
| Persistent fields (whole invocation) | `logger.append_keys(orderId="...")` | `Effect.locally(FiberRef.currentLogAnnotations, ...)` (or `Effect.annotateLogs` wrapping the program) |
| Trace-ID correlation field | auto via `inject_lambda_context` → `correlation_id` | auto via bridge → `correlation_id` |
| Lambda context fields | auto: `function_arn`, `function_name`, `cold_start`, `function_memory_size` | auto via `ptLogger.addContext(context)` |
| Service name field | auto from `POWERTOOLS_SERVICE_NAME` | same |
| Exception with stack | `logger.exception("msg")` inside `except` block | failed Effect inside `Effect.withSpan` — bridge runs `Cause.pretty(cause)` and attaches `cause` + `error` fields automatically |
| Sampled debug emission | `Logger(sample_rate=0.1)` enables DEBUG for 10 % of invocations | predicate via custom `Logger` layer or runtime sampling at the call site |
| Logging an object as message | `logger.info(order)` | `Effect.logInfo(JSON.stringify(order))` (or annotate fields instead) |
| Effect span context in log line | n/a (rely on `correlation_id`) | bridge adds `effect_spans: [{label, startTime}]` extra automatically when inside `Effect.withSpan` |

---

## Traces

### Spans / subsegments

| Capability | Python | TypeScript / Effect |
|---|---|---|
| Root span (Lambda invocation) | `@tracer.capture_lambda_handler` on the handler | implicit — Powertools tracer opens the root segment when active tracing is on |
| Named subsegment | `@tracer.capture_method` on a function | wrap an Effect with `.pipe(Effect.withSpan("name"))` |
| Subsegment with attributes | function args / locals visible via metadata | `Effect.withSpan("name", { attributes: { key: value } })` |
| Indexed annotation (queryable) | `tracer.put_annotation("orderId", value)` | `Effect.annotateCurrentSpan("orderId", value)` (bridge maps to X-Ray annotation) |
| Non-indexed metadata (large payloads) | `tracer.put_metadata("order", obj)` | larger objects pass through `Effect.withSpan` attributes; non-indexed by default in the bridge |
| Span event | `subsegment.put_metadata("events", [...])` (manual) | bridge `Span#event(name, ts, attrs)` accumulated as `effect_events` metadata |
| Span links (cross-trace causality) | not native in X-Ray; manual via metadata | bridge `Span#addLinks(links)` accumulated as `effect_links` metadata |
| Nested / parallel spans | nested `@capture_method` calls | nested `Effect.withSpan(...)`; `Effect.all([...], { concurrency })` for parallel branches |

### Span status / error

| Outcome | Python | TypeScript / Effect |
|---|---|---|
| Mark as **fault** (server-side error) | `subsegment.add_fault_flag()` | failed Effect with untyped defect → bridge calls `addFaultFlag()` |
| Mark as **error** (client-side error) | `subsegment.add_error_flag()` | failed Effect with **typed** failure → bridge calls `addErrorFlag()` |
| Attach exception | `subsegment.add_exception(exc)` (auto via tracer on raise) | bridge attaches `Cause.pretty(cause)` via `subsegment.addError(...)` |
| Interrupted span | n/a | `Cause.isInterruptedOnly(cause)` → bridge sets `interrupted=true` annotation |

### Auto-instrumentation

| Source | Python | TypeScript / Effect |
|---|---|---|
| AWS SDK calls | `boto3.client(...)` auto-patched at import; every call is a CLIENT subsegment | wrap each client: `tracer.captureAWSv3Client(new S3Client({}))` — every call is a CLIENT subsegment under the active Effect span |
| HTTP requests | patch `requests` / `aiohttp` via Powertools tracer hook | use `aws-xray-sdk-core` `captureHTTPsGlobal()` if needed |
| SQS / SNS / EventBridge propagation | automatic via `AWSTraceHeader` system attribute (active tracing on both sides) | same |

---

## Metrics

### Instruments

| Instrument | Python | TypeScript / Effect |
|---|---|---|
| Counter (sum) | `metrics.add_metric("OrdersEmitted", MetricUnit.Count, 1)` | `Meter.counter("OrdersWritten", { unit: MetricUnit.Count })` then `yield* Metric.update(c, 1)` |
| Histogram (explicit buckets) | `add_metric` with multiple values flushed per period; CloudWatch computes percentiles | `Meter.histogram("OrderAmountHistogram", [100, 1_000, 10_000, 100_000, 1_000_000], { unit: MetricUnit.Count })` |
| Gauge (last value wins) | emit a counter with the value; CW reduces with `Last`/`Average` | `Meter.gauge("MemoryUsedBytes", { unit: MetricUnit.Bytes })` then `yield* Metric.update(g, bytes)` |
| Timer (duration distribution) | `add_metric("WriteLatencyMs", MetricUnit.Milliseconds, ms)` | `Metric.timer("WriteLatency")` + `Metric.trackDuration(t)` as a `.pipe(...)` step |
| Frequency (string occurrence count) | n/a — emit one counter per value manually | `Meter.frequency("OrderShape")` then `yield* Metric.update(f, "normal" \| "high" \| "poison")` — bridge emits one metric per distinct value (`OrderShape.normal`, `OrderShape.high`, `OrderShape.poison`) |
| Count + duration around an Effect | wrap manually with `time.perf_counter()` | `Meter.instrument("OrderProcess", effect)` — bridge adds `OrderProcess` counter + `OrderProcessDuration` timer |
| Cold start | `@metrics.log_metrics(capture_cold_start_metric=True)` | `ptMetrics.captureColdStartMetric()` |

### Units

`MetricUnit.{Count, Bytes, Kilobytes, Megabytes, Gigabytes, Terabytes, Bits,
Milliseconds, Seconds, Microseconds, Percent, NoUnit, ...}` is the same enum
in both languages. Pick the unit that matches the value you emit; CloudWatch
displays it in the metric panel.

### Dimensions

| Scope | Python | TypeScript / Effect |
|---|---|---|
| **Static** for the whole invocation | `metrics.add_dimension("environment", "dev")` once at handler entry | `ptMetrics.addDimension("environment", "dev")` (or `PowertoolsMetricsService.addDimension` from Effect) |
| **Per-emission** (single metric, isolated dimensions) | `with single_metric("OrdersByShape", MetricUnit.Count, 1, namespace=...) as m: m.add_dimension("orderShape", shape)` | tag the metric inline: `Metric.update(Metric.tagged(ordersWritten, "orderShape", shape), 1)` |
| Service dimension | auto-added from `POWERTOOLS_SERVICE_NAME` | same (auto-added by bridge through Powertools) |

---

## Cross-cutting

- **End-to-end correlation**: `AWSTraceHeader` is set on `SendMessage` and
  read on poll **for free** when active tracing is on. The X-Ray trace ID
  appears as `correlation_id` on every log line in every Lambda in the
  chain — `filter correlation_id = "..."` in CloudWatch Logs Insights to
  join logs across hops.
- **Where to look**:
  - `/aws/lambda/<fn>` log groups → CloudWatch Logs Insights
  - `<your namespace>` in CloudWatch Metrics
  - X-Ray Trace Map (Application Signals service map is empty without
    ADOT — use the Trace Map instead)
  - Application Signals → SLOs

---

## Worked example

The repo deploys a 3-Lambda pipeline plus a unified frontend that exercises
every row above:

```
[Browser]
   │ HTTPS
   ▼
[CloudFront]
   ├── /api/*  → Lambda Function URL ─┐
   │                                  ├── unified TanStack Start Lambda
   └── /*      → Lambda Function URL ─┘   (SSR + API + static assets)
                                            │ AWS SDK Lambda Invoke
                                            │ (HTTP-traced via captureHTTPsRequests)
                                            ▼
                                          producer (TS/Effect) → SQS → consumer (TS/Effect) → S3
```

All three deployed Lambdas now run on TypeScript + Effect via the bridge. The Python tables above remain as a side-by-side reference for engineers writing Python Lambdas with `aws-lambda-powertools` directly.

- [`trigger/`](trigger) — **TanStack Start** app (latest, Vite-based) built per
  the [build-from-scratch](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch)
  guide. Serves both the React UI (SSR + hydration) and the
  `/api/trigger` endpoint from one Lambda. The API handler uses the same
  Effect↔Powertools bridge as the consumer — all 5 log levels, nested
  `Effect.withSpan`, every bridge metric helper, `Metric.tagged` for
  per-emission dimensions, and `captureHTTPsRequests: true` on the
  Powertools tracer so the AWS SDK Lambda Invoke shows up as an HTTPS
  subsegment in the X-Ray trace.
- [`producer/src/handler.ts`](producer/src/handler.ts) — TypeScript/Effect
  producer using `createLambdaHandler` from `effect-powertools`. Validates the
  trigger event via `Schema.Struct`, generates a synthetic order, sends to
  SQS via `tracer.captureAWSv3Client`-wrapped `@aws-sdk/client-sqs`. Emits
  Count / Bytes / Milliseconds metrics with `Metric.tagged` per-emission
  dimensions.
- [`consumer/src/handler.ts`](consumer/src/handler.ts) — TypeScript/Effect
  consumer using `createSqsLambdaHandler` from `effect-powertools`. Schema-validates
  each record body via `Schema.parseJson(Order)`. All 5 log levels, nested
  `Effect.withSpan`, `Effect.annotateCurrentSpan`, `Effect.tapError`,
  every `Meter` helper (counter, histogram, gauge, frequency, timer,
  `Meter.instrument`), per-emission dimension via `Metric.tagged`, partial-batch failure
  via the bridge's `processPartialResponse` → `batchItemFailures`.
- [`../effect-powertools/`](../effect-powertools) — the Effect↔Powertools
  bridge.

The app's Function URL has `AuthType: NONE` for simplicity; in a
production setup you'd lock it to CloudFront-only via OAC + a request
signing policy.
