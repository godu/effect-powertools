import { MetricUnit } from "@aws-lambda-powertools/metrics";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import { defineEventHandler, setResponseStatus } from "h3";

import {
  counter,
  frequency,
  gauge,
  histogram,
  timed,
} from "../../../shared/effect-powertools";
import {
  ptLogger,
  ptMetrics,
  ptTracer,
  runtime,
} from "../../utils/observability";

const PRODUCER_FUNCTION_NAME = process.env.PRODUCER_FUNCTION_NAME;
if (!PRODUCER_FUNCTION_NAME) {
  throw new Error("PRODUCER_FUNCTION_NAME env var is required");
}

const lambda = ptTracer.captureAWSv3Client(new LambdaClient({}));

const triggersReceived = counter("TriggersReceived", { unit: MetricUnit.Count });
const triggerLatency = Metric.timer("TriggerLatency");
const memoryUsedBytes = gauge("MemoryUsedBytes", { unit: MetricUnit.Bytes });
const orderShapeFreq = frequency("OrderShape");
const responseSize = histogram(
  "ProducerResponseBytes",
  [50, 100, 250, 500, 1000, 5000],
  { unit: MetricUnit.Bytes },
);

class InvokeError {
  readonly _tag = "InvokeError";
  constructor(readonly props: { readonly cause: string }) {}
  toString() {
    return `InvokeError: ${this.props.cause}`;
  }
}

class FunctionError {
  readonly _tag = "FunctionError";
  constructor(
    readonly props: { readonly statusCode?: number; readonly cause: string },
  ) {}
  toString() {
    return `FunctionError(status=${this.props.statusCode ?? "?"}): ${this.props.cause}`;
  }
}

interface ProducerResponse {
  readonly orderId: string;
  readonly amountCents?: number;
}

const classifyShape = (amount: number | undefined): string => {
  if (amount === undefined) return "unknown";
  if (amount < 0) return "poison";
  if (amount >= 100_000) return "high";
  return "normal";
};

const invokeProducer = Effect.tryPromise({
  try: () =>
    lambda.send(
      new InvokeCommand({
        FunctionName: PRODUCER_FUNCTION_NAME,
        InvocationType: "RequestResponse",
        Payload: new TextEncoder().encode(
          JSON.stringify({ source: "trigger" }),
        ),
      }),
    ),
  catch: (error) => new InvokeError({ cause: String(error) }),
}).pipe(
  Effect.withSpan("lambda.invoke", {
    attributes: {
      "rpc.system": "aws-api",
      "rpc.service": "Lambda",
      "rpc.method": "Invoke",
      "aws.lambda.function_name": PRODUCER_FUNCTION_NAME,
    },
  }),
  Metric.trackDuration(triggerLatency),
);

const trigger = timed(
  "TriggerProcess",
  Effect.gen(function* () {
    yield* Effect.logDebug("trigger_request_received");

    const result = yield* invokeProducer;

    if (result.FunctionError) {
      yield* Effect.logFatal("producer_function_error").pipe(
        Effect.annotateLogs({
          functionError: result.FunctionError,
          statusCode: result.StatusCode,
        }),
      );
      return yield* Effect.fail(
        new FunctionError({
          statusCode: result.StatusCode,
          cause: result.FunctionError,
        }),
      );
    }

    if (!result.Payload) {
      yield* Effect.logError("producer_empty_payload");
      return yield* Effect.fail(
        new InvokeError({ cause: "empty payload from producer" }),
      );
    }

    const payloadText = new TextDecoder().decode(result.Payload);
    yield* Metric.update(responseSize, payloadText.length);

    const parsed = yield* Effect.try({
      try: () => JSON.parse(payloadText) as ProducerResponse,
      catch: (error) =>
        new InvokeError({
          cause: `parse failed: ${String(error)}`,
        }),
    });

    const shape = classifyShape(parsed.amountCents);

    yield* Effect.annotateCurrentSpan("orderId", parsed.orderId);
    yield* Effect.annotateCurrentSpan("orderShape", shape);

    yield* Metric.update(orderShapeFreq, shape);
    yield* Metric.update(
      Metric.tagged(triggersReceived, "orderShape", shape),
      1,
    );

    if (shape === "high") {
      yield* Effect.logWarning("high_amount_triggered").pipe(
        Effect.annotateLogs({
          orderId: parsed.orderId,
          amountCents: parsed.amountCents,
        }),
      );
    }

    yield* Effect.logInfo("trigger_completed").pipe(
      Effect.annotateLogs({ orderId: parsed.orderId, orderShape: shape }),
    );

    return parsed;
  }),
).pipe(
  Effect.withSpan("trigger.handler"),
  Effect.tapError((error) =>
    Effect.logError("trigger_failed").pipe(
      Effect.annotateLogs({ error: String(error) }),
    ),
  ),
);

const sampleMemory = Effect.sync(() => process.memoryUsage().rss).pipe(
  Effect.flatMap((bytes) => Metric.update(memoryUsedBytes, bytes)),
);

export default defineEventHandler(async (event) => {
  ptMetrics.captureColdStartMetric();
  ptMetrics.addDimension("environment", process.env.STAGE ?? "dev");

  const lambdaContext = (event.context as { awsLambdaContext?: unknown })
    .awsLambdaContext;
  if (lambdaContext) {
    ptLogger.addContext(lambdaContext as never);
  }

  await runtime.runPromise(sampleMemory);

  try {
    const exit = await runtime.runPromiseExit(trigger);
    if (exit._tag === "Failure") {
      setResponseStatus(event, 502);
      return { error: "trigger_failed" };
    }
    return exit.value;
  } finally {
    ptMetrics.publishStoredMetrics();
  }
});
