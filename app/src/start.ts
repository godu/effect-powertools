import { createMiddleware, createStart } from "@tanstack/react-start";

import {
  observabilityServerFn,
  runtimeServerFn,
} from "effect-powertools/tanstack-start";
import { observabilityLayer } from "./server/layer.server";

const runtimeMw = createMiddleware().server(
  runtimeServerFn(observabilityLayer),
);
const observabilityMw = createMiddleware()
  .middleware([runtimeMw])
  .server(observabilityServerFn());

export const startInstance = createStart(() => ({
  requestMiddleware: [runtimeMw, observabilityMw],
}));
