import "@tanstack/react-start/server-only";

import type { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import type { Metrics as PowertoolsMetrics } from "@aws-lambda-powertools/metrics";
import type { Tracer as PowertoolsTracer } from "@aws-lambda-powertools/tracer";
import * as Layer from "effect/Layer";

import { PowertoolsLoggerLayer, PowertoolsLoggerService } from "./logger";
import {
  PowertoolsMetricsLayer,
  PowertoolsMetricsService,
} from "./metrics";
import { PowertoolsTracerLayer, PowertoolsTracerService } from "./tracer";

export interface PowertoolsBridgeOptions {
  readonly logger: PowertoolsLogger;
  readonly tracer: PowertoolsTracer;
  readonly metrics: PowertoolsMetrics;
}

export const PowertoolsLayer = (
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

export { stripXrayTraceIdPrefix } from "./tracer";

export {
  counter,
  gauge,
  histogram,
  frequency,
  timed,
} from "./metrics";

export type { MetricUnitValue } from "./metrics";
