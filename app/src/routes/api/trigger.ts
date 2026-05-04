import { createFileRoute } from "@tanstack/react-router";

import { handleTrigger } from "../../server/trigger";

export const Route = createFileRoute("/api/trigger")({
  server: {
    handlers: {
      POST: async () => {
        const outcome = await handleTrigger();
        return new Response(JSON.stringify(outcome.body), {
          status: outcome.status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
