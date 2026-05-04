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

import {
  counter,
  histogram,
  PowertoolsLayer,
} from "./effect-powertools";

const ptLogger = new PowertoolsLogger();
const ptTracer = new PowertoolsTracer();
const ptMetrics = new PowertoolsMetricsCtor();

const s3 = ptTracer.captureAWSv3Client(new S3Client({}));

const layer = PowertoolsLayer({
  logger: ptLogger,
  tracer: ptTracer,
  metrics: ptMetrics,
});

const runtime = ManagedRuntime.make(layer);

interface Order {
  readonly orderId: string;
  readonly customerId: string;
  readonly amountCents: number;
  readonly createdAt: string;
}

const ordersObserved = counter("OrdersObserved", { unit: MetricUnit.Count });
const orderAmountHistogram = histogram(
  "OrderAmountCents",
  [100, 500, 1000, 5000, 10000, 50000, 100000],
  { unit: MetricUnit.Count },
);
const observeLatency = histogram(
  "ObserveLatencyMs",
  [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  { unit: MetricUnit.Milliseconds },
);

const observeRecord = (record: S3EventRecord) =>
  Effect.gen(function* () {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const started = Date.now();

    yield* Effect.logInfo("object_received").pipe(
      Effect.annotateLogs({ bucket, key }),
    );

    const response = yield* Effect.tryPromise({
      try: () => s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })),
      catch: (error) =>
        new GetObjectError({ bucket, key, cause: String(error) }),
    });

    const body = response.Body;
    if (!body) {
      return yield* Effect.fail(
        new GetObjectError({ bucket, key, cause: "missing body" }),
      );
    }

    const text = yield* Effect.tryPromise({
      try: () => body.transformToString(),
      catch: (error) =>
        new GetObjectError({ bucket, key, cause: String(error) }),
    });

    const order = yield* Effect.try({
      try: () => JSON.parse(text) as Order,
      catch: (error) => new ParseOrderError({ key, cause: String(error) }),
    });

    yield* Metric.update(ordersObserved, 1);
    yield* Metric.update(orderAmountHistogram, order.amountCents);
    yield* Metric.update(observeLatency, Date.now() - started);

    yield* Effect.annotateCurrentSpan("orderId", order.orderId);

    yield* Effect.logInfo("order_observed").pipe(
      Effect.annotateLogs({
        orderId: order.orderId,
        customerId: order.customerId,
        amountCents: order.amountCents,
      }),
    );
  }).pipe(
    Effect.withSpan("observeRecord", {
      attributes: {
        bucket: record.s3.bucket.name,
        key: record.s3.object.key,
      },
    }),
    Effect.tapError((error) =>
      Effect.logError("observe_failed").pipe(
        Effect.annotateLogs({ error: String(error) }),
      ),
    ),
  );

class GetObjectError {
  readonly _tag = "GetObjectError";
  constructor(
    readonly props: {
      readonly bucket: string;
      readonly key: string;
      readonly cause: string;
    },
  ) {}
  toString() {
    return `GetObjectError(${this.props.bucket}/${this.props.key}): ${this.props.cause}`;
  }
}

class ParseOrderError {
  readonly _tag = "ParseOrderError";
  constructor(
    readonly props: {
      readonly key: string;
      readonly cause: string;
    },
  ) {}
  toString() {
    return `ParseOrderError(${this.props.key}): ${this.props.cause}`;
  }
}

export const handler = async (
  event: S3Event,
  context: Context,
): Promise<void> => {
  ptMetrics.captureColdStartMetric();
  ptLogger.addContext(context);
  try {
    for (const record of event.Records) {
      await runtime.runPromise(
        observeRecord(record).pipe(
          Effect.catchAll((error) =>
            Effect.logError("observe_record_error").pipe(
              Effect.annotateLogs({ error: String(error) }),
            ),
          ),
        ),
      );
    }
  } finally {
    ptMetrics.publishStoredMetrics();
  }
};
