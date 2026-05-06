import type {
  Context as LambdaContext,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from "aws-lambda";
import type { Segment, Subsegment } from "aws-xray-sdk-core";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

import {
  type BatchProcessOptions,
  type FifoBatchProcessOptions,
  processFifoPartialResponse,
  processPartialResponse,
} from "./batch";
import { PowertoolsLoggerService } from "./logger";
import { PowertoolsMetricsService } from "./metrics";
import { registerSigtermDisposer } from "./runtime-utils";
import { PowertoolsTracerService, stripXrayTraceIdPrefix } from "./tracer";

/**
 * Lambda handler factories that hide observability boilerplate behind a
 * single call. `createLambdaHandler` works with any Lambda event type; pass
 * an `effect/Schema` that validates the raw event before your code runs.
 * `createSqsLambdaHandler` is SQS-specialized sugar that adds per-record body
 * validation and wires the batch processors so failures travel via
 * `SQSBatchResponse.batchItemFailures`.
 *
 * Lifecycle (mirrors @aws-lambda-powertools middleware):
 *   acquire — captureColdStartMetric, addDimension(environment),
 *             logger.addContext, open `## ${serviceName}` X-Ray subsegment.
 *   use     — Schema.decodeUnknown the event (failures abort), then run
 *             the user program with `Layer.parentSpan(externalSpan)` so
 *             user-side `Effect.withSpan(...)` calls nest under the Lambda
 *             subsegment.
 *   release — close subsegment, restore parent segment, publishStoredMetrics.
 *             Always runs.
 */

// Aggregate of the three Powertools bridge services. The `layer` passed to
// `createLambdaHandler` / `createSqsLambdaHandler` must produce at least
// these three so the factory can read the raw Powertools instances back at
// runtime (one source of truth per process).
export type PowertoolsBridge =
  | PowertoolsLoggerService
  | PowertoolsTracerService
  | PowertoolsMetricsService;

interface SetupResult {
  readonly tracingEnabled: boolean;
  readonly parent: Segment | Subsegment | undefined;
  readonly sub: Subsegment | undefined;
}

const acquireObservability = (
  serviceName: string,
  context: LambdaContext,
): Effect.Effect<SetupResult, never, PowertoolsBridge> =>
  Effect.gen(function* () {
    const ptLogger = yield* PowertoolsLoggerService;
    const ptTracer = yield* PowertoolsTracerService;
    const ptMetrics = yield* PowertoolsMetricsService;

    yield* ptMetrics.captureColdStart();
    yield* ptMetrics.addDimension("environment", process.env.STAGE ?? "dev");
    ptLogger.addContext(context);

    const tracingEnabled = ptTracer.isTracingEnabled();
    let parent: Segment | Subsegment | undefined;
    let sub: Subsegment | undefined;
    if (tracingEnabled) {
      parent = ptTracer.getSegment();
      sub = parent?.addNewSubsegment(`## ${serviceName}`);
      if (sub) {
        ptTracer.setSegment(sub);
        ptTracer.annotateColdStart();
        ptTracer.addServiceNameAnnotation();
      }
    }
    return { tracingEnabled, parent, sub };
  });

const releaseObservability = (
  setup: SetupResult,
): Effect.Effect<void, never, PowertoolsBridge> =>
  Effect.gen(function* () {
    const ptTracer = yield* PowertoolsTracerService;
    const ptMetrics = yield* PowertoolsMetricsService;

    if (setup.sub) {
      try {
        setup.sub.close();
      } catch {
        // already closed
      }
    }
    if (setup.parent) ptTracer.setSegment(setup.parent);
    yield* ptMetrics.flush();
  });

const externalSpanFor = (
  sub: Subsegment | undefined,
): Tracer.AnySpan | undefined =>
  sub
    ? Tracer.externalSpan({
        spanId: sub.id,
        traceId: stripXrayTraceIdPrefix(sub.segment?.trace_id),
        sampled: true,
      })
    : undefined;

const provideParentSpan = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  span: Tracer.AnySpan | undefined,
): Effect.Effect<A, E, R> =>
  span ? Effect.provide(effect, Layer.parentSpan(span)) : effect;

// =============================================================================
// createLambdaHandler — generic Lambda handler factory
// =============================================================================

export interface CreateLambdaHandlerOptions<A, I, R, E> {
  /** Schema decoding the raw Lambda event. Failures abort the invocation. */
  readonly schema: Schema.Schema<A, I, never>;
  /** Layer providing the Powertools bridge plus any app services. */
  readonly layer: Layer.Layer<PowertoolsBridge | R, E>;
  /** Subsegment name (`## ${serviceName}`). Defaults to `context.functionName`. */
  readonly serviceName?: string;
  /** Effect run once per invocation, after acquire and before the user program. */
  readonly before?: Effect.Effect<unknown, unknown, R | PowertoolsBridge>;
}

export const createLambdaHandler = <A, I, R, E, Out>(
  opts: CreateLambdaHandlerOptions<A, I, R, E>,
  program: (
    input: A,
    context: LambdaContext,
  ) => Effect.Effect<Out, unknown, R | PowertoolsBridge>,
): ((event: I, context: LambdaContext) => Promise<Out>) => {
  const runtime = ManagedRuntime.make(opts.layer);
  registerSigtermDisposer(runtime);

  return async (event: I, context: LambdaContext): Promise<Out> => {
    context.callbackWaitsForEmptyEventLoop = false;
    const serviceName = opts.serviceName ?? context.functionName;

    const main = Effect.acquireUseRelease(
      acquireObservability(serviceName, context),
      (setup) => {
        const externalSpan = externalSpanFor(setup.sub);
        const body = Effect.gen(function* () {
          const decoded = yield* Schema.decodeUnknown(opts.schema)(event).pipe(
            Effect.tapError((error) =>
              Effect.logError("event_validation_failed").pipe(
                Effect.annotateLogs({
                  error: ParseResult.TreeFormatter.formatErrorSync(error),
                }),
              ),
            ),
          );
          if (opts.before) yield* opts.before;
          return yield* program(decoded, context);
        });
        return provideParentSpan(body, externalSpan);
      },
      (setup) => releaseObservability(setup),
    );

    const exit = await runtime.runPromiseExit(main);
    if (Exit.isFailure(exit)) {
      throw new Error(Cause.pretty(exit.cause));
    }
    return exit.value;
  };
};

// =============================================================================
// createSqsLambdaHandler — SQS-specialized sugar built on the batch processors
// =============================================================================

export interface CreateSqsLambdaHandlerOptions<A, I, R, E> {
  /** Schema decoding each record's `body`. Use `Schema.parseJson(...)` for JSON payloads. */
  readonly recordSchema: Schema.Schema<A, I, never>;
  /** Layer providing the Powertools bridge plus any app services. */
  readonly layer: Layer.Layer<PowertoolsBridge | R, E>;
  /** Subsegment name (`## ${serviceName}`). Defaults to `context.functionName`. */
  readonly serviceName?: string;
  /** Process records strictly in order, short-circuiting on first failure. */
  readonly fifo?: boolean;
  /** Concurrency for non-FIFO batches. Default `"unbounded"`. */
  readonly concurrency?: number | "unbounded";
  /** Effect run once per invocation, after acquire and before the batch loop. */
  readonly beforeBatch?: Effect.Effect<unknown, unknown, R | PowertoolsBridge>;
  /** Custom failure hook. See `BatchProcessOptions.onRecordFailure`. */
  readonly onRecordFailure?: (
    record: SQSRecord,
    cause: Cause.Cause<unknown>,
  ) => Effect.Effect<void, never, R | PowertoolsBridge>;
}

export const createSqsLambdaHandler = <A, I, R, E>(
  opts: CreateSqsLambdaHandlerOptions<A, I, R, E>,
  recordHandler: (
    parsed: A,
    record: SQSRecord,
  ) => Effect.Effect<unknown, unknown, R | PowertoolsBridge>,
): ((event: SQSEvent, context: LambdaContext) => Promise<SQSBatchResponse>) => {
  const runtime = ManagedRuntime.make(opts.layer);
  registerSigtermDisposer(runtime);

  const decodeBody = Schema.decodeUnknown(opts.recordSchema);

  // Wrap user's recordHandler with body validation. Schema decode failure
  // becomes a typed Effect failure so the batch processor lands the record
  // in `batchItemFailures`.
  const internalRecordHandler = (
    record: SQSRecord,
  ): Effect.Effect<unknown, unknown, R | PowertoolsBridge> =>
    Effect.gen(function* () {
      const parsed = yield* decodeBody(record.body as I).pipe(
        Effect.tapError((error) =>
          Effect.logError("sqs_record_validation_failed").pipe(
            Effect.annotateLogs({
              messageId: record.messageId,
              error: ParseResult.TreeFormatter.formatErrorSync(error),
            }),
          ),
        ),
      );
      return yield* recordHandler(parsed, record);
    });

  return async (
    event: SQSEvent,
    context: LambdaContext,
  ): Promise<SQSBatchResponse> => {
    context.callbackWaitsForEmptyEventLoop = false;
    const serviceName = opts.serviceName ?? context.functionName;

    const main = Effect.acquireUseRelease(
      acquireObservability(serviceName, context),
      (setup) => {
        const externalSpan = externalSpanFor(setup.sub);
        const batchOpts: BatchProcessOptions<unknown, R | PowertoolsBridge> &
          FifoBatchProcessOptions<unknown, R | PowertoolsBridge> = {
          concurrency: opts.concurrency ?? "unbounded",
          onRecordFailure: opts.onRecordFailure,
        };
        const batch = opts.fifo
          ? processFifoPartialResponse(event, internalRecordHandler, batchOpts)
          : processPartialResponse(event, internalRecordHandler, batchOpts);
        const body = Effect.gen(function* () {
          if (opts.beforeBatch) yield* opts.beforeBatch;
          return yield* batch;
        });
        return provideParentSpan(body, externalSpan);
      },
      (setup) => releaseObservability(setup),
    );

    const exit = await runtime.runPromiseExit(main);
    if (Exit.isFailure(exit)) {
      throw new Error(Cause.pretty(exit.cause));
    }
    return exit.value;
  };
};
