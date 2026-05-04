import { build } from "esbuild";

await build({
  entryPoints: ["src/handler.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/handler.mjs",
  sourcemap: false,
  minify: true,
  external: [
    "@aws-lambda-powertools/*",
    "@aws-sdk/*",
    "aws-xray-sdk-core",
  ],
  logLevel: "info",
});
