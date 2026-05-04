// =============================================================================
// TanStack Start server-fn bodies for the Effect ↔ Powertools bridge.
//
// This module exports the inner `async ({ next, request, pathname, context })`
// handler bodies that consumers plug into `createMiddleware().server(...)` at
// the call site. The middleware-chain wiring (createMiddleware, .middleware,
// .server) lives in the consumer so TanStack Start's type inference runs
// end-to-end at the wiring point.
//
// Concurrency caveat: the Powertools tracer's segment context is process-
// global (cls-hooked / aws-xray-sdk-core). Lambda's one-request-per-container
// model masks this; under any preset with concurrency > 1 (local dev,
// Fargate, multi-process node servers) two concurrent invocations will race
// the global segment and cross-contaminate traces. Same constraint already
// flagged in `tracer.ts` for `Effect.fork`.
// =============================================================================

import "@tanstack/react-start/server-only";

import type { Segment, Subsegment } from "aws-xray-sdk-core";
import type { RequestServerOptions } from "@tanstack/react-start";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import { PowertoolsMetricsService } from "./metrics";
import { PowertoolsTracerService, stripXrayTraceIdPrefix } from "./tracer";

// =============================================================================
// runtimeServerFn — build a ManagedRuntime once and inject into ctx.context.
// =============================================================================

// Tracks runtimes whose SIGTERM disposer we've already registered, so calling
// `runtimeServerFn()` more than once doesn't leak listeners.
const registeredDisposers = new WeakSet<ManagedRuntime.ManagedRuntime<unknown, unknown>>();

export const runtimeServerFn = <A, E>(layer: Layer.Layer<A, E>) => {
  const runtime = ManagedRuntime.make(layer);
  if (
    !registeredDisposers.has(
      runtime as ManagedRuntime.ManagedRuntime<unknown, unknown>,
    ) &&
    typeof process !== "undefined" &&
    typeof process.on === "function"
  ) {
    registeredDisposers.add(
      runtime as ManagedRuntime.ManagedRuntime<unknown, unknown>,
    );
    process.on("SIGTERM", () => {
      void runtime.dispose();
    });
  }
  return async <TR, TM>(options: RequestServerOptions<TR, TM>) =>
    options.next({ context: { runtime } });
};

// =============================================================================
// observabilityServerFn — captureLambdaHandler port + X-Ray http block
//
// Faithful port of Powertools middy `captureLambdaHandler`
// (packages/tracer/src/middleware/middy.ts) plus the X-Ray segment-document
// `http` block per
// https://docs.aws.amazon.com/xray/latest/devguide/xray-api-segmentdocuments.html#api-segmentdocuments-http
//
// Operation order matches middy:
//   acquire (before): isTracingEnabled → getSegment → addNewSubsegment("## name")
//                     → setSegment(sub) → http.request → annotateColdStart
//                     → addServiceNameAnnotation → captureColdStartMetric
//                     → addDimension
//   use:              await next(...) (TanStack Start)
//   release (always): on success → http.response + addResponseAsMetadata
//                     on failure → http.response 500 + addErrorAsMetadata
//                     subsegment.close() → setSegment(parent) → flush metrics
//
// Effect-side parent chaining: an `ExternalSpan` is built from the X-Ray
// subsegment and provided to route programs via `Layer.parentSpan(...)` —
// every `run*` method of the runtime exposed to the route auto-applies it,
// so route-side `Effect.withSpan(...)` declares the Lambda subsegment as its
// parent both on the Effect side and on the X-Ray side (cls-hooked).
//
// Errors thrown by `next()` are preserved verbatim — `Effect.acquireUseRelease`
// guarantees the release path can't shadow the use-path error, and we unwrap
// Effect's typed failure back to the original `throw`able at the boundary.
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
  segment: Segment | Subsegment,
  request: Request,
  pathname: string,
): void => {
  const search = new URL(request.url).search;
  const xff = request.headers.get("x-forwarded-for");
  const target = segment as unknown as { http?: XRayHttp };
  target.http = {
    ...target.http,
    request: {
      method: request.method,
      url: `${pathname}${search}`,
      user_agent: request.headers.get("user-agent") ?? undefined,
      client_ip: xff?.split(",")[0]?.trim() ?? undefined,
      x_forwarded_for: xff !== null,
    },
  };
};

const setHttpResponseStatus = (
  segment: Segment | Subsegment,
  status: number,
  contentLength: number | undefined,
): void => {
  const target = segment as unknown as { http?: XRayHttp };
  target.http = {
    ...target.http,
    response: {
      status,
      ...(contentLength !== undefined ? { content_length: contentLength } : {}),
    },
  };
};

const parseContentLength = (response: Response): number | undefined => {
  const cl = response.headers.get("content-length");
  if (cl === null) return undefined;
  const n = Number.parseInt(cl, 10);
  return Number.isFinite(n) ? n : undefined;
};

// Wrap a ManagedRuntime so every `run*` method auto-applies
// `Layer.parentSpan(span)`. Equivalent in spirit to
// `Runtime.updateContext(Context.add(Tracer.ParentSpan, span))`, but applied
// per-call so we don't need to await the lazy underlying Runtime synchronously.
const wrapRuntimeWithParentSpan = <R, E>(
  rt: ManagedRuntime.ManagedRuntime<R, E>,
  span: Tracer.AnySpan,
): ManagedRuntime.ManagedRuntime<R, E> => {
  const parentLayer = Layer.parentSpan(span);
  const provide = <A, EE>(eff: Effect.Effect<A, EE, R>) =>
    Effect.provide(eff, parentLayer);
  return new Proxy(rt, {
    get(target, prop, receiver) {
      switch (prop) {
        case "runPromise":
        case "runPromiseExit":
        case "runFork":
        case "runSync":
        case "runSyncExit":
        case "runCallback": {
          const fn = Reflect.get(target, prop, receiver) as (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...args: any[]
          ) => unknown;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (eff: Effect.Effect<any, any, R>, ...rest: any[]) =>
            fn.call(target, provide(eff), ...rest);
        }
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });
};

interface SetupResult {
  readonly tracingEnabled: boolean;
  readonly parent: Segment | Subsegment | undefined;
  readonly sub: Subsegment | undefined;
}

// Sentinel that wraps a Promise rejection so we can preserve the original
// error verbatim across the Effect boundary.
class NextError {
  readonly _tag = "NextError";
  constructor(readonly error: unknown) {}
}

// `ManagedRuntime` is contravariant in `R` (effect/ManagedRuntime.d.ts:46 —
// `interface ManagedRuntime<in R, out ER>`), so any runtime providing at least
// `Tracer | Metrics` (e.g. `Logger | Tracer | Metrics`) is assignable here.
export const observabilityServerFn = (opts: ObservabilityOptions = {}) =>
  async <TR, TM>(
    options: RequestServerOptions<TR, TM> & {
      context: {
        runtime: ManagedRuntime.ManagedRuntime<
          PowertoolsTracerService | PowertoolsMetricsService,
          unknown
        >;
      };
    },
  ) => {
    const { next, request, pathname, context } = options;
    const runtime = context.runtime;

    const name =
      opts.resolveSpanName?.(request, pathname) ??
      opts.serviceName ??
      `${request.method} ${pathname}`;

    // Capture-once for use as the call site's typed-result.
    type NextResult = Awaited<ReturnType<typeof next>>;

    const program = Effect.acquireUseRelease(
      // ---------- acquire ----------
      Effect.gen(function* () {
        const ptTracer = yield* PowertoolsTracerService;
        const ptMetrics = yield* PowertoolsMetricsService;

        const tracingEnabled = ptTracer.isTracingEnabled();
        let parent: Segment | Subsegment | undefined;
        let sub: Subsegment | undefined;
        if (tracingEnabled) {
          parent = ptTracer.getSegment();
          if (parent) setHttpRequest(parent, request, pathname);
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
        return { tracingEnabled, parent, sub } as SetupResult;
      }),
      // ---------- use ----------
      (setup) =>
        Effect.gen(function* () {
          // Build ExternalSpan from the live subsegment so route-side
          // Effect spans declare the Lambda subsegment as their parent.
          const externalSpan: Tracer.AnySpan | undefined = setup.sub
            ? Tracer.externalSpan({
                spanId: setup.sub.id,
                traceId: stripXrayTraceIdPrefix(
                  setup.sub.segment?.trace_id,
                ),
                sampled: true,
              })
            : undefined;
          const exposedRuntime = externalSpan
            ? wrapRuntimeWithParentSpan(runtime, externalSpan)
            : runtime;
          return yield* Effect.tryPromise({
            try: () =>
              next({
                context: { runtime: exposedRuntime },
              }) as Promise<NextResult>,
            catch: (e) => new NextError(e),
          });
        }),
      // ---------- release (always) ----------
      (setup, exit) =>
        Effect.gen(function* () {
          const ptTracer = yield* PowertoolsTracerService;
          const ptMetrics = yield* PowertoolsMetricsService;

          if (Exit.isSuccess(exit)) {
            const status = exit.value.response.status;
            const contentLength = parseContentLength(exit.value.response);
            if (setup.parent) {
              setHttpResponseStatus(setup.parent, status, contentLength);
            }
            if (setup.sub) {
              setHttpResponseStatus(setup.sub, status, contentLength);
            }
            if (setup.tracingEnabled) {
              ptTracer.addResponseAsMetadata(
                {
                  status: exit.value.response.status,
                  statusText: exit.value.response.statusText,
                },
                name,
              );
            }
          } else {
            if (setup.parent) setHttpResponseStatus(setup.parent, 500, undefined);
            if (setup.sub) setHttpResponseStatus(setup.sub, 500, undefined);
            if (setup.tracingEnabled) {
              const failure = Cause.failureOption(exit.cause);
              const err =
                Option.isSome(failure) && failure.value instanceof NextError
                  ? failure.value.error
                  : Cause.squash(exit.cause);
              ptTracer.addErrorAsMetadata(
                err instanceof Error ? err : new Error(String(err)),
              );
            }
          }

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

    const exit = await runtime.runPromiseExit(program);
    if (Exit.isFailure(exit)) {
      // Re-raise the original `throw` from `next()` so TanStack Start sees
      // it verbatim. Anything else (defect inside acquire/release) becomes
      // an Error built from Cause.pretty.
      const failure = Cause.failureOption(exit.cause);
      if (Option.isSome(failure) && failure.value instanceof NextError) {
        throw failure.value.error;
      }
      throw new Error(Cause.pretty(exit.cause));
    }
    return exit.value;
  };

