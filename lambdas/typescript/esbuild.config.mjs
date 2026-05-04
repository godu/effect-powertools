import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  nodePaths: [path.join(__dirname, "node_modules")],
  logLevel: "info",
});
