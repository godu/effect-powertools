import { createMiddleware, createStart } from "@tanstack/react-start";

import { ptMetrics, ptTracer, runtime } from "./server/observability";

const HANDLER_NAME = "/api/trigger";

// Populate the X-Ray segment-document `http` block per the spec:
// https://docs.aws.amazon.com/xray/latest/devguide/xray-api-segmentdocuments.html#api-segmentdocuments-http
// X-Ray auto-populates this for API-Gateway/ALB Lambda integrations, but not
// for Lambda Function URLs invoked through Nitro/h3 — we have to do it.
type XRayHttp = {
  request?: {
    method?: string;
    url?: string;
    user_agent?: string;
    client_ip?: string;
    x_forwarded_for?: boolean;
  };
  response?: { status?: number; content_length?: number };
};

const setHttpRequest = (
  sub: unknown,
  request: Request,
  pathname: string,
): void => {
  const url = new URL(request.url);
  const xff = request.headers.get("x-forwarded-for");
  const target = sub as { http?: XRayHttp };
  target.http = {
    ...target.http,
    request: {
      method: request.method,
      url: `${url.protocol}//${url.host}${pathname}${url.search}`,
      user_agent: request.headers.get("user-agent") ?? undefined,
      client_ip: xff?.split(",")[0]?.trim() ?? undefined,
      x_forwarded_for: xff !== null,
    },
  };
};

const setHttpResponse = (sub: unknown, response: Response): void => {
  const cl = response.headers.get("content-length");
  const contentLength = cl !== null ? Number.parseInt(cl, 10) : Number.NaN;
  const target = sub as { http?: XRayHttp };
  target.http = {
    ...target.http,
    response: {
      status: response.status,
      ...(Number.isFinite(contentLength) ? { content_length: contentLength } : {}),
    },
  };
};

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
const observabilityMiddleware = createMiddleware().server(
  async ({ next, request, pathname }) => {
    const tracingEnabled = ptTracer.isTracingEnabled();
    let parentSegment: ReturnType<typeof ptTracer.getSegment> | undefined;
    let subsegment:
      | ReturnType<NonNullable<typeof parentSegment>["addNewSubsegment"]>
      | undefined;

    if (tracingEnabled) {
      parentSegment = ptTracer.getSegment();
      subsegment = parentSegment?.addNewSubsegment(`## ${HANDLER_NAME}`);
      if (subsegment) {
        ptTracer.setSegment(subsegment);
        setHttpRequest(subsegment, request, pathname);
      }
      ptTracer.annotateColdStart();
      ptTracer.addServiceNameAnnotation();
    }

    ptMetrics.captureColdStartMetric();
    ptMetrics.addDimension("environment", process.env.STAGE ?? "dev");

    try {
      const result = await next({ context: { runtime } });
      if (tracingEnabled) {
        if (subsegment) setHttpResponse(subsegment, result.response);
        ptTracer.addResponseAsMetadata(result.response, HANDLER_NAME);
      }
      return result;
    } catch (err) {
      if (tracingEnabled) {
        if (subsegment) {
          // Synthetic 500 — the route never produced a Response on this path.
          setHttpResponse(
            subsegment,
            new Response(null, { status: 500 }),
          );
        }
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
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [observabilityMiddleware],
}));
