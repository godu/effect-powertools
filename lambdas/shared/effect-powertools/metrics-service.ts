import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

// Service tag for the Powertools metrics imperative escape hatches.
// Lives in its own file (not metrics.ts) so consumers that only want the
// service tag — e.g. server middleware in a Vite/SSR app — don't pull in
// the rest of metrics.ts, which has a runtime `import { MetricUnit }` from
// `@aws-lambda-powertools/metrics` that drags Powertools' Logger into the
// client bundle.
export class PowertoolsMetricsService extends Context.Tag(
  "@app/PowertoolsMetricsService",
)<
  PowertoolsMetricsService,
  {
    readonly addDimension: (key: string, value: string) => Effect.Effect<void>;
    readonly addMetadata: (key: string, value: string) => Effect.Effect<void>;
    readonly captureColdStart: () => Effect.Effect<void>;
    readonly flush: () => Effect.Effect<void>;
  }
>() {}
