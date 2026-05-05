import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Tracer from "effect/Tracer";

// Tracks runtimes whose SIGTERM disposer we've already registered, so calling
// the registration helper more than once with the same runtime doesn't leak
// listeners.
const registeredDisposers = new WeakSet<
  ManagedRuntime.ManagedRuntime<unknown, unknown>
>();

export const registerSigtermDisposer = <R, E>(
  runtime: ManagedRuntime.ManagedRuntime<R, E>,
): void => {
  const opaque = runtime as ManagedRuntime.ManagedRuntime<unknown, unknown>;
  if (registeredDisposers.has(opaque)) return;
  if (typeof process === "undefined" || typeof process.on !== "function") {
    return;
  }
  registeredDisposers.add(opaque);
  process.on("SIGTERM", () => {
    void runtime.dispose();
  });
};

// Returns a proxy whose `run*` methods auto-apply `Layer.parentSpan(span)` to
// any Effect they're given. Equivalent in spirit to
// `Runtime.updateContext(Context.add(Tracer.ParentSpan, span))`, but applied
// per-call so callers don't need to await the lazy underlying Runtime
// synchronously.
export const wrapRuntimeWithParentSpan = <R, E>(
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
