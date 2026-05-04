/// <reference types="vite/client" />
import type { ReactNode } from "react";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Order Trigger" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
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
          {children}
        </div>
        <Scripts />
      </body>
    </html>
  );
}
