import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";

export default defineConfig({
  server: { port: 3000 },
  build: {
    rollupOptions: {
      // Powertools and the AWS SDK are server-only; they should never end up
      // in the client bundle. Marking them external at the build level means
      // any chunk that still references them keeps the import bare. As long
      // as TanStack Start strips the actual call sites from the client (via
      // its `.server()` body removal), nothing will try to load these at
      // runtime in the browser.
      external: [
        /^@aws-lambda-powertools\//,
        /^@aws-sdk\//,
        /^@smithy\//,
        "aws-xray-sdk-core",
      ],
    },
  },
  plugins: [
    // `mock` mode replaces server-only modules with stubs in the client
    // build (see `import "@tanstack/react-start/server-only"`). Without
    // this, the client bundle pulls Powertools (Logger/Metrics/Tracer)
    // through the layer and errors on Node-only APIs like `randomInt`.
    tanstackStart({
      importProtection: {
        enabled: true,
        behavior: "mock",
        server: {
          specifiers: [
            /^@aws-lambda-powertools\//,
            /^@aws-sdk\//,
            "aws-xray-sdk-core",
          ],
        },
      },
    }),
    viteReact(),
    nitro({
      preset: "aws_lambda",
      // Powertools + X-Ray come from the Lambda layer; AWS SDK v3 is on the
      // Node.js 20 Lambda runtime. Mark them external so Nitro doesn't try
      // to bundle them.
      rollupConfig: {
        external: [
          "@aws-lambda-powertools/logger",
          "@aws-lambda-powertools/metrics",
          "@aws-lambda-powertools/tracer",
          "aws-xray-sdk-core",
          /^@aws-sdk\//,
          /^@smithy\//,
        ],
      },
    }),
  ],
});
