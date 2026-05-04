import type { Tracer as PowertoolsTracer } from "@aws-lambda-powertools/tracer";
import type { Segment, Subsegment } from "aws-xray-sdk-core";
import type * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EffectTracer from "effect/Tracer";

/**
 * Bridges Effect's Tracer to AWS X-Ray subsegments via Powertools.
 *
 * Each Effect span maps to an X-Ray subsegment. On span creation we swap the
 * Powertools `Tracer` global segment to our new subsegment so any
 * `captureAWSv3Client(...)`-instrumented client lands its calls under the
 * right subsegment when invoked from inside `Effect.withSpan(...)`. On span
 * `end` we restore the previously active segment.
 *
 * Caveat: X-Ray's global segment is process-wide. If two Effect fibers spawn
 * via `Effect.fork` and run concurrently in the same Lambda invocation they
 * will race for the global. The demo handler is strictly sequential.
 */

const ANNOTATION_ALLOWLIST = new Set<string>([
  "orderId",
  "customerId",
  "bucket",
  "key",
  "messageId",
  "service",
]);

export type AttributeKind = "annotation" | "metadata" | "skip";

export interface PowertoolsTracerOptions {
  readonly tracer: PowertoolsTracer;
  readonly classifyAttribute?: (
    key: string,
    value: unknown,
  ) => AttributeKind;
}

const defaultClassify = (key: string, value: unknown): AttributeKind => {
  if (
    ANNOTATION_ALLOWLIST.has(key) &&
    (typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean")
  ) {
    return "annotation";
  }
  return "metadata";
};

interface BridgeSpan extends EffectTracer.Span {
  readonly subsegment: Subsegment | undefined;
}

const stripTraceIdPrefix = (raw: string | undefined): string => {
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
  if (
    kind === "annotation" &&
    (typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean")
  ) {
    sub.addAnnotation(key, value);
    return;
  }
  sub.addMetadata(key, value);
};

const randomHex = (len: number): string => {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
};

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

  // Snapshot the currently active X-Ray segment, then promote our subsegment
  // so any captureAWSv3Client middleware sees it. Restored in end().
  const previousActiveSegment = ptTracer.isTracingEnabled()
    ? ptTracer.getSegment()
    : undefined;
  if (subsegment) {
    try {
      ptTracer.setSegment(subsegment);
    } catch {
      // setSegment can throw outside Lambda; swallow.
    }
  }

  const attributes = new Map<string, unknown>();
  if (spanOpts?.attributes) {
    for (const [k, v] of Object.entries(spanOpts.attributes)) {
      attributes.set(k, v);
      if (subsegment) setAttributeOnSubsegment(subsegment, classify, k, v);
    }
  }

  const spanId = subsegment?.id ?? randomHex(16);
  const traceId = stripTraceIdPrefix(subsegment?.segment?.trace_id);
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
          try {
            subsegment.addError(new Error(`effect span "${name}" failed`));
          } catch {
            // best-effort
          }
        }
        try {
          subsegment.close();
        } catch {
          // already closed
        }
      }
      if (previousActiveSegment) {
        try {
          ptTracer.setSegment(previousActiveSegment);
        } catch {
          // ignore
        }
      }
    },
  };

  return span;
};

export const makePowertoolsTracer = (
  options: PowertoolsTracerOptions,
): EffectTracer.Tracer =>
  EffectTracer.make({
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
    context(execution, _fiber) {
      return execution();
    },
  });

export const PowertoolsTracerLayer = (
  options: PowertoolsTracerOptions,
): Layer.Layer<never> => Layer.setTracer(makePowertoolsTracer(options));
