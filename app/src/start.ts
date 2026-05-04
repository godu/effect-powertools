import { createMiddleware, createStart } from "@tanstack/react-start";

import { ptMetrics, ptTracer, runtime } from "./server/observability";

const HANDLER_NAME = "/api/trigger";

// Faithful port of Powertools middy `captureLambdaHandler`
// (packages/tracer/src/middleware/middy.ts) into the TanStack Start
// `({ next }) => await next(...)` middleware contract:
//
//   before:           isTracingEnabled → getSegment → addNewSubsegment("## name")
//                     → setSegment(sub) → annotateColdStart → addServiceNameAnnotation
//   after (success):  addResponseAsMetadata(result, name) → close()
//   onError:          addErrorAsMetadata(err) → close()
//   close (always):   subsegment.close() → setSegment(parent)
//
// The route only sees `runtime` in ctx.context — Powertools instances are
// kept inside this module. Effect spans created downstream by `runtime`
// chain under the subsegment we opened here, because the bridge tracer
// reads `ptTracer.getSegment()` (X-Ray context, propagated via cls-hooked /
// AsyncLocalStorage through `await next(...)`).
const observabilityMiddleware = createMiddleware().server(async ({ next }) => {
  const tracingEnabled = ptTracer.isTracingEnabled();
  let parentSegment: ReturnType<typeof ptTracer.getSegment> | undefined;
  let subsegment:
    | ReturnType<NonNullable<typeof parentSegment>["addNewSubsegment"]>
    | undefined;

  if (tracingEnabled) {
    parentSegment = ptTracer.getSegment();
    subsegment = parentSegment?.addNewSubsegment(`## ${HANDLER_NAME}`);
    if (subsegment) ptTracer.setSegment(subsegment);
    ptTracer.annotateColdStart();
    ptTracer.addServiceNameAnnotation();
  }

  ptMetrics.captureColdStartMetric();
  ptMetrics.addDimension("environment", process.env.STAGE ?? "dev");

  try {
    const result = await next({ context: { runtime } });
    if (tracingEnabled) {
      ptTracer.addResponseAsMetadata(result.response, HANDLER_NAME);
    }
    return result;
  } catch (err) {
    if (tracingEnabled) {
      ptTracer.addErrorAsMetadata(err as Error);
    }
    throw err;
  } finally {
    if (subsegment) {
      try {
        subsegment.close();
      } catch {
        /* already closed */
      }
    }
    if (parentSegment) ptTracer.setSegment(parentSegment);
    ptMetrics.publishStoredMetrics();
  }
});

export const startInstance = createStart(() => ({
  requestMiddleware: [observabilityMiddleware],
}));
