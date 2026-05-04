import type { Metrics as PowertoolsMetrics } from "@aws-lambda-powertools/metrics";
import { MetricUnit } from "@aws-lambda-powertools/metrics";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as MetricBoundaries from "effect/MetricBoundaries";
import type * as MetricKey from "effect/MetricKey";
import * as MetricKeyType from "effect/MetricKeyType";

/**
 * Bridges Effect's Metric API to AWS Lambda Powertools EMF output.
 *
 * Effect's `globalMetricRegistry` is monkey-patched once at module load. Every
 * counter/gauge/histogram/frequency hook returned from the registry is wrapped
 * so that each `update(value)` call also forwards to
 * `pt.metrics.addMetric(name, unit, value)`. The original hook still runs, so
 * Effect's own metric snapshots (`Metric.value`, `Metric.snapshot`) keep
 * working.
 *
 * Units are out-of-band hints. Use the `counter` / `histogram` / `gauge` /
 * `frequency` helpers in this module to register a unit alongside a metric
 * name. Direct `Metric.counter("X")` usage still flows through the bridge but
 * defaults to `Count`.
 *
 * Tags from `Metric.tagged(...)` become Powertools dimensions on the emitted
 * data point via `pt.metrics.singleMetric()`.
 */

export type MetricUnitValue = (typeof MetricUnit)[keyof typeof MetricUnit];

const unitHints = new Map<string, MetricUnitValue>();

const registerUnit = (name: string, unit: MetricUnitValue | undefined) => {
  if (unit !== undefined) unitHints.set(name, unit);
};

const unitFor = (name: string): MetricUnitValue =>
  unitHints.get(name) ?? MetricUnit.Count;

let installed: PowertoolsMetrics | undefined;

const ensureInstalled = (metrics: PowertoolsMetrics): void => {
  if (installed === metrics) return;
  if (installed !== undefined && installed !== metrics) {
    throw new Error(
      "PowertoolsMetricsBridge: cannot rebind to a different Powertools Metrics instance after install",
    );
  }
  installed = metrics;
  patchGlobalMetricRegistry(metrics);
};

interface UntypedHook {
  update(input: unknown): void;
  modify(input: unknown): void;
  get(): unknown;
}

const patchGlobalMetricRegistry = (metrics: PowertoolsMetrics): void => {
  const registry = Metric.globalMetricRegistry as unknown as {
    get(key: MetricKey.MetricKey.Untyped): UntypedHook;
  };
  const originalGet = registry.get.bind(registry);
  registry.get = function patchedGet(key) {
    const inner = originalGet(key);
    return wrapHook(metrics, key, inner);
  };
};

const tagsToDimensions = (
  tags: ReadonlyArray<{ readonly key: string; readonly value: string }>,
): ReadonlyArray<readonly [string, string]> =>
  tags.map((t) => [t.key, t.value] as const);

const emit = (
  metrics: PowertoolsMetrics,
  name: string,
  unit: MetricUnitValue,
  value: number,
  dimensions: ReadonlyArray<readonly [string, string]>,
): void => {
  if (!Number.isFinite(value)) return;
  if (dimensions.length === 0) {
    metrics.addMetric(name, unit, value);
    return;
  }
  const single = metrics.singleMetric();
  for (const [k, v] of dimensions) single.addDimension(k, v);
  single.addMetric(name, unit, value);
};

const wrapHook = (
  metrics: PowertoolsMetrics,
  key: MetricKey.MetricKey.Untyped,
  inner: UntypedHook,
): UntypedHook => {
  const name = key.name;
  const dimensions = tagsToDimensions(key.tags);
  const keyType = key.keyType as MetricKeyType.MetricKeyType.Untyped;

  if (
    MetricKeyType.isCounterKey(keyType) ||
    MetricKeyType.isGaugeKey(keyType) ||
    MetricKeyType.isHistogramKey(keyType)
  ) {
    const unit = unitFor(name);
    return {
      get: () => inner.get(),
      update(input) {
        inner.update(input);
        emit(metrics, name, unit, Number(input), dimensions);
      },
      modify(input) {
        inner.modify(input);
        emit(metrics, name, unit, Number(input), dimensions);
      },
    };
  }

  if (MetricKeyType.isFrequencyKey(keyType)) {
    return {
      get: () => inner.get(),
      update(input) {
        inner.update(input);
        emit(metrics, `${name}.${String(input)}`, MetricUnit.Count, 1, dimensions);
      },
      modify(input) {
        inner.modify(input);
        emit(metrics, `${name}.${String(input)}`, MetricUnit.Count, 1, dimensions);
      },
    };
  }

  return inner;
};

// ---------------------------------------------------------------------------
// Metric helpers with unit hints
// ---------------------------------------------------------------------------

export interface MetricOptions {
  readonly description?: string;
  readonly incremental?: boolean;
  readonly unit?: MetricUnitValue;
}

export const counter = (
  name: string,
  opts: MetricOptions = {},
): Metric.Metric.Counter<number> => {
  registerUnit(name, opts.unit);
  return Metric.counter(name, {
    description: opts.description,
    incremental: opts.incremental,
  });
};

export const gauge = (
  name: string,
  opts: MetricOptions = {},
): Metric.Metric.Gauge<number> => {
  registerUnit(name, opts.unit);
  return Metric.gauge(name, { description: opts.description });
};

export const histogram = (
  name: string,
  boundaries: ReadonlyArray<number>,
  opts: MetricOptions = {},
): Metric.Metric.Histogram<number> => {
  registerUnit(name, opts.unit);
  return Metric.histogram(
    name,
    MetricBoundaries.fromIterable(boundaries),
    opts.description,
  );
};

export const frequency = (
  name: string,
  opts: MetricOptions & {
    readonly preregisteredWords?: ReadonlyArray<string>;
  } = {},
): Metric.Metric.Frequency<string> => {
  registerUnit(name, opts.unit);
  return Metric.frequency(name, {
    description: opts.description,
    preregisteredWords: opts.preregisteredWords,
  });
};

// ---------------------------------------------------------------------------
// Effect service tag for the imperative escape hatches
// ---------------------------------------------------------------------------

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

export interface PowertoolsMetricsOptions {
  readonly metrics: PowertoolsMetrics;
}

export const PowertoolsMetricsLayer = (
  options: PowertoolsMetricsOptions,
): Layer.Layer<PowertoolsMetricsService> =>
  Layer.sync(PowertoolsMetricsService, () => {
    ensureInstalled(options.metrics);
    return PowertoolsMetricsService.of({
      addDimension: (key, value) =>
        Effect.sync(() => {
          options.metrics.addDimension(key, value);
        }),
      addMetadata: (key, value) =>
        Effect.sync(() => {
          options.metrics.addMetadata(key, value);
        }),
      captureColdStart: () =>
        Effect.sync(() => {
          options.metrics.captureColdStartMetric();
        }),
      flush: () =>
        Effect.sync(() => {
          options.metrics.publishStoredMetrics();
        }),
    });
  });

// ---------------------------------------------------------------------------
// timed: count + duration histogram around an effect
// ---------------------------------------------------------------------------

const defaultDurationBoundaries = MetricBoundaries.fromIterable([
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000,
]);

export const timed = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
  opts: { readonly unit?: MetricUnitValue } = {},
): Effect.Effect<A, E, R> => {
  const durName = `${name}DurationMs`;
  registerUnit(durName, opts.unit ?? MetricUnit.Milliseconds);
  registerUnit(name, MetricUnit.Count);
  const callCounter = Metric.counter(name);
  const durHistogram = Metric.histogram(durName, defaultDurationBoundaries);
  return Effect.gen(function* () {
    const start = Date.now();
    const result = yield* effect;
    yield* Metric.update(callCounter, 1);
    yield* Metric.update(durHistogram, Date.now() - start);
    return result;
  });
};
