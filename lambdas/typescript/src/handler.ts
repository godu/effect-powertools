import { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import {
  Metrics as PowertoolsMetricsCtor,
  MetricUnit,
} from "@aws-lambda-powertools/metrics";
import { Tracer as PowertoolsTracer } from "@aws-lambda-powertools/tracer";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type {
  Context,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from "aws-lambda";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Metric from "effect/Metric";

import {
  counter,
  frequency,
  gauge,
  histogram,
  PowertoolsLayer,
  timed,
} from "effect-powertools";

const ptLogger = new PowertoolsLogger();
const ptTracer = new PowertoolsTracer();
const ptMetrics = new PowertoolsMetricsCtor();

const s3 = ptTracer.captureAWSv3Client(new S3Client({}));

const BUCKET = process.env.DATA_BUCKET;
if (!BUCKET) throw new Error("DATA_BUCKET env var is required");

const runtime = ManagedRuntime.make(
  PowertoolsLayer({ logger: ptLogger, tracer: ptTracer, metrics: ptMetrics }),
);
process.on("SIGTERM", () => {
  runtime.dispose().finally(() => process.exit(0));
});

const ordersWritten = counter("OrdersWritten", { unit: MetricUnit.Count });
const orderAmountCents = counter("OrderAmountCents", { unit: MetricUnit.Count });
const orderAmountHistogram = histogram(
  "OrderAmountHistogram",
  [100, 1_000, 10_000, 100_000, 1_000_000],
  { unit: MetricUnit.Count },
);
const writeLatency = Metric.timer("WriteLatency");
const recordsRejected = counter("RecordsRejected", { unit: MetricUnit.Count });
const memoryUsedBytes = gauge("MemoryUsedBytes", { unit: MetricUnit.Bytes });
const orderShapeFreq = frequency("OrderShape");

interface Order {
  readonly orderId: string;
  readonly customerId: string;
  readonly amountCents: number;
  readonly createdAt: string;
}

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

class ParseOrderError {
  readonly _tag = "ParseOrderError";
  constructor(
    readonly props: { readonly messageId: string; readonly cause: string },
  ) {}
  toString() {
    return `ParseOrderError(${this.props.messageId}): ${this.props.cause}`;
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

const writeOne = (record: SQSRecord) =>
  timed(
    "OrderProcess",
    Effect.gen(function* () {
      yield* Effect.logDebug("record_received").pipe(
        Effect.annotateLogs({ messageId: record.messageId }),
      );

      const order = yield* Effect.try({
        try: () => JSON.parse(record.body) as Order,
        catch: (error) =>
          new ParseOrderError({
            messageId: record.messageId,
            cause: String(error),
          }),
      });

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
      yield* Metric.update(orderAmountCents, order.amountCents);
      yield* Metric.update(orderAmountHistogram, order.amountCents);

      yield* Effect.logInfo("order_written").pipe(
        Effect.annotateLogs({ orderId: order.orderId }),
      );
    }),
  ).pipe(
    Effect.withSpan("writeOne", {
      attributes: { messageId: record.messageId },
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

export const handler = async (
  event: SQSEvent,
  context: Context,
): Promise<SQSBatchResponse> => {
  ptMetrics.captureColdStartMetric();
  ptMetrics.addDimension("environment", process.env.STAGE ?? "dev");
  ptLogger.addContext(context);

  await runtime.runPromise(sampleMemory);

  const batchItemFailures: { itemIdentifier: string }[] = [];
  try {
    for (const record of event.Records) {
      const result = await runtime.runPromiseExit(writeOne(record));
      if (result._tag === "Failure") {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
  } finally {
    ptMetrics.publishStoredMetrics();
  }

  return { batchItemFailures };
};
