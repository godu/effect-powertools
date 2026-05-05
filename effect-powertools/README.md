# effect-powertools

An [Effect](https://effect.website/) ↔ [AWS Lambda Powertools](https://docs.powertools.aws.dev/lambda/typescript/latest/) bridge for TypeScript Lambdas. Effect's Logger, Tracer, and Metric primitives flow through Powertools so your structured logs land in CloudWatch, your spans become X-Ray subsegments, and your metric updates emit EMF blobs — all without leaving the Effect API.

## Table of contents

1. [Overview](#overview)
2. [Quick start](#quick-start)
3. [Layers & services](#layers--services)
4. [Metric helpers](#metric-helpers)
5. [`createHandler` (generic)](#createhandler-generic)
6. [`createSqsHandler` (SQS sugar)](#createsqshandler-sqs-sugar)
7. [Batch processors](#batch-processors)
8. [TanStack Start subpath](#tanstack-start-subpath)
9. [Caveats](#caveats)

## Overview

This package wraps `@aws-lambda-powertools/{logger,metrics,tracer}` so they're addressable through the Effect runtime instead of as raw global instances. You get:

- **Logger bridge** — Effect's `Logger.defaultLogger` is replaced with one that calls `powertoolsLogger.info(...)` / `.error(...)` / etc. The Effect log level maps to the Powertools method; annotations + spans + cause traces flow through as the structured `extras` object.
- **Tracer bridge** — Effect spans become X-Ray subsegments. A per-step `cls-hooked` namespace pins the right segment to each fiber so concurrent `Effect.forEach({ concurrency: "unbounded" })` branches keep their AWS SDK leaf subsegments correctly nested.
- **Metrics bridge** — Effect's `globalMetricRegistry` is monkey-patched once at load. Every counter / gauge / histogram / frequency update forwards to `powertoolsMetrics.addMetric(...)`. Units travel as Effect metric tags (`unit:Bytes`, `time_unit:milliseconds`).
- **Handler factories** — `createHandler` and `createSqsHandler` wrap the cold-start, `addContext`, parent-subsegment, and metric-flush boilerplate around any Effect program. Inputs are validated via `effect/Schema` before your code runs.
- **Batch processors** — `processPartialResponse` and `processFifoPartialResponse` give you Effect-native SQS partial-batch failures with auto-emitted `BatchRecordSuccesses` / `BatchRecordFailures` counters.
- **TanStack Start integration** — `runtimeServerFn` + `observabilityServerFn` for full-stack Lambda apps that serve SSR pages and API endpoints from the same function.

## Quick start

```ts
import { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import { Metrics as PowertoolsMetrics } from "@aws-lambda-powertools/metrics";
import { Tracer as PowertoolsTracer } from "@aws-lambda-powertools/tracer";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createSqsHandler, PowertoolsLayer } from "effect-powertools";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// 1. Schema for your message body. `Schema.parseJson` parses the raw string.
const Order = Schema.Struct({
  orderId: Schema.String,
  customerId: Schema.String,
  amountCents: Schema.Number,
  createdAt: Schema.String,
});
const OrderFromBody = Schema.parseJson(Order);

// 2. Construct Powertools instances at module scope so `captureAWSv3Client`
//    can wrap the AWS SDK client at load time and your handler shares the
//    same tracer instance.
const ptLogger = new PowertoolsLogger();
const ptTracer = new PowertoolsTracer();
const ptMetrics = new PowertoolsMetrics();

const s3 = ptTracer.captureAWSv3Client(new S3Client({}));

// 3. Build the layer once, hand it to the factory.
export const handler = createSqsHandler(
  {
    layer: PowertoolsLayer({ logger: ptLogger, tracer: ptTracer, metrics: ptMetrics }),
    recordSchema: OrderFromBody,
    serviceName: "orders",
  },
  (order, record) =>
    Effect.gen(function* () {
      yield* Effect.logInfo("order_received").pipe(
        Effect.annotateLogs({ orderId: order.orderId, messageId: record.messageId }),
      );
      yield* Effect.tryPromise(() =>
        s3.send(
          new PutObjectCommand({
            Bucket: process.env.DATA_BUCKET!,
            Key: `orders/${order.orderId}.json`,
            Body: record.body,
          }),
        ),
      );
    }),
);
```

The handler returns `{ batchItemFailures: [...] }` per the SQS partial-batch protocol. Schema decode failures land in `batchItemFailures` automatically — SQS retries (or DLQs) only the failed messages.

## Layers & services

### `PowertoolsLayer({ logger, tracer, metrics })`

Convenience layer that merges the three bridge layers below. Pass it to `ManagedRuntime.make(...)`, or include it in a larger `Layer.merge(PowertoolsLayer(...), AppLayer)` and hand the merged layer to `createHandler` / `createSqsHandler`.

### `PowertoolsLoggerLayer({ logger, levelMap? })` / `PowertoolsLoggerService`

Replaces Effect's default logger so every `Effect.log{Debug,Info,Warning,Error,Fatal}` flushes via `logger.info(...)` / etc. Optional `levelMap` lets you override the default Effect → Powertools level mapping. The `PowertoolsLoggerService` tag exposes the raw Powertools `Logger` for code paths that need it (e.g. `logger.addContext(ctx)` — the handler factories already call this for you).

### `PowertoolsTracerLayer({ tracer, classifyAttribute? })` / `PowertoolsTracerService`

Replaces Effect's tracer so every span becomes an X-Ray subsegment. Span attributes default to X-Ray annotations (indexable); pass a `classifyAttribute(key, value) → "annotation" | "metadata" | "skip"` callback if you need to route some attributes to metadata or drop them. The service tag exposes the raw `Tracer` for direct interaction (`getSegment`, `setSegment`, `captureAWSv3Client`).

### `PowertoolsMetricsLayer({ metrics })` / `PowertoolsMetricsService`

Patches Effect's global metric registry once per process. Every counter / gauge / histogram / frequency update forwards to `metrics.addMetric(...)`. The service tag exposes Effect-wrapped helpers: `addDimension`, `addMetadata`, `captureColdStart`, `flush`. The handler factories call `flush()` at end-of-invocation; you only need this tag for ad-hoc dimension or metadata pushes inside your program.

## Metric helpers

Pre-tagged constructors that automatically attach a `unit:<MetricUnit>` tag the bridge will read on emission:

```ts
import { counter, gauge, histogram, frequency, timed } from "effect-powertools";
import { MetricUnit } from "@aws-lambda-powertools/metrics";

const ordersWritten = counter("OrdersWritten", { unit: MetricUnit.Count });
const memoryBytes = gauge("MemoryBytes", { unit: MetricUnit.Bytes });
const orderAmountHistogram = histogram(
  "OrderAmountHistogram",
  [100, 1_000, 10_000, 100_000, 1_000_000],
  { unit: MetricUnit.Count },
);
const orderShape = frequency("OrderShape");

// `timed` bundles a count + duration timer around an Effect:
const writeOne = timed("OrderProcess", putToS3(order));
```

Recognized unit tags: any value from `@aws-lambda-powertools/metrics`'s `MetricUnit`, plus `time_unit` (auto-attached by Effect's `Metric.timer`) supporting `nanoseconds` / `microseconds` / `milliseconds` / `seconds`. Unknown units fall back to `Count`. Other tags become Powertools dimensions via `metrics.singleMetric()`.

## `createHandler` (generic)

Lambda handler factory for any event type — HTTP API Gateway, EventBridge, S3, scheduled events, etc. Wraps observability boilerplate, validates the event with an `effect/Schema`, and runs your Effect program with the Lambda subsegment set as the parent span.

```ts
import { createHandler, PowertoolsLayer } from "effect-powertools";
import * as Schema from "effect/Schema";

const ApiEvent = Schema.Struct({
  body: Schema.String,
  headers: Schema.Record({ key: Schema.String, value: Schema.String }),
});

export const handler = createHandler(
  {
    schema: ApiEvent,
    layer: PowertoolsLayer({ logger, tracer, metrics }),
    serviceName: "orders-api",
  },
  (event, _context) =>
    Effect.succeed({ statusCode: 200, body: `Got ${event.body.length} bytes` }),
);
```

| Option | Type | Purpose |
|---|---|---|
| `schema` | `Schema.Schema<A, I, never>` | Decodes the raw Lambda event. `ParseError` → typed Effect failure → invocation throws (Lambda treats as failed). |
| `layer` | `Layer.Layer<PowertoolsBridge \| R, E>` | Must produce the three bridge services. Compose with `PowertoolsLayer({...})` and any app layers. |
| `serviceName` | `string?` | Used for the `## ${serviceName}` X-Ray subsegment. Defaults to `context.functionName`. |
| `before` | `Effect<unknown, unknown, R \| PowertoolsBridge>?` | Runs once per invocation, after acquire and before your program (e.g. memory sample, cold-start metric). |

The runtime is built once at module load via `ManagedRuntime.make(opts.layer)` and a SIGTERM disposer is registered (idempotently) so Lambda's freeze/thaw cycle doesn't leak listeners.

## `createSqsHandler` (SQS sugar)

SQS-specialized factory built on `createHandler` + the batch processors. Validates each record's `body` via `recordSchema`, routes decode failures to `batchItemFailures`, and runs successful records through your handler.

```ts
const Order = Schema.Struct({
  orderId: Schema.String,
  amountCents: Schema.Number,
});
const OrderFromBody = Schema.parseJson(Order);

export const handler = createSqsHandler(
  {
    layer: PowertoolsLayer({ logger, tracer, metrics }),
    recordSchema: OrderFromBody,
    serviceName: "orders",
    concurrency: "unbounded",   // default
    fifo: false,                // default
  },
  (order, record) => writeOne(order, record),
);
```

| Option | Type | Purpose |
|---|---|---|
| `recordSchema` | `Schema.Schema<A, I, never>` | Decodes `record.body`. Use `Schema.parseJson(YourSchema)` for JSON payloads. Decode failures land in `batchItemFailures`. |
| `layer` | `Layer.Layer<PowertoolsBridge \| R, E>` | Same as `createHandler`. |
| `serviceName` | `string?` | Same as `createHandler`. |
| `fifo` | `boolean?` | If `true`, processes records strictly in order and short-circuits on first failure (every subsequent record is marked failed). Matches Powertools `SqsFifoPartialProcessor` semantics. Default `false`. |
| `concurrency` | `number \| "unbounded"?` | Non-FIFO only. Forwarded to `Effect.forEach`. Default `"unbounded"`. |
| `beforeBatch` | `Effect<unknown, unknown, R \| PowertoolsBridge>?` | Runs once per invocation, before the batch loop (e.g. memory sample, dimension push). |
| `onRecordFailure` | `(record, cause) => Effect<void, never, ...>?` | Custom hook for each failed record. Runs after the auto-emitted log + counter. |

### Sharing the tracer with `captureAWSv3Client`

Declare the Powertools instances at module scope so `ptTracer.captureAWSv3Client(...)` can wrap the AWS SDK client at load time, then hand those same instances to `PowertoolsLayer({...})`:

```ts
const ptTracer = new PowertoolsTracer();
const s3 = ptTracer.captureAWSv3Client(new S3Client({}));   // wraps once, at load time

export const handler = createSqsHandler(
  {
    layer: PowertoolsLayer({ logger: new Logger(), tracer: ptTracer, metrics: new Metrics() }),
    // ...
  },
  (order, record) => putObject(s3, order, record),
);
```

The factory reads the bridge instances back through the layer at runtime, so there's exactly one source of truth per process.

## Batch processors

Standalone building blocks for SQS partial-batch failures. `createSqsHandler` uses them internally; export them for cases where you need a custom acquire/release lifecycle.

### `processPartialResponse(event, recordHandler, options?)`

Parallel processing with configurable concurrency:

```ts
import { processPartialResponse } from "effect-powertools";

const program = processPartialResponse(
  event,
  (record) => writeOne(JSON.parse(record.body)),
  { concurrency: "unbounded" },
);
// program: Effect.Effect<SQSBatchResponse, never, ...>
```

### `processFifoPartialResponse(event, recordHandler, options?)`

Strictly sequential. On the first failure, every subsequent record is marked failed without being processed — this preserves FIFO ordering across SQS retries (a later message in a MessageGroup can't succeed before an earlier one).

### Auto-emitted metrics

Both processors emit two counters:

| Metric | When |
|---|---|
| `BatchRecordSuccesses` | Every record whose handler returns `Exit.Success`. |
| `BatchRecordFailures` | Every record whose handler returns `Exit.Failure`, including FIFO short-circuit skips. |

If you need different metric names, wrap the processors and increment your own counters instead.

## TanStack Start subpath

For full-stack TanStack Start Lambdas (SSR + API endpoints in one function), import from the `effect-powertools/tanstack-start` subpath:

```ts
import { runtimeServerFn, observabilityServerFn } from "effect-powertools/tanstack-start";
```

- **`runtimeServerFn(layer)`** — builds a `ManagedRuntime` once and injects it into TanStack's `ctx.context.runtime`. SIGTERM disposer registered idempotently.
- **`observabilityServerFn(opts?)`** — TanStack server-fn equivalent of `createHandler`'s observability lifecycle. Opens a `## ${request.method} ${pathname}` subsegment, populates the X-Ray segment-document `http` block from the `Request`, and re-raises errors verbatim across the Effect boundary.

Wire them at the call site so TanStack's type inference flows through the middleware chain end-to-end.

## Caveats

### cls-hooked tracer is process-global

The X-Ray "current segment" lives inside `aws-xray-sdk-core`'s `cls-hooked` namespace, which is process-global. The tracer bridge opens a fresh namespace context per Effect step in `tracer.ts:context(execution, fiber)` — this is what lets concurrent fibers keep their AWS SDK leaf subsegments correctly nested.

**Implications:**
- Inside a Lambda invocation: works as expected, including `Effect.forEach({ concurrency: "unbounded" })`.
- Outside Lambda (local dev, Fargate, multi-process Node, browser): there's no Lambda facade segment; `setSegment` may throw and is swallowed best-effort. Two simultaneous invocations on the same process will race the global segment.
- **Do not modify `tracer.ts`'s per-step `context(execution, fiber)` callback** without a concurrency smoke test. A regression shows up as silently corrupted X-Ray traces (wrong parent_id), not as a thrown error.

### `globalMetricRegistry` is monkey-patched once

The metrics bridge wraps Effect's `globalMetricRegistry.get` so every counter / gauge / histogram / frequency hook also forwards to Powertools EMF. This patch happens lazily on first `PowertoolsMetricsLayer` build and persists for the life of the process. Re-binding to a different `PowertoolsMetrics` instance throws (`ensureInstalled` guard) — to test hot, call `__resetForTesting()` first.

In practice: don't rebuild Powertools instances per-invocation. Construct them at module scope, pass them into `PowertoolsLayer({...})`, and let the runtime own them.

### Handler factories require all three bridge services

`createHandler` and `createSqsHandler` both `yield* PowertoolsLoggerService / TracerService / MetricsService` during acquire. If your `layer` doesn't include `PowertoolsLayer({...})` (or equivalent), the Effect will fail at runtime with a missing-service error. The TypeScript signature catches this at compile time via the `PowertoolsBridge | R` constraint.

### `@tanstack/react-start` is an optional peer dep

The `effect-powertools/tanstack-start` subpath imports from `@tanstack/react-start`. The peer dep is listed as `optional`; if you only use the main `effect-powertools` entry from a non-TanStack Lambda, you don't need to install it.
