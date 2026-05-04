import type { Segment, Subsegment } from "aws-xray-sdk-core";
import { createMiddleware } from "@tanstack/react-start";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Tracer from "effect/Tracer";

import { PowertoolsMetricsService } from "./metrics";
import { PowertoolsTracerService, stripXrayTraceIdPrefix } from "./tracer";

// =============================================================================
// runtimeMiddleware — build a ManagedRuntime once at module load and inject
// it into ctx.context so downstream routes / server-fns can read it.
// =============================================================================

export const runtimeMiddleware = <A, E>(layer: Layer.Layer<A, E>) => {
  const runtime = ManagedRuntime.make(layer);
  if (typeof process !== "undefined" && typeof process.on === "function") {
    process.on("SIGTERM", () => {
      void runtime.dispose();
    });
  }
  return createMiddleware().server(async ({ next }) =>
    next({ context: { runtime } }),
  );
};

// =============================================================================
// observabilityMiddleware — faithful port of Powertools middy
// `captureLambdaHandler` (packages/tracer/src/middleware/middy.ts) plus the
// X-Ray segment-document HTTP block per the spec at
// https://docs.aws.amazon.com/xray/latest/devguide/xray-api-segmentdocuments.html#api-segmentdocuments-http
//
// Operation order matches middy:
//   before:  isTracingEnabled → getSegment → addNewSubsegment("## name")
//            → setSegment(sub) → annotateColdStart → addServiceNameAnnotation
//   after:   addResponseAsMetadata(result, name) → close()
//   onError: addErrorAsMetadata(err) → close()
//   close:   subsegment.close() → setSegment(parent)
//
// Reads the raw Powertools Tracer through `PowertoolsTracerService`; calls
// `captureColdStart()` / `flush()` on `PowertoolsMetricsService` (Effect-wrapped
// helpers). No direct Powertools imports leak to consumer code.
//
// Effect-side parent chaining: an `ExternalSpan` is built from the X-Ray
// subsegment and provided to route programs via `Layer.parentSpan(...)`,
// so route-side `Effect.withSpan(...)` declares the Lambda subsegment as
// its parent both on the Effect side and on the X-Ray side (via cls-hooked
// context, which the bridge tracer reads).
// =============================================================================

export interface ObservabilityOptions {
  readonly serviceName?: string;
  readonly resolveSpanName?: (request: Request, pathname: string) => string;
}

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
      ...(Number.isFinite(contentLength)
        ? { content_length: contentLength }
        : {}),
    },
  };
};

const wrapRuntimeWithParentSpan = <R, E>(
  rt: ManagedRuntime.ManagedRuntime<R, E>,
  span: Tracer.AnySpan,
): ManagedRuntime.ManagedRuntime<R, E> => {
  const parentLayer = Layer.parentSpan(span);
  return new Proxy(rt, {
    get(target, prop, receiver) {
      if (prop === "runPromise") {
        return <A, EE>(effect: Effect.Effect<A, EE, R>) =>
          target.runPromise(Effect.provide(effect, parentLayer));
      }
      if (prop === "runPromiseExit") {
        return <A, EE>(effect: Effect.Effect<A, EE, R>) =>
          target.runPromiseExit(Effect.provide(effect, parentLayer));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
};

interface SetupResult {
  readonly tracingEnabled: boolean;
  readonly parent: Segment | Subsegment | undefined;
  readonly sub: Subsegment | undefined;
}

type ObservabilityRuntime = ManagedRuntime.ManagedRuntime<
  PowertoolsTracerService | PowertoolsMetricsService,
  never
>;

export const observabilityMiddleware = (opts: ObservabilityOptions = {}) =>
  createMiddleware().server(
    async ({ next, request, pathname, context }) => {
      const runtime = (context as unknown as { runtime: ObservabilityRuntime })
        .runtime;

      const name =
        opts.resolveSpanName?.(request, pathname) ??
        opts.serviceName ??
        `${request.method} ${pathname}`;

      // === before ===
      const setup: SetupResult = await runtime.runPromise(
        Effect.gen(function* () {
          const ptTracer = yield* PowertoolsTracerService;
          const ptMetrics = yield* PowertoolsMetricsService;

          const tracingEnabled = ptTracer.isTracingEnabled();
          let parent: Segment | Subsegment | undefined;
          let sub: Subsegment | undefined;

          if (tracingEnabled) {
            parent = ptTracer.getSegment();
            sub = parent?.addNewSubsegment(`## ${name}`);
            if (sub) {
              ptTracer.setSegment(sub);
              setHttpRequest(sub, request, pathname);
            }
            ptTracer.annotateColdStart();
            ptTracer.addServiceNameAnnotation();
          }

          yield* ptMetrics.captureColdStart();
          yield* ptMetrics.addDimension(
            "environment",
            process.env.STAGE ?? "dev",
          );
          return { tracingEnabled, parent, sub };
        }),
      );

      // Construct an ExternalSpan so route-side Effect spans declare the
      // Lambda subsegment as their parent (Layer.parentSpan).
      // `trace_id` is set at runtime on subsegments (segments/attributes/subsegment.js)
      // but not declared on the @types — cast to read it.
      const externalSpan: Tracer.AnySpan | undefined = setup.sub
        ? Tracer.externalSpan({
            spanId: setup.sub.id,
            traceId: stripXrayTraceIdPrefix(
              (setup.sub as unknown as { trace_id?: string }).trace_id,
            ),
            sampled: true,
          })
        : undefined;

      const exposedRuntime = externalSpan
        ? wrapRuntimeWithParentSpan(runtime, externalSpan)
        : runtime;

      try {
        const result = await next({ context: { runtime: exposedRuntime } });

        // === after (success) ===
        await runtime.runPromise(
          Effect.gen(function* () {
            const ptTracer = yield* PowertoolsTracerService;
            if (setup.sub) setHttpResponse(setup.sub, result.response);
            if (setup.tracingEnabled) {
              ptTracer.addResponseAsMetadata(result.response, name);
            }
          }),
        );
        return result;
      } catch (err) {
        // === onError ===
        await runtime.runPromise(
          Effect.gen(function* () {
            const ptTracer = yield* PowertoolsTracerService;
            if (setup.sub) {
              setHttpResponse(setup.sub, new Response(null, { status: 500 }));
            }
            if (setup.tracingEnabled) {
              ptTracer.addErrorAsMetadata(err as Error);
            }
          }),
        );
        throw err;
      } finally {
        // === close (always) ===
        await runtime.runPromise(
          Effect.gen(function* () {
            const ptTracer = yield* PowertoolsTracerService;
            const ptMetrics = yield* PowertoolsMetricsService;
            if (setup.sub) {
              try {
                setup.sub.close();
              } catch {
                /* already closed */
              }
            }
            if (setup.parent) ptTracer.setSegment(setup.parent);
            yield* ptMetrics.flush();
          }),
        );
      }
    },
  );
