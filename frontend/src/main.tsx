import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { triggerOrder, type TriggerResponse } from "./api";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; order: TriggerResponse }
  | { kind: "error"; message: string };

function Home() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const handleClick = () => {
    setStatus({ kind: "loading" });
    Effect.runPromiseExit(triggerOrder).then((exit) => {
      if (exit._tag === "Success") {
        setStatus({ kind: "success", order: exit.value });
      } else {
        setStatus({ kind: "error", message: String(exit.cause) });
      }
    });
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={status.kind === "loading"}
        style={{
          padding: "0.75rem 1.5rem",
          fontSize: "1rem",
          background: status.kind === "loading" ? "#ccc" : "#0066ff",
          color: "white",
          border: "none",
          borderRadius: "0.375rem",
          cursor: status.kind === "loading" ? "not-allowed" : "pointer",
        }}
      >
        {status.kind === "loading" ? "Triggering…" : "Trigger order"}
      </button>

      <div style={{ marginTop: "2rem" }}>
        {status.kind === "success" && (
          <div
            style={{
              padding: "1rem",
              background: "#e6f7e6",
              border: "1px solid #4caf50",
              borderRadius: "0.375rem",
            }}
          >
            <strong>Order created</strong>
            <pre style={{ margin: "0.5rem 0 0", fontSize: "0.875rem" }}>
              {JSON.stringify(status.order, null, 2)}
            </pre>
          </div>
        )}
        {status.kind === "error" && (
          <div
            style={{
              padding: "1rem",
              background: "#fde8e8",
              border: "1px solid #d32f2f",
              borderRadius: "0.375rem",
              color: "#b00020",
            }}
          >
            <strong>Trigger failed</strong>
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.875rem" }}>
              {status.message}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: () => (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 640,
        margin: "4rem auto",
        padding: "0 1rem",
      }}
    >
      <header style={{ marginBottom: "2rem" }}>
        <h1 style={{ margin: 0 }}>Order Trigger</h1>
        <p style={{ color: "#666", marginTop: "0.25rem" }}>
          Click the button to invoke the producer Lambda.
        </p>
      </header>
      <Outlet />
    </div>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Home,
});

const routeTree = rootRoute.addChildren([indexRoute]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element not found");

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
