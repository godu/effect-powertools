import { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import {
  Metrics as PowertoolsMetricsCtor,
  MetricUnit,
} from "@aws-lambda-powertools/metrics";
import { Tracer as PowertoolsTracer } from "@aws-lambda-powertools/tracer";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { SQSRecord } from "aws-lambda";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Schema from "effect/Schema";

import {
  type AttributeKind,
  createSqsLambdaHandler,
  Meter,
  PowertoolsLoggerLayer,
  PowertoolsMetricsLayer,
  PowertoolsTracerLayer,
} from "effect-powertools";

const ptLogger = new PowertoolsLogger();
const ptTracer = new PowertoolsTracer();
const ptMetrics = new PowertoolsMetricsCtor();

const s3 = ptTracer.captureAWSv3Client(new S3Client({}));

const BUCKET = process.env.DATA_BUCKET;
if (!BUCKET) throw new Error("DATA_BUCKET env var is required");

const Order = Schema.Struct({
  orderId: Schema.String,
  customerId: Schema.String,
  amountCents: Schema.Number,
  createdAt: Schema.String,
});
type Order = typeof Order.Type;
const OrderFromBody = Schema.parseJson(Order);

const ordersWritten = Meter.counter("OrdersWritten", {
  unit: MetricUnit.Count,
});
const orderAmountCents = Meter.counter("OrderAmountCents", {
  unit: MetricUnit.Count,
});
const orderAmountHistogram = Meter.histogram(
  "OrderAmountHistogram",
  [100, 1_000, 10_000, 100_000, 1_000_000],
  {
    unit: MetricUnit.Count,
    description: "Distribution of accepted order amounts (cents)",
  },
);
const writeLatency = Metric.timer("WriteLatency");
const recordsRejected = Meter.counter("RecordsRejected", {
  unit: MetricUnit.Count,
});
const recordFailures = Meter.counter("RecordFailures", {
  unit: MetricUnit.Count,
});
const memoryUsedBytes = Meter.gauge("MemoryUsedBytes", {
  unit: MetricUnit.Bytes,
});
const orderShapeFreq = Meter.frequency("OrderShape");

// X-Ray annotations are indexed (queryable in the X-Ray console) but bounded
// in size. Route any attribute keyed under `payload.*` to *metadata*
// instead — metadata is non-indexed and tolerates large values such as raw
// SQS message bodies. Anything else stays an annotation.
const classifyAttribute = (key: string): AttributeKind =>
  key.startsWith("payload.") ? "metadata" : "annotation";

// Direct per-component layer construction (vs. `PowertoolsBridgeLayer`)
// so we can pass `classifyAttribute` to the tracer. Equivalent to the
// aggregate when no customization is needed.
const observabilityLayer = Layer.mergeAll(
  PowertoolsLoggerLayer({ logger: ptLogger }),
  PowertoolsTracerLayer({ tracer: ptTracer, classifyAttribute }),
  PowertoolsMetricsLayer({ metrics: ptMetrics }),
);

// `tag` from `Cause.failureOrCause` for fault-vs-error attribution on the
// failure metric. Defects (untyped throws) bucket as "fault"; typed
// failures bucket under their `_tag` if present.
const classifyCause = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.failureOption(cause);
  if (failure._tag === "None") return "fault";
  const value = failure.value;
  if (typeof value === "object" && value !== null && "_tag" in value) {
    return String((value as { _tag: unknown })._tag);
  }
  return "error";
};

class PoisonOrderError {
  readonly _tag = "PoisonOrderError";
  constructor(
    readonly props: {
      readonly orderId: string;
      readonly amountCents: number;
    },
  ) {}
  toString() {
    return `PoisonOrderError(${this.props.orderId}): amountCents=${this.props.amountCents}`;
  }
}

class PutObjectError {
  readonly _tag = "PutObjectError";
  constructor(
    readonly props: {
      readonly orderId: string;
      readonly cause: string;
    },
  ) {}
  toString() {
    return `PutObjectError(${this.props.orderId}): ${this.props.cause}`;
  }
}

const classifyShape = (amount: number): string => {
  if (amount < 0) return "poison";
  if (amount >= 100_000) return "high";
  return "normal";
};

const putToS3 = (order: Order, body: string) =>
  Effect.tryPromise({
    try: () =>
      s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: `orders/${order.orderId}.json`,
          Body: body,
          ContentType: "application/json",
        }),
      ),
    catch: (error) =>
      new PutObjectError({ orderId: order.orderId, cause: String(error) }),
  }).pipe(
    Effect.withSpan("s3.putObject", {
      attributes: {
        bucket: BUCKET,
        key: `orders/${order.orderId}.json`,
      },
    }),
    Metric.trackDuration(writeLatency),
  );

const writeOne = (order: Order, record: SQSRecord) =>
  Meter.instrument(
    "OrderProcess",
    Effect.gen(function* () {
      yield* Effect.logDebug("record_received").pipe(
        Effect.annotateLogs({ messageId: record.messageId }),
      );

      const shape = classifyShape(order.amountCents);

      yield* Effect.annotateCurrentSpan("orderId", order.orderId);
      yield* Effect.annotateCurrentSpan("orderShape", shape);

      yield* Metric.update(orderShapeFreq, shape);

      yield* Effect.logInfo("order_received").pipe(
        Effect.annotateLogs({
          orderId: order.orderId,
          messageId: record.messageId,
          orderShape: shape,
        }),
      );

      if (order.amountCents < 0) {
        yield* Metric.update(recordsRejected, 1);
        yield* Effect.logFatal("poison_rejected").pipe(
          Effect.annotateLogs({
            orderId: order.orderId,
            amountCents: order.amountCents,
          }),
        );
        return yield* Effect.fail(
          new PoisonOrderError({
            orderId: order.orderId,
            amountCents: order.amountCents,
          }),
        );
      }

      if (order.amountCents >= 100_000) {
        yield* Effect.logWarning("high_amount").pipe(
          Effect.annotateLogs({
            orderId: order.orderId,
            amountCents: order.amountCents,
          }),
        );
      }

      yield* putToS3(order, record.body);

      yield* Metric.update(
        Metric.tagged(ordersWritten, "orderShape", shape),
        1,
      );
      yield* Metric.update(
        Metric.tagged(orderAmountCents, "orderShape", shape),
        order.amountCents,
      );
      yield* Metric.update(
        Metric.tagged(orderAmountHistogram, "orderShape", shape),
        order.amountCents,
      );

      yield* Effect.logInfo("order_written").pipe(
        Effect.annotateLogs({ orderId: order.orderId }),
      );
    }),
  ).pipe(
    Effect.withSpan("writeOne", {
      attributes: {
        messageId: record.messageId,
        // `payload.*` keys land in X-Ray metadata via `classifyAttribute` —
        // raw SQS bodies are too large for indexed annotations.
        "payload.body": record.body,
      },
    }),
    Effect.tapError((error) =>
      Effect.logError("write_failed").pipe(
        Effect.annotateLogs({
          messageId: record.messageId,
          error: String(error),
        }),
      ),
    ),
  );

const sampleMemory = Effect.sync(() => process.memoryUsage().rss).pipe(
  Effect.flatMap((bytes) => Metric.update(memoryUsedBytes, bytes)),
);

// FIFO mode preserves message ordering across retries: on the first failure
// every subsequent record in the batch lands in `batchItemFailures` without
// being processed, matching `@aws-lambda-powertools/batch`
// `SqsFifoPartialProcessor`. Toggle via env so a single Lambda binary can
// serve either a standard or FIFO queue.
const FIFO_MODE = process.env.FIFO_MODE === "1";

export const handler = createSqsLambdaHandler(
  {
    layer: observabilityLayer,
    recordSchema: OrderFromBody,
    serviceName: "orders",
    fifo: FIFO_MODE,
    // `concurrency` is ignored when `fifo: true`; FIFO is sequential by
    // construction.
    concurrency: "unbounded",
    beforeBatch: sampleMemory,
    onRecordFailure: (record, cause) =>
      Effect.zipRight(
        Metric.update(
          Metric.tagged(recordFailures, "reason", classifyCause(cause)),
          1,
        ),
        Effect.logWarning("record_failure_observed").pipe(
          Effect.annotateLogs({
            messageId: record.messageId,
            reason: classifyCause(cause),
          }),
        ),
      ),
  },
  (order, record) => writeOne(order, record),
);

// =============================================================================
// Lower-level alternative — `processPartialResponse` directly
// =============================================================================
//
// `createSqsLambdaHandler` is sugar over `processPartialResponse`. If you
// need a different lifecycle (e.g., share a `ManagedRuntime` across
// invocations, customize cold-start handling, integrate with another
// middleware framework), call `processPartialResponse` yourself:
//
//   import * as ManagedRuntime from "effect/ManagedRuntime";
//   import {
//     processPartialResponse,
//     processFifoPartialResponse,
//   } from "effect-powertools";
//
//   const runtime = ManagedRuntime.make(observabilityLayer);
//
//   export const handler = async (
//     event: SQSEvent,
//     _context: LambdaContext,
//   ): Promise<SQSBatchResponse> => {
//     const decode = Schema.decodeUnknown(OrderFromBody);
//     const recordHandler = (record: SQSRecord) =>
//       Effect.flatMap(decode(record.body), (order) => writeOne(order, record));
//     const program = FIFO_MODE
//       ? processFifoPartialResponse(event, recordHandler)
//       : processPartialResponse(event, recordHandler, {
//           concurrency: "unbounded",
//           onRecordFailure: (record, cause) =>
//             Metric.update(
//               Metric.tagged(recordFailures, "reason", classifyCause(cause)),
//               1,
//             ),
//         });
//     return runtime.runPromise(program);
//   };
//
// The factory takes care of the rest (cold-start subsegment, metric flush,
// SIGTERM disposal). Use the lower-level form only when you specifically
// need to override one of those lifecycle steps.
