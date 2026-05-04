import {
  createMiddleware,
  createServerOnlyFn,
  createStart,
} from "@tanstack/react-start";

import {
  observabilityServerFn,
  runtimeServerFn,
} from "effect-powertools/tanstack-start";
import { observabilityLayer } from "./server/layer.server";

// `createServerOnlyFn` lets the build plugin strip these imports from the
// client bundle. The wrapper itself becomes a stub that THROWS on the client
// (start-plugin-core/src/start-compiler/handleEnvOnly.ts), so we must not
// invoke it during client-side getOptions(). `import.meta.env.SSR` is a Vite
// build-time constant — the false branch is tree-shaken from the client.
const buildRequestMiddlewares = createServerOnlyFn(() => {
  const runtimeMw = createMiddleware().server(
    runtimeServerFn(observabilityLayer),
  );
  const observabilityMw = createMiddleware()
    .middleware([runtimeMw])
    .server(observabilityServerFn({ serviceName: "/api/trigger" }));
  return [runtimeMw, observabilityMw] as const;
});

type StartOptions = {
  requestMiddleware: ReturnType<typeof buildRequestMiddlewares>;
};

export const startInstance = createStart(
  (): StartOptions => ({
    requestMiddleware: buildRequestMiddlewares(),
  }),
);
