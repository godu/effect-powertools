import type { Metrics as PowertoolsMetrics } from "@aws-lambda-powertools/metrics";
import { MetricUnit } from "@aws-lambda-powertools/metrics";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as MetricBoundaries from "effect/MetricBoundaries";
import type * as MetricKey from "effect/MetricKey";
import * as MetricKeyType from "effect/MetricKeyType";

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
 * Units travel on the metric key as a tag: `unit:<MetricUnit value>` for
 * arbitrary metrics, or `time_unit:milliseconds` (auto-attached by
 * `Metric.timer`). The tag is stripped from the dimensions sent to Powertools.
 * Other tags become Powertools dimensions via `pt.metrics.singleMetric()`.
 */

export type MetricUnitValue = (typeof MetricUnit)[keyof typeof MetricUnit];

const UNIT_TAG_KEYS = new Set(["unit", "time_unit"]);

const TIME_UNIT_ALIASES: Record<string, MetricUnitValue> = {
  nanoseconds: MetricUnit.Microseconds,
  microseconds: MetricUnit.Microseconds,
  milliseconds: MetricUnit.Milliseconds,
  seconds: MetricUnit.Seconds,
};

const KNOWN_UNITS: ReadonlySet<string> = new Set(Object.values(MetricUnit));

const mapToPowertoolsUnit = (raw: string): MetricUnitValue | undefined => {
  if (KNOWN_UNITS.has(raw)) return raw as MetricUnitValue;
  const lower = raw.toLowerCase();
  if (lower in TIME_UNIT_ALIASES) return TIME_UNIT_ALIASES[lower];
  return undefined;
};

const unitFromTags = (
  tags: ReadonlyArray<{ readonly key: string; readonly value: string }>,
): MetricUnitValue | undefined => {
  for (const t of tags) {
    if (UNIT_TAG_KEYS.has(t.key)) {
      const mapped = mapToPowertoolsUnit(t.value);
      if (mapped !== undefined) return mapped;
    }
  }
  return undefined;
};

let installed: PowertoolsMetrics | undefined;
let originalGet: ((key: MetricKey.MetricKey.Untyped) => UntypedHook) | undefined;

const ensureInstalled = (metrics: PowertoolsMetrics): void => {
  if (installed === metrics) return;
  if (installed !== undefined) {
    throw new Error(
      "PowertoolsMetricsBridge: registry is process-global; reuse the original PowertoolsMetrics instance or call __resetForTesting() before rebinding.",
    );
  }
  installed = metrics;
  patchGlobalMetricRegistry(metrics);
};

export const __resetForTesting = (): void => {
  if (originalGet !== undefined) {
    const registry = Metric.globalMetricRegistry as unknown as {
      get(key: MetricKey.MetricKey.Untyped): UntypedHook;
    };
    registry.get = originalGet;
    originalGet = undefined;
  }
  installed = undefined;
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
  originalGet = registry.get.bind(registry);
  const captured = originalGet;
  registry.get = function patchedGet(key) {
    const inner = captured(key);
    return wrapHook(metrics, key, inner);
  };
};

const tagsToDimensions = (
  tags: ReadonlyArray<{ readonly key: string; readonly value: string }>,
): ReadonlyArray<readonly [string, string]> =>
  tags
    .filter((t) => !UNIT_TAG_KEYS.has(t.key))
    .map((t) => [t.key, t.value] as const);

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
  const unit = unitFromTags(key.tags) ?? MetricUnit.Count;
  const dimensions = tagsToDimensions(key.tags);
  const keyType = key.keyType as MetricKeyType.MetricKeyType.Untyped;

  if (
    MetricKeyType.isCounterKey(keyType) ||
    MetricKeyType.isGaugeKey(keyType) ||
    MetricKeyType.isHistogramKey(keyType)
  ) {
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
// Metric helpers — thin wrappers that pre-tag the unit
// ---------------------------------------------------------------------------

export interface MetricOptions {
  readonly description?: string;
  readonly incremental?: boolean;
  readonly unit?: MetricUnitValue;
}

const withUnit = <Type, In, Out>(
  metric: Metric.Metric<Type, In, Out>,
  unit: MetricUnitValue | undefined,
): Metric.Metric<Type, In, Out> =>
  unit === undefined ? metric : Metric.tagged(metric, "unit", String(unit));

export const counter = (
  name: string,
  opts: MetricOptions = {},
): Metric.Metric.Counter<number> =>
  withUnit(
    Metric.counter(name, {
      description: opts.description,
      incremental: opts.incremental,
    }),
    opts.unit,
  );

export const gauge = (
  name: string,
  opts: MetricOptions = {},
): Metric.Metric.Gauge<number> =>
  withUnit(Metric.gauge(name, { description: opts.description }), opts.unit);

export const histogram = (
  name: string,
  boundaries: ReadonlyArray<number>,
  opts: MetricOptions = {},
): Metric.Metric.Histogram<number> =>
  withUnit(
    Metric.histogram(
      name,
      MetricBoundaries.fromIterable(boundaries),
      opts.description,
    ),
    opts.unit,
  );

export const frequency = (
  name: string,
  opts: MetricOptions & {
    readonly preregisteredWords?: ReadonlyArray<string>;
  } = {},
): Metric.Metric.Frequency<string> =>
  withUnit(
    Metric.frequency(name, {
      description: opts.description,
      preregisteredWords: opts.preregisteredWords,
    }),
    opts.unit,
  );

// ---------------------------------------------------------------------------
// Layer wiring (the service tag itself lives in metrics-service.ts so
// downstream modules can import it without pulling Powertools' MetricUnit).
// ---------------------------------------------------------------------------

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
// timed: count + duration timer around an effect
// ---------------------------------------------------------------------------

export const timed = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const callCounter = Metric.counter(name);
  const durTimer = Metric.timer(`${name}Duration`);
  return effect.pipe(
    Metric.trackDuration(durTimer),
    Effect.tap(() => Metric.update(callCounter, 1)),
  );
};
