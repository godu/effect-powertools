import { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import {
  Metrics as PowertoolsMetricsCtor,
  MetricUnit,
} from "@aws-lambda-powertools/metrics";
import { Tracer as PowertoolsTracer } from "@aws-lambda-powertools/tracer";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Schema from "effect/Schema";

import {
  counter,
  createHandler,
  histogram,
  PowertoolsLayer,
} from "effect-powertools";

const ptLogger = new PowertoolsLogger();
const ptTracer = new PowertoolsTracer();
const ptMetrics = new PowertoolsMetricsCtor();

const sqs = ptTracer.captureAWSv3Client(new SQSClient({}));

const QUEUE_URL = process.env.QUEUE_URL;
if (!QUEUE_URL) throw new Error("QUEUE_URL env var is required");

const HIGH_AMOUNT_CENTS = 100_000;
const POISON_RATE = 0.05;
const DEBUG_LOG_RATE = 0.1;

const TriggerEvent = Schema.Struct({
  source: Schema.optional(Schema.String),
});

interface Order {
  readonly orderId: string;
  readonly customerId: string;
  readonly amountCents: number;
  readonly createdAt: string;
}

class SendOrderError {
  readonly _tag = "SendOrderError";
  constructor(
    readonly props: { readonly orderId: string; readonly cause: string },
  ) {}
  toString() {
    return `SendOrderError(${this.props.orderId}): ${this.props.cause}`;
  }
}

const ordersEmitted = counter("OrdersEmitted", { unit: MetricUnit.Count });
const sendFailures = counter("SendFailures", { unit: MetricUnit.Count });
const ordersByShape = counter("OrdersByShape", { unit: MetricUnit.Count });
const payloadBytes = histogram(
  "PayloadBytes",
  [128, 256, 512, 1024, 2048],
  { unit: MetricUnit.Bytes },
);
const emitLatency = Metric.timer("EmitLatencyMs");

const classifyAmount = (amount: number): string => {
  if (amount < 0) return "poison";
  if (amount >= HIGH_AMOUNT_CENTS) return "high";
  return "normal";
};

const buildOrder = Effect.gen(function* () {
  const amount =
    Math.random() < POISON_RATE
      ? -(Math.floor(Math.random() * 100) + 1)
      : Math.floor(Math.random() * 250_000) + 100;
  const order: Order = {
    orderId: globalThis.crypto.randomUUID(),
    customerId: globalThis.crypto.randomUUID(),
    amountCents: amount,
    createdAt: new Date().toISOString(),
  };
  if (Math.random() < DEBUG_LOG_RATE) {
    yield* Effect.logDebug("order_serialized").pipe(
      Effect.annotateLogs({ orderId: order.orderId }),
    );
  }
  return order;
}).pipe(Effect.withSpan("buildOrder"));

const sendOrder = (order: Order, body: string) =>
  Effect.tryPromise({
    try: () =>
      sqs.send(
        new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: body }),
      ),
    catch: (error) =>
      new SendOrderError({ orderId: order.orderId, cause: String(error) }),
  }).pipe(
    Effect.withSpan("sqs.sendMessage", {
      attributes: { queueUrl: QUEUE_URL, orderId: order.orderId },
    }),
    Metric.trackDuration(emitLatency),
  );

const program = Effect.gen(function* () {
  const order = yield* buildOrder;
  const body = JSON.stringify(order);
  const shape = classifyAmount(order.amountCents);

  yield* Effect.annotateCurrentSpan("orderId", order.orderId);
  yield* Effect.annotateCurrentSpan("orderShape", shape);

  yield* sendOrder(order, body).pipe(
    Effect.tapError((error) =>
      Effect.zipRight(
        Metric.update(sendFailures, 1),
        Effect.logError("send_failed").pipe(
          Effect.annotateLogs({
            orderId: order.orderId,
            error: String(error),
          }),
        ),
      ),
    ),
  );

  yield* Metric.update(ordersEmitted, 1);
  yield* Metric.update(
    Metric.tagged(payloadBytes, "orderShape", shape),
    Buffer.byteLength(body, "utf8"),
  );
  yield* Metric.update(
    Metric.tagged(ordersByShape, "orderShape", shape),
    1,
  );

  if (shape === "poison") {
    yield* Effect.logFatal("poison_emitted").pipe(
      Effect.annotateLogs({
        orderId: order.orderId,
        amountCents: order.amountCents,
      }),
    );
  } else if (shape === "high") {
    yield* Effect.logWarning("high_amount").pipe(
      Effect.annotateLogs({
        orderId: order.orderId,
        amountCents: order.amountCents,
      }),
    );
  }

  yield* Effect.logInfo("order_emitted").pipe(
    Effect.annotateLogs({ orderId: order.orderId, orderShape: shape }),
  );

  return { orderId: order.orderId };
});

export const handler = createHandler(
  {
    schema: TriggerEvent,
    layer: PowertoolsLayer({
      logger: ptLogger,
      tracer: ptTracer,
      metrics: ptMetrics,
    }),
    serviceName: "producer",
  },
  (_event, _context) => program,
);
