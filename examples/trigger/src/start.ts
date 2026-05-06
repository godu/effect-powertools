import { createMiddleware, createStart } from "@tanstack/react-start";

import {
  captureRequest,
  provideRuntimeServer,
} from "effect-powertools/tanstack-start";
import { observabilityLayer } from "./server/layer.server";

const runtimeMw = createMiddleware().server(
  provideRuntimeServer(observabilityLayer),
);
// `serviceName` becomes the X-Ray subsegment name (`## trigger`); without
// it the bridge falls back to `${request.method} ${pathname}`. Override
// per-request with `resolveSpanName` when one Lambda fronts many routes —
// the default `GET /api/trigger` reads cleanly in the X-Ray Trace Map.
const observabilityMw = createMiddleware()
  .middleware([runtimeMw])
  .server(
    captureRequest({
      serviceName: "trigger",
      resolveSpanName: (request, pathname) => `${request.method} ${pathname}`,
    }),
  );

export const startInstance = createStart(() => ({
  requestMiddleware: [runtimeMw, observabilityMw],
}));
