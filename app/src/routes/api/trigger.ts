import { createFileRoute } from "@tanstack/react-router";
import * as Cause from "effect/Cause";

import { triggerProgram } from "../../server/trigger.server";

export const Route = createFileRoute("/api/trigger")({
  server: {
    handlers: {
      POST: async (ctx) => {
        const exit = await ctx.context.runtime.runPromiseExit(triggerProgram);
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
