# cloudwatch-observability-demo

End-to-end CloudWatch observability demo: two Lambdas (TS + Python) consume per-runtime SQS queues and write each message body to S3. An EventBridge rule fires every minute as the producer. Wires up Application Signals, SLOs, X-Ray Trace Map, Lambda Insights, Application Insights, a curated dashboard, and ~10 alarms.

Deployed to **eu-west-3** with the **AWS_PROFILE=staging** profile and a Pulumi local-file backend.

## Layout

```
infra/                  # Pulumi/TypeScript program
lambdas/typescript/     # TS Lambda source
lambdas/python/         # Python Lambda source
```

## Deploy

```sh
# one-time setup
cd infra && pulumi login file://./pulumi-state
npm install && pulumi stack init dev
pulumi config set aws-native:region eu-west-3

# build the TS lambda + apply
cd ../lambdas/typescript && npm install && npm run build
cd ../../infra && AWS_PROFILE=staging pulumi up

# wait ~3 minutes for Application Signals to discover both lambda services
# (the EventBridge producer drives traffic every minute), then enable SLOs:
pulumi config set enableSlos true
AWS_PROFILE=staging pulumi up
```

The two-phase deploy is required because Application Signals SLOs reference a service that AppSignals must already have observed; on a fresh stack the lambdas haven't reported yet, so SLO creation would fail with "Unable to find service data".

## Drive load

The EventBridge producer fires every minute automatically. To send a custom message:

```sh
AWS_PROFILE=staging aws sqs send-message --region eu-west-3 \
  --queue-url "$(pulumi stack output tsQueueUrl)" \
  --message-body 'hello from typescript'
```

## Verify

After ~5 min in the AWS console (eu-west-3):

- **Application Signals → Services**: `cloudwatch-observability-demo-ts` and `cloudwatch-observability-demo-py`.
- **Application Signals → SLOs**: 4 SLOs healthy.
- **CloudWatch → X-Ray → Trace Map**: SQS → Lambda → S3 for both runtimes.
- **CloudWatch → Application Insights**: stack monitored, status green.
- **CloudWatch → Lambda Insights**: enhanced metrics for both functions.
- **CloudWatch → Dashboards**: `cloudwatch-observability-demo-dev`.
- **CloudWatch → Alarms**: ~10, all OK.

## Tear down

```sh
cd infra && AWS_PROFILE=staging pulumi destroy
```
