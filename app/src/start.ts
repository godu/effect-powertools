import { createServerOnlyFn, createStart } from "@tanstack/react-start";

import {
  observabilityMiddleware,
  runtimeMiddleware,
} from "effect-powertools/tanstack-start";
import { observabilityLayer } from "./server/layer.server";

// `createServerOnlyFn` makes the wrapped body server-only — its imports
// (effect-powertools/tanstack-start, ./server/layer.server) are stripped
// from the client bundle by TanStack Start's plugin. The function body is
// only ever evaluated server-side; client gets a stub.
const buildRequestMiddlewares = createServerOnlyFn(() => [
  runtimeMiddleware(observabilityLayer),
  observabilityMiddleware({ serviceName: "/api/trigger" }),
]);

export const startInstance = createStart(() => ({
  requestMiddleware: buildRequestMiddlewares(),
}));
