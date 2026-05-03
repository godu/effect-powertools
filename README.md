# cloudwatch-observability-demo

End-to-end CloudWatch observability demo: a single linear pipeline
**EventBridge ▶ Lambda (Python producer, Powertools) ▶ SQS ▶ Lambda
(TypeScript consumer, Powertools) ▶ S3**. Both Lambdas use AWS Lambda
Powertools (no OpenTelemetry) and emit structured logs, custom CloudWatch
metrics (EMF), and X-Ray subsegments. Wires up Application Signals + 4
metric-based SLOs, X-Ray Trace Map, Lambda Insights, Application Insights,
a curated dashboard, and 7 alarms.

Deployed to **eu-west-3** with the **AWS_PROFILE=staging** profile and a
Pulumi local-file backend.

## Layout

```
infra/                  # Pulumi/TypeScript program
lambdas/typescript/     # TS Lambda source (consumer)
lambdas/python/         # Python Lambda source (producer)
```

## Deploy

```sh
# one-time setup
cd infra && pulumi login file://./pulumi-state
npm install && pulumi stack init dev
pulumi config set aws-native:region eu-west-3

# pin Powertools layer ARNs in infra/layers.ts (replace the PIN_ME tokens):
AWS_PROFILE=staging aws lambda list-layer-versions --region eu-west-3 \
  --layer-name AWSLambdaPowertoolsPythonV3-python312-x86_64 --max-items 1
AWS_PROFILE=staging aws lambda list-layer-versions --region eu-west-3 \
  --layer-name AWSLambdaPowertoolsTypeScriptV2 --max-items 1

# build + apply (single phase — no pre-warm dance required)
cd ../lambdas/typescript && npm install && npm run build
cd ../../infra && AWS_PROFILE=staging pulumi up
```

The producer Lambda runs every minute via an EventBridge schedule, so traffic
flows automatically. Custom messages can be injected directly into the SQS
queue:

```sh
AWS_PROFILE=staging aws sqs send-message --region eu-west-3 \
  --queue-url "$(pulumi stack output queueUrl)" \
  --message-body '{"orderId":"manual","customerId":"x","amountCents":42,"createdAt":"2026-05-04T00:00:00Z"}'
```

## Verify

After ~3 min in the AWS console (eu-west-3):

- **CloudWatch → Log groups** `/aws/lambda/cloudwatch-observability-demo-dev-producer`
  and `…-consumer`: structured Powertools JSON with `service`,
  `correlation_id`, `cold_start`, `function_arn`. Per-invocation log levels:
  - Producer: `info "order_emitted"`, `debug "order_serialized"`,
    `warn "high_amount"` when `amountCents ≥ 100000`.
  - Consumer: `info "order_received"` + `info "order_written"` per record;
    `error "poison_rejected"` on poison messages.
- **CloudWatch → Metrics → cloudwatch-observability-demo** (custom namespace,
  `service` dimension):
  - Producer: `OrdersEmitted`, `PayloadBytes`, `EmitLatencyMs`, `ColdStart`.
  - Consumer: `OrdersWritten`, `OrderAmountCents`, `WriteLatencyMs`,
    `RecordsRejected` (after a poison test), `ColdStart`.
- **CloudWatch → X-Ray → Traces**: a single trace spans
  `EventBridge → producer (with _build_order and _send_order subsegments
  + orderId annotation) → SQS → consumer (with writeOne subsegment + S3
  PutObject AWS subsegment) → S3`. X-Ray context propagates through SQS via
  the `AWSTraceHeader` system attribute (free with active tracing on).
- **CloudWatch → X-Ray → Trace Map**: producer → SQS → consumer → S3 edges.
- **CloudWatch → Application Signals → SLOs**: 4 metric-based SLOs render
  with attainment data (~5 min). App Signals service map is **intentionally
  empty** for these Lambdas — Powertools-only deployment, no ADOT layer; use
  the X-Ray Trace Map for the equivalent view.
- **CloudWatch → Application Insights**: stack monitored, status green.
- **CloudWatch → Lambda Insights**: enhanced metrics for both functions.
- **CloudWatch → Dashboards**: `cloudwatch-observability-demo-dev`.
- **CloudWatch → Alarms**: 7, all OK.

### Negative path (DLQ)

Send a poison message (negative amount triggers the consumer to raise):

```sh
AWS_PROFILE=staging aws sqs send-message --region eu-west-3 \
  --queue-url "$(pulumi stack output queueUrl)" \
  --message-body '{"orderId":"poison","customerId":"x","amountCents":-1,"createdAt":"2026-05-04T00:00:00Z"}'
```

After 5 retries (~3 min), the message lands in the DLQ and the
`…-dlq-depth` alarm fires.

## Tear down

```sh
cd infra && AWS_PROFILE=staging pulumi destroy
```
