import { createFileRoute } from "@tanstack/react-router";
import * as Cause from "effect/Cause";

import { triggerProgram } from "../../server/trigger";

export const Route = createFileRoute("/api/trigger")({
  server: {
    handlers: {
      POST: async (ctx) => {
        const { runtime } = ctx.context as unknown as {
          runtime: import("../../server/observability").Runtime;
        };
        const exit = await runtime.runPromiseExit(triggerProgram);
        if (exit._tag === "Failure") {
          return new Response(
            JSON.stringify({
              error: "trigger_failed",
              cause: Cause.pretty(exit.cause),
            }),
            {
              status: 502,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify(exit.value), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
