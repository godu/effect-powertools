import { MetricUnit } from "@aws-lambda-powertools/metrics";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

import {
  counter,
  frequency,
  gauge,
  histogram,
  timed,
} from "../../../lambdas/shared/effect-powertools";
import { ptMetrics, runtime } from "./observability";

const PRODUCER_FUNCTION_NAME = process.env.PRODUCER_FUNCTION_NAME;
if (!PRODUCER_FUNCTION_NAME) {
  throw new Error("PRODUCER_FUNCTION_NAME env var is required");
}

// captureHTTPsRequests is patched in observability.ts; the SDK client's
// outbound HTTPS calls become X-Ray subsegments automatically.
const lambda = new LambdaClient({});

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
        Payload: new TextEncoder().encode(JSON.stringify({ source: "trigger" })),
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

const triggerProgram = timed(
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
        new InvokeError({ cause: `parse failed: ${String(error)}` }),
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

export interface TriggerOutcome {
  readonly status: number;
  readonly body: ProducerResponse | { error: string };
}

export const handleTrigger = async (): Promise<TriggerOutcome> => {
  ptMetrics.captureColdStartMetric();
  ptMetrics.addDimension("environment", process.env.STAGE ?? "dev");

  await runtime.runPromise(sampleMemory);

  try {
    const exit = await runtime.runPromiseExit(triggerProgram);
    if (exit._tag === "Failure") {
      return { status: 502, body: { error: "trigger_failed" } };
    }
    return { status: 200, body: exit.value };
  } finally {
    ptMetrics.publishStoredMetrics();
  }
};
