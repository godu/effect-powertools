import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localNodeModules = path.join(__dirname, "node_modules");

export default defineConfig({
  server: { port: 3000 },
  plugins: [
    tanstackStart(),
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
  // The shared Effect↔Powertools bridge at ../lambdas/shared/effect-powertools
  // imports bare specifiers that don't resolve from outside `app/node_modules`.
  // Force resolution into this app's node_modules.
  resolve: {
    alias: {
      effect: path.join(localNodeModules, "effect"),
      "@aws-lambda-powertools/logger": path.join(
        localNodeModules,
        "@aws-lambda-powertools/logger",
      ),
      "@aws-lambda-powertools/metrics": path.join(
        localNodeModules,
        "@aws-lambda-powertools/metrics",
      ),
      "@aws-lambda-powertools/tracer": path.join(
        localNodeModules,
        "@aws-lambda-powertools/tracer",
      ),
      "aws-xray-sdk-core": path.join(localNodeModules, "aws-xray-sdk-core"),
    },
  },
  ssr: {
    noExternal: ["effect"],
    external: [
      "@aws-lambda-powertools/logger",
      "@aws-lambda-powertools/metrics",
      "@aws-lambda-powertools/tracer",
      "aws-xray-sdk-core",
      "@aws-sdk/client-lambda",
    ],
  },
});
