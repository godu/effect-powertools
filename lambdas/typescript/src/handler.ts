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

import { counter, PowertoolsLayer } from "../../shared/effect-powertools";

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
const writeLatency = Metric.timer("WriteLatency");
const recordsRejected = counter("RecordsRejected", { unit: MetricUnit.Count });

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

const writeOne = (record: SQSRecord) =>
  Effect.gen(function* () {
    const order = JSON.parse(record.body) as Order;

    yield* Effect.annotateCurrentSpan("orderId", order.orderId);
    yield* Effect.logInfo("order_received").pipe(
      Effect.annotateLogs({
        orderId: order.orderId,
        messageId: record.messageId,
      }),
    );

    if (order.amountCents < 0) {
      yield* Metric.update(recordsRejected, 1);
      yield* Effect.logError("poison_rejected").pipe(
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

    yield* Effect.tryPromise({
      try: () =>
        s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: `orders/${order.orderId}.json`,
            Body: record.body,
            ContentType: "application/json",
          }),
        ),
      catch: (error) =>
        new PutObjectError({ orderId: order.orderId, cause: String(error) }),
    }).pipe(Metric.trackDuration(writeLatency));

    yield* Metric.update(ordersWritten, 1);
    yield* Metric.update(orderAmountCents, order.amountCents);

    yield* Effect.logInfo("order_written").pipe(
      Effect.annotateLogs({ orderId: order.orderId }),
    );
  }).pipe(
    Effect.withSpan("writeOne", {
      attributes: { messageId: record.messageId },
    }),
  );

export const handler = async (
  event: SQSEvent,
  context: Context,
): Promise<SQSBatchResponse> => {
  ptMetrics.captureColdStartMetric();
  ptLogger.addContext(context);

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
