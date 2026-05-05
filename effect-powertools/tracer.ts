import type { Tracer as PowertoolsTracer } from "@aws-lambda-powertools/tracer";
import AWSXRay, { type Segment, type Subsegment } from "aws-xray-sdk-core";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Inspectable from "effect/Inspectable";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EffectTracer from "effect/Tracer";

/**
 * Bridges Effect's Tracer to AWS X-Ray subsegments via Powertools.
 *
 * Each Effect span maps to an X-Ray subsegment. The X-Ray "current segment"
 * is process-wide, but the Tracer's `context` callback fires synchronously
 * around every Effect step with access to the running fiber. We open a new
 * cls-hooked namespace context per step, pin the segment to the fiber's
 * current span inside it, and call `execution()` from within. Async work
 * spawned by that step (Promises, AWS SDK middleware installed by
 * `captureAWSv3Client(...)`) inherits the namespace context via
 * `async_hooks` and resolves the right segment even when sibling fibers
 * have advanced — so concurrent `Effect.forEach({ concurrency: ... })`
 * branches keep their AWS SDK leaf subsegments correctly nested.
 */

export type AttributeKind = "annotation" | "metadata" | "skip";

export interface PowertoolsTracerOptions {
  readonly tracer: PowertoolsTracer;
  readonly classifyAttribute?: (
    key: string,
    value: unknown,
  ) => AttributeKind;
}

const defaultClassify = (_key: string, _value: unknown): AttributeKind =>
  "annotation";

interface BridgeSpan extends EffectTracer.Span {
  readonly subsegment: Subsegment | undefined;
}

// Strips X-Ray's "1-" prefix and dashes from a trace id so it lines up with
// the OpenTelemetry-compatible 32-hex format. Internal helper for building
// Effect `ExternalSpan`s from X-Ray subsegments.
export const stripXrayTraceIdPrefix = (raw: string | undefined): string => {
  if (!raw) return "0".repeat(32);
  return raw.startsWith("1-") ? raw.slice(2).replace(/-/g, "") : raw;
};

const nanosToIsoString = (ns: bigint): string =>
  new Date(Number(ns / 1_000_000n)).toISOString();

const setAttributeOnSubsegment = (
  sub: Subsegment,
  classify: NonNullable<PowertoolsTracerOptions["classifyAttribute"]>,
  key: string,
  value: unknown,
) => {
  const kind = classify(key, value);
  if (kind === "skip") return;
  if (kind === "metadata") {
    sub.addMetadata(key, value);
    return;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    sub.addAnnotation(key, value);
    return;
  }
  sub.addAnnotation(key, Inspectable.toStringUnknown(value));
};

// `crypto.randomUUID()` is in both Node 20+ and modern browsers — no
// node:crypto dependency that breaks Vite's client build. UUIDs are 32 hex
// chars + 4 dashes; strip the dashes to get a hex string.
const randomHex = (len: number): string =>
  globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, len);

const resolveParentForSubsegment = (
  ptTracer: PowertoolsTracer,
  parent: Option.Option<EffectTracer.AnySpan>,
): Segment | Subsegment | undefined => {
  if (Option.isSome(parent) && parent.value._tag === "Span") {
    const ours = (parent.value as BridgeSpan).subsegment;
    if (ours) return ours;
  }
  if (!ptTracer.isTracingEnabled()) return undefined;
  return ptTracer.getSegment();
};

const makeSpan = (
  options: PowertoolsTracerOptions,
  name: string,
  parent: Option.Option<EffectTracer.AnySpan>,
  context: Context.Context<never>,
  links: ReadonlyArray<EffectTracer.SpanLink>,
  startTime: bigint,
  kind: EffectTracer.SpanKind,
  spanOpts?: EffectTracer.SpanOptions,
): EffectTracer.Span => {
  const classify = options.classifyAttribute ?? defaultClassify;
  const ptTracer = options.tracer;

  const parentSegment = resolveParentForSubsegment(ptTracer, parent);
  const subsegment = parentSegment?.addNewSubsegment(name);

  const attributes = new Map<string, unknown>();
  if (spanOpts?.attributes) {
    for (const [k, v] of Object.entries(spanOpts.attributes)) {
      attributes.set(k, v);
      if (subsegment) setAttributeOnSubsegment(subsegment, classify, k, v);
    }
  }

  const spanId = subsegment?.id ?? randomHex(16);
  const traceId = stripXrayTraceIdPrefix(subsegment?.segment?.trace_id);
  const sampled = subsegment ? !subsegment.notTraced : false;

  let status: EffectTracer.SpanStatus = { _tag: "Started", startTime };
  const eventsBuffer: Array<{
    name: string;
    startTime: string;
    attributes?: Record<string, unknown>;
  }> = [];
  const linkBuffer: Array<EffectTracer.SpanLink> = [...links];

  const span: BridgeSpan = {
    _tag: "Span",
    name,
    spanId,
    traceId,
    parent,
    context,
    get status() {
      return status;
    },
    attributes,
    get links() {
      return linkBuffer;
    },
    sampled,
    kind,
    subsegment,
    attribute(key, value) {
      attributes.set(key, value);
      if (subsegment) setAttributeOnSubsegment(subsegment, classify, key, value);
    },
    event(eventName, startTimeNs, eventAttributes) {
      eventsBuffer.push({
        name: eventName,
        startTime: nanosToIsoString(startTimeNs),
        attributes: eventAttributes,
      });
      if (subsegment) {
        subsegment.addMetadata("effect_events", eventsBuffer);
      }
    },
    addLinks(extra) {
      for (const link of extra) linkBuffer.push(link);
      if (subsegment && linkBuffer.length > 0) {
        subsegment.addMetadata(
          "effect_links",
          linkBuffer.map((l) => ({
            traceId: l.span.traceId,
            spanId: l.span.spanId,
            attributes: l.attributes,
          })),
        );
      }
    },
    end(endTime, exit) {
      status = { _tag: "Ended", startTime, endTime, exit };
      if (subsegment) {
        if (exit._tag === "Failure") {
          const cause = exit.cause;
          if (Cause.isInterruptedOnly(cause)) {
            try {
              subsegment.addAnnotation("interrupted", true);
            } catch {
              // best-effort
            }
          } else {
            try {
              subsegment.addError(new Error(Cause.pretty(cause)));
            } catch {
              // best-effort
            }
            try {
              if (Cause.isFailType(cause)) subsegment.addErrorFlag();
              else subsegment.addFaultFlag();
            } catch {
              // best-effort
            }
          }
        }
        try {
          subsegment.close();
        } catch {
          // already closed
        }
      }
    },
  };

  return span;
};

export const makePowertoolsTracer = (
  options: PowertoolsTracerOptions,
): EffectTracer.Tracer => {
  const ptTracer = options.tracer;
  return EffectTracer.make({
    span(name, parent, context, links, startTime, kind, spanOpts) {
      return makeSpan(
        options,
        name,
        parent,
        context,
        links,
        startTime,
        kind,
        spanOpts,
      );
    },
    // Per-step async-context isolation. Open a fresh cls-hooked child
    // namespace, pin the X-Ray segment to the fiber's current span, then
    // run the step. async_hooks propagates the namespace through any
    // Promise / AWS SDK middleware spawned inside, so concurrent fibers
    // don't see each other's segment writes.
    context(execution, fiber) {
      if (!ptTracer.isTracingEnabled()) return execution();
      const fiberSpan = fiber.currentSpan;
      if (!fiberSpan || fiberSpan._tag !== "Span") return execution();
      const sub = (fiberSpan as BridgeSpan).subsegment;
      if (!sub) return execution();
      const ns = AWSXRay.getNamespace();
      if (!ns) return execution();
      return ns.runAndReturn(() => {
        try {
          ptTracer.setSegment(sub);
        } catch {
          // setSegment can throw outside Lambda; swallow and run anyway.
        }
        return execution();
      });
    },
  });
};

// Service tag for the raw Powertools Tracer instance — lets downstream
// Effect programs interact with the X-Ray SDK directly (e.g., a TanStack
// Start observability middleware reading the active segment).
export class PowertoolsTracerService extends Context.Tag(
  "@app/PowertoolsTracerService",
)<PowertoolsTracerService, PowertoolsTracer>() {}

export const PowertoolsTracerLayer = (
  options: PowertoolsTracerOptions,
): Layer.Layer<PowertoolsTracerService> =>
  Layer.merge(
    Layer.setTracer(makePowertoolsTracer(options)),
    Layer.succeed(PowertoolsTracerService, options.tracer),
  );

