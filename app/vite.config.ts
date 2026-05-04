import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";

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
});
