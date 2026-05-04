import * as pulumi from "@pulumi/pulumi";

import { createDataBucket } from "./src/bucket";
import { createQueue } from "./src/queues";
import { createLambdas } from "./src/lambdas";
import { createApp } from "./src/app";
import { createStaticBucket } from "./src/static";
import { enableApplicationSignals, createSlos } from "./src/appSignals";
import { createAppInsights } from "./src/appInsights";
import { createAlarms } from "./src/alarms";
import { createDashboard } from "./src/dashboard";
import { REGION } from "./layers";

const project = pulumi.getProject();
const stack = pulumi.getStack();
const namePrefix = `${project}-${stack}`; // e.g. cloudwatch-observability-demo-dev

const tags = {
  Project: project,
  Stack: stack,
  ManagedBy: "pulumi",
};

// Data plane: single SQS queue + DLQ, single S3 bucket
const dataBucket = createDataBucket({ namePrefix, tags });
const queue = createQueue({ namePrefix, tags });

const { producer, consumer } = createLambdas({
  namePrefix,
  queue: queue.main,
  dataBucket,
  tags,
});

// Single TanStack Start Lambda (SSR + /api/trigger) fronted by CloudFront.
// Static client assets sit on S3 and are served via CloudFront /assets/*.
const app = createApp({ namePrefix, producerLambda: producer, tags });
const staticAssets = createStaticBucket({
  namePrefix,
  appFunctionUrl: app.functionUrl,
  tags,
});

// Observability plane
const discovery = enableApplicationSignals();
createSlos(
  {
    namePrefix,
    producerName: producer.name,
    consumerName: consumer.name,
    triggerName: app.fn.name,
    tags,
  },
  discovery,
);
createAppInsights({
  namePrefix,
  projectTag: project,
  stackTag: stack,
  tags,
});
createAlarms({
  namePrefix,
  producer,
  consumer,
  trigger: app.fn,
  dlq: queue.dlq,
  tags,
});
const dashboard = createDashboard({
  namePrefix,
  region: REGION,
  producer,
  consumer,
  trigger: app.fn,
  mainQueue: queue.main,
  dlq: queue.dlq,
  dataBucket,
});

// Stack outputs
export const dataBucketName = dataBucket.bucket;
export const queueUrl = queue.main.url;
export const dlqUrl = queue.dlq.url;
export const producerName = producer.name;
export const consumerName = consumer.name;
export const triggerName = app.fn.name;
export const triggerFunctionUrl = app.functionUrl.functionUrl;
export const frontendUrl = pulumi.interpolate`https://${staticAssets.distribution.domainName}`;
export const dashboardUrl = pulumi.interpolate`https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#dashboards:name=${dashboard.dashboardName}`;
export const traceMapUrl = `https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#xray:service-map/map`;
