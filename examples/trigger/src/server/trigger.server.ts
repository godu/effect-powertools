import { MetricUnit } from "@aws-lambda-powertools/metrics";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

import { Meter } from "effect-powertools";

const PRODUCER_FUNCTION_NAME = process.env.PRODUCER_FUNCTION_NAME;
if (!PRODUCER_FUNCTION_NAME) {
  throw new Error("PRODUCER_FUNCTION_NAME env var is required");
}

// captureHTTPsRequests is set on the Tracer in observability.ts and applies
// globally; the SDK client's outbound HTTPS calls become X-Ray subsegments
// automatically — chained under whatever segment the observability
// middleware has set as active.
const lambda = new LambdaClient({});

const triggersReceived = Meter.counter("TriggersReceived", { unit: MetricUnit.Count });
const triggerLatency = Metric.timer("TriggerLatency");
const memoryUsedBytes = Meter.gauge("MemoryUsedBytes", { unit: MetricUnit.Bytes });
const orderShapeFreq = Meter.frequency("OrderShape");
const responseSize = Meter.histogram(
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

// Throttling is recoverable from the caller's POV — surface it as a typed
// failure so the bridge sets the X-Ray *error* flag (orange). Anything else
// (5xx, network, timeout) is operational — surface it as a defect so the
// bridge sets the *fault* flag (red), which is what oncall actually pages on.
const THROTTLING_ERROR_NAMES = new Set([
  "ThrottlingException",
  "Throttling",
  "RequestThrottled",
  "TooManyRequestsException",
]);

const isThrottling = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: string }).name;
  return name !== undefined && THROTTLING_ERROR_NAMES.has(name);
};

const invokeProducer = Effect.tryPromise(() =>
  lambda.send(
    new InvokeCommand({
      FunctionName: PRODUCER_FUNCTION_NAME,
      InvocationType: "RequestResponse",
      Payload: new TextEncoder().encode(
        JSON.stringify({ source: "trigger" }),
      ),
    }),
  ),
).pipe(
  Effect.catchAll((unknownEx) => {
    const err = (unknownEx as { error?: unknown }).error ?? unknownEx;
    return isThrottling(err)
      ? Effect.fail(new InvokeError({ cause: String(err) }))
      : Effect.die(err);
  }),
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

const sampleMemory = Effect.sync(() => process.memoryUsage().rss).pipe(
  Effect.flatMap((bytes) => Metric.update(memoryUsedBytes, bytes)),
);

export const triggerProgram: Effect.Effect<
  ProducerResponse,
  InvokeError | FunctionError
> = sampleMemory.pipe(
  Effect.flatMap(() =>
    Meter.instrument(
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
    ),
  ),
  Effect.withSpan("trigger.handler"),
  Effect.tapErrorCause((cause) =>
    Effect.logError("trigger_failed").pipe(
      Effect.annotateLogs({ cause: String(cause) }),
    ),
  ),
);
