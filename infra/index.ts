import * as pulumi from "@pulumi/pulumi";

import { createDataBucket } from "./src/bucket";
import { createQueues } from "./src/queues";
import { createLambdas } from "./src/lambdas";
import { createProducer } from "./src/producer";
import { enableApplicationSignals, createSlos } from "./src/appSignals";
import { createAppInsights } from "./src/appInsights";
import { createAlarms } from "./src/alarms";
import { createDashboard } from "./src/dashboard";

const project = pulumi.getProject();
const stack = pulumi.getStack();
const namePrefix = `${project}-${stack}`; // e.g. cloudwatch-observability-demo-dev

const tags = {
  Project: project,
  Stack: stack,
  ManagedBy: "pulumi",
};

// Application Signals records the Lambda function name as the Service `Name`
// and the OTel deployment.environment as the Environment. We pass the deployment
// values through here so SLO key attributes match the discovered service.
const serviceNameTs = `${namePrefix}-ts`;
const serviceNamePy = `${namePrefix}-py`;

// Data plane
const dataBucket = createDataBucket({ namePrefix, tags });
const queues = createQueues({ namePrefix, tags });

const { ts: tsLambda, py: pyLambda } = createLambdas({
  namePrefix,
  dataBucket,
  tsQueue: queues.ts.main,
  pyQueue: queues.py.main,
  serviceNameTs,
  serviceNamePy,
  tags,
});

createProducer({
  namePrefix,
  tsQueue: queues.ts.main,
  pyQueue: queues.py.main,
  tags,
});

// Observability plane
const discovery = enableApplicationSignals();

// SLOs depend on Application Signals having already discovered each Lambda
// service. On a fresh stack the lambdas haven't reported yet, so SLO creation
// fails with "Unable to find service data". After the first `pulumi up`,
// let the EventBridge producer drive traffic for a few minutes, then set
// `cloudwatch-observability-demo:enableSlos = true` and re-run `pulumi up`.
const config = new pulumi.Config();
const enableSlos = config.getBoolean("enableSlos") ?? false;
if (enableSlos) {
  createSlos(
    {
      namePrefix,
      serviceNameTs: tsLambda.name,
      serviceNamePy: pyLambda.name,
      environment: stack,
      tags,
    },
    discovery,
  );
}
createAppInsights({
  namePrefix,
  projectTag: project,
  stackTag: stack,
  tags,
});
createAlarms({
  namePrefix,
  tsLambda,
  pyLambda,
  tsDlq: queues.ts.dlq,
  pyDlq: queues.py.dlq,
  tags,
});
const dashboard = createDashboard({
  namePrefix,
  region: "eu-west-3",
  tsLambda,
  pyLambda,
  tsMain: queues.ts.main,
  pyMain: queues.py.main,
  tsDlq: queues.ts.dlq,
  pyDlq: queues.py.dlq,
  dataBucket,
  serviceNameTs,
  serviceNamePy,
});

// Stack outputs
export const dataBucketName = dataBucket.bucket;
export const tsQueueUrl = queues.ts.main.url;
export const pyQueueUrl = queues.py.main.url;
export const tsDlqUrl = queues.ts.dlq.url;
export const pyDlqUrl = queues.py.dlq.url;
export const tsLambdaName = tsLambda.name;
export const pyLambdaName = pyLambda.name;
export const dashboardUrl = pulumi.interpolate`https://eu-west-3.console.aws.amazon.com/cloudwatch/home?region=eu-west-3#dashboards:name=${dashboard.dashboardName}`;
export const traceMapUrl = `https://eu-west-3.console.aws.amazon.com/cloudwatch/home?region=eu-west-3#xray:service-map/map`;
export const appSignalsUrl = `https://eu-west-3.console.aws.amazon.com/cloudwatch/home?region=eu-west-3#application-signals/services`;
