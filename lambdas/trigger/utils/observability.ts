import { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import { Metrics as PowertoolsMetrics } from "@aws-lambda-powertools/metrics";
import { Tracer as PowertoolsTracer } from "@aws-lambda-powertools/tracer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { PowertoolsLayer } from "../../shared/effect-powertools";

export const ptLogger = new PowertoolsLogger();
export const ptTracer = new PowertoolsTracer();
export const ptMetrics = new PowertoolsMetrics();

export const runtime = ManagedRuntime.make(
  PowertoolsLayer({ logger: ptLogger, tracer: ptTracer, metrics: ptMetrics }),
);

process.on("SIGTERM", () => {
  runtime.dispose().finally(() => process.exit(0));
});
