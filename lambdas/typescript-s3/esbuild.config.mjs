import { build } from "esbuild";

await build({
  entryPoints: ["src/handler.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/handler.js",
  sourcemap: false,
  minify: false,
  external: [
    "@aws-lambda-powertools/*",
    "@aws-sdk/*",
    "aws-xray-sdk-core",
  ],
  logLevel: "info",
});
