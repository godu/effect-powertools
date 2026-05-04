import * as pulumi from "@pulumi/pulumi";

import { createDataBucket } from "./src/bucket";
import { createQueue } from "./src/queues";
import { createLambdas } from "./src/lambdas";
import { createTrigger } from "./src/trigger";
import { createFrontend } from "./src/frontend";
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

// Trigger Lambda invokes the producer; replaces the EventBridge schedule
const trigger = createTrigger({ namePrefix, producerLambda: producer, tags });

// Frontend: S3 bucket + CloudFront distribution; CloudFront proxies /api/*
// to the trigger Lambda Function URL
const frontend = createFrontend({
  namePrefix,
  triggerFunctionUrl: trigger.functionUrl,
  tags,
});

// Observability plane
const discovery = enableApplicationSignals();
createSlos(
  {
    namePrefix,
    producerName: producer.name,
    consumerName: consumer.name,
    triggerName: trigger.fn.name,
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
  trigger: trigger.fn,
  dlq: queue.dlq,
  tags,
});
const dashboard = createDashboard({
  namePrefix,
  region: REGION,
  producer,
  consumer,
  trigger: trigger.fn,
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
export const triggerName = trigger.fn.name;
export const triggerFunctionUrl = trigger.functionUrl.functionUrl;
export const frontendBucket = frontend.bucket.bucket;
export const frontendUrl = pulumi.interpolate`https://${frontend.distribution.domainName}`;
export const dashboardUrl = pulumi.interpolate`https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#dashboards:name=${dashboard.dashboardName}`;
export const traceMapUrl = `https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#xray:service-map/map`;
