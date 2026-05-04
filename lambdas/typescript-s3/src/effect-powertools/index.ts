import type { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import type { Metrics as PowertoolsMetrics } from "@aws-lambda-powertools/metrics";
import type { Tracer as PowertoolsTracer } from "@aws-lambda-powertools/tracer";
import * as Layer from "effect/Layer";

import { PowertoolsLoggerLayer } from "./logger";
import {
  PowertoolsMetricsLayer,
  PowertoolsMetricsService,
} from "./metrics";
import { PowertoolsTracerLayer } from "./tracer";

export interface PowertoolsBridgeOptions {
  readonly logger: PowertoolsLogger;
  readonly tracer: PowertoolsTracer;
  readonly metrics: PowertoolsMetrics;
}

export const PowertoolsLayer = (
  options: PowertoolsBridgeOptions,
): Layer.Layer<PowertoolsMetricsService> =>
  Layer.mergeAll(
    PowertoolsLoggerLayer({ logger: options.logger }),
    PowertoolsTracerLayer({ tracer: options.tracer }),
    PowertoolsMetricsLayer({ metrics: options.metrics }),
  );

export {
  PowertoolsLoggerLayer,
  PowertoolsTracerLayer,
  PowertoolsMetricsLayer,
  PowertoolsMetricsService,
};

export {
  counter,
  gauge,
  histogram,
  frequency,
  timed,
} from "./metrics";

export type { MetricUnitValue } from "./metrics";
