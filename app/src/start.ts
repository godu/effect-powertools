import { createStart } from "@tanstack/react-start";

import {
  observabilityMiddleware,
  runtimeMiddleware,
} from "../../lambdas/shared/effect-powertools/tanstack-start";
import { observabilityLayer } from "./server/observability";

export const startInstance = createStart(() => ({
  requestMiddleware: [
    runtimeMiddleware(observabilityLayer),
    observabilityMiddleware({ serviceName: "/api/trigger" }),
  ],
}));
