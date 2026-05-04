import { defineNitroConfig } from "nitropack/config";

export default defineNitroConfig({
  preset: "aws-lambda",
  srcDir: ".",
  compatibilityDate: "2025-01-01",
  noExternals: true,
  externals: {
    external: [
      "@aws-lambda-powertools/logger",
      "@aws-lambda-powertools/metrics",
      "@aws-lambda-powertools/tracer",
      "@aws-lambda-powertools/commons",
      "aws-xray-sdk-core",
    ],
  },
  rollupConfig: {
    external: [
      /^@aws-lambda-powertools\//,
      /^aws-xray-sdk-core/,
    ],
  },
});
