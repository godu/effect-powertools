import "@tanstack/react-start/server-only";

import type { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import type { Metrics as PowertoolsMetrics } from "@aws-lambda-powertools/metrics";
import type { Tracer as PowertoolsTracer } from "@aws-lambda-powertools/tracer";
import * as Layer from "effect/Layer";

import { PowertoolsLoggerLayer, PowertoolsLoggerService } from "./logger";
import {
  counter,
  frequency,
  gauge,
  histogram,
  instrument,
  PowertoolsMetricsLayer,
  PowertoolsMetricsService,
} from "./metrics";
import { PowertoolsTracerLayer, PowertoolsTracerService } from "./tracer";

export interface PowertoolsBridgeOptions {
  readonly logger: PowertoolsLogger;
  readonly tracer: PowertoolsTracer;
  readonly metrics: PowertoolsMetrics;
}

export const PowertoolsBridgeLayer = (
  options: PowertoolsBridgeOptions,
): Layer.Layer<
  PowertoolsLoggerService | PowertoolsTracerService | PowertoolsMetricsService
> =>
  Layer.mergeAll(
    PowertoolsLoggerLayer({ logger: options.logger }),
    PowertoolsTracerLayer({ tracer: options.tracer }),
    PowertoolsMetricsLayer({ metrics: options.metrics }),
  );

export {
  PowertoolsLoggerLayer,
  PowertoolsLoggerService,
  PowertoolsTracerLayer,
  PowertoolsTracerService,
  PowertoolsMetricsLayer,
  PowertoolsMetricsService,
};

// Namespace export: bare metric helpers shadow `effect/Metric.counter` etc.
// at call sites. Grouping under `Meter` removes the ambiguity and signals
// "this constructor pre-tags the unit and bridges to Powertools EMF."
//
// `instrument(name, effect)` is colocated here as the call-metrics operator
// (count + duration timer around an Effect) — same naming pattern as
// `Effect.withSpan` for tracing.
export const Meter = {
  counter,
  gauge,
  histogram,
  frequency,
  instrument,
} as const;

export type { MetricUnitValue, MetricOptions } from "./metrics";

export {
  processPartialResponse,
  processFifoPartialResponse,
} from "./batch";

export type {
  BatchProcessOptions,
  FifoBatchProcessOptions,
} from "./batch";

export { createLambdaHandler, createSqsLambdaHandler } from "./handlers";

export type {
  CreateLambdaHandlerOptions,
  CreateSqsLambdaHandlerOptions,
  PowertoolsBridge,
} from "./handlers";

// Customization option types for the per-component layers — re-exported so
// consumers can write a typed `classifyAttribute` / `levelMap` callback
// without deep-importing from `./tracer` or `./logger`.
export type { PowertoolsLoggerOptions } from "./logger";
export type {
  AttributeKind,
  PowertoolsTracerOptions,
} from "./tracer";
export type { PowertoolsMetricsOptions } from "./metrics";
