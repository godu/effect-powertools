import { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import { Metrics as PowertoolsMetrics } from "@aws-lambda-powertools/metrics";
import { Tracer as PowertoolsTracer } from "@aws-lambda-powertools/tracer";
import * as Layer from "effect/Layer";

import {
  PowertoolsLoggerLayer,
  PowertoolsLoggerService,
  PowertoolsMetricsLayer,
  PowertoolsMetricsService,
  PowertoolsTracerLayer,
  PowertoolsTracerService,
} from "../../../lambdas/shared/effect-powertools";

// captureHTTPsRequests patches node:http and node:https globally so every
// outbound HTTP(S) request becomes an X-Ray subsegment under whichever
// segment is active.
// https://docs.aws.amazon.com/powertools/typescript/latest/features/tracer/#tracing-http-requests
export const observabilityLayer: Layer.Layer<
  PowertoolsLoggerService | PowertoolsTracerService | PowertoolsMetricsService
> = Layer.mergeAll(
  PowertoolsLoggerLayer({ logger: new PowertoolsLogger() }),
  PowertoolsTracerLayer({
    tracer: new PowertoolsTracer({ captureHTTPsRequests: true }),
  }),
  PowertoolsMetricsLayer({ metrics: new PowertoolsMetrics() }),
);
