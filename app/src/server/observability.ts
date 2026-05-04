import { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import { Metrics as PowertoolsMetrics } from "@aws-lambda-powertools/metrics";
import { Tracer as PowertoolsTracer } from "@aws-lambda-powertools/tracer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { PowertoolsLayer } from "../../../lambdas/shared/effect-powertools";

export const ptLogger = new PowertoolsLogger();
// captureHTTPsRequests patches node:http and node:https globally so every
// outbound HTTP(S) request becomes an X-Ray subsegment under whichever
// Effect span is active.
// https://docs.aws.amazon.com/powertools/typescript/latest/features/tracer/#tracing-http-requests
export const ptTracer = new PowertoolsTracer({ captureHTTPsRequests: true });
export const ptMetrics = new PowertoolsMetrics();

export const runtime = ManagedRuntime.make(
  PowertoolsLayer({ logger: ptLogger, tracer: ptTracer, metrics: ptMetrics }),
);

if (typeof process !== "undefined" && typeof process.on === "function") {
  process.on("SIGTERM", () => {
    void runtime.dispose();
  });
}
