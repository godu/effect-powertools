# effect-powertools

An [Effect](https://effect.website/) ↔ [AWS Lambda Powertools](https://docs.powertools.aws.dev/lambda/typescript/latest/) bridge for TypeScript Lambdas.

- **Logger** — Effect's `Logger` flushes to Powertools Logger so structured logs land in CloudWatch with annotations + spans + cause traces.
- **Tracer** — Effect spans become X-Ray subsegments, with cls-hooked isolation so concurrent fibers (`Effect.forEach({ concurrency: "unbounded" })`) keep their AWS SDK leaf subsegments correctly nested.
- **Metrics** — Effect's `Metric` API emits Powertools EMF blobs to CloudWatch Metrics, units travel as tags.
- **Handler factories** — `createLambdaHandler` (generic) and `createSqsLambdaHandler` (SQS sugar) wrap the cold-start / `addContext` / parent-subsegment / metric-flush boilerplate around any Effect program. Inputs are validated via `effect/Schema` before your code runs.
- **Batch processor** — `processPartialResponse` and `processFifoPartialResponse` give you Effect-native SQS partial-batch failures with auto-emitted `BatchRecordSuccesses` / `BatchRecordFailures` counters.
- **TanStack Start integration** — `provideRuntimeServer` + `captureRequest` for full-stack Lambda apps.

## Install

This repo is a workspace; consume the library by name from any sibling `package.json`:

```jsonc
{
  "dependencies": {
    "effect-powertools": "*"
  }
}
```

Peer deps: `effect`, `@aws-lambda-powertools/{logger,metrics,tracer}`, `aws-xray-sdk-core` — and `@tanstack/react-start` if you use the `effect-powertools/tanstack-start` subpath.

## Quick start (SQS Lambda)

```ts
import { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import { Metrics as PowertoolsMetrics } from "@aws-lambda-powertools/metrics";
import { Tracer as PowertoolsTracer } from "@aws-lambda-powertools/tracer";
import { createSqsLambdaHandler, PowertoolsBridgeLayer } from "effect-powertools";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Order = Schema.Struct({
  orderId: Schema.String,
  amountCents: Schema.Number,
});
const OrderFromBody = Schema.parseJson(Order);

const ptLogger = new PowertoolsLogger();
const ptTracer = new PowertoolsTracer();
const ptMetrics = new PowertoolsMetrics();

export const handler = createSqsLambdaHandler(
  {
    layer: PowertoolsBridgeLayer({ logger: ptLogger, tracer: ptTracer, metrics: ptMetrics }),
    recordSchema: OrderFromBody,
    serviceName: "orders",
  },
  (order, record) =>
    Effect.logInfo("order_received").pipe(
      Effect.annotateLogs({ orderId: order.orderId, messageId: record.messageId }),
    ),
);
```

The handler returns `{ batchItemFailures: [...] }` per SQS partial-batch protocol. Schema decode failures land in `batchItemFailures` automatically.

## Documentation

- **[`./effect-powertools/README.md`](./effect-powertools/README.md)** — full library reference (every export, options, caveats).
- **[`./examples/README.md`](./examples/README.md)** — observability cookbook covering both Python (Powertools) and TypeScript (Effect) Lambda stacks side-by-side.
- **[`./examples/`](./examples/)** — runnable end-to-end demo: TanStack Start app → Python producer Lambda → SQS → TS/Effect consumer Lambda → S3, deployed via Pulumi.
