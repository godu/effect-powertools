import { createMiddleware, createStart } from "@tanstack/react-start";

import {
  captureRequest,
  provideRuntimeServer,
} from "effect-powertools/tanstack-start";
import { observabilityLayer } from "./server/layer.server";

const runtimeMw = createMiddleware().server(
  provideRuntimeServer(observabilityLayer),
);
const observabilityMw = createMiddleware()
  .middleware([runtimeMw])
  .server(captureRequest());

export const startInstance = createStart(() => ({
  requestMiddleware: [runtimeMw, observabilityMw],
}));
