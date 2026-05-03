import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface DashboardArgs {
  namePrefix: string;
  region: string;
  tsLambda: aws.lambda.Function;
  pyLambda: aws.lambda.Function;
  tsMain: aws.sqs.Queue;
  pyMain: aws.sqs.Queue;
  tsDlq: aws.sqs.Queue;
  pyDlq: aws.sqs.Queue;
  dataBucket: aws.s3.Bucket;
  serviceNameTs: string;
  serviceNamePy: string;
}

export function createDashboard(args: DashboardArgs): aws.cloudwatch.Dashboard {
  const dashboardBody = pulumi
    .all([
      args.tsLambda.name,
      args.pyLambda.name,
      args.tsMain.name,
      args.pyMain.name,
      args.tsDlq.name,
      args.pyDlq.name,
      args.dataBucket.bucket,
    ])
    .apply(([tsFn, pyFn, tsMain, pyMain, tsDlq, pyDlq, bucket]) =>
      JSON.stringify(buildDashboard({
        region: args.region,
        tsFn,
        pyFn,
        tsMain,
        pyMain,
        tsDlq,
        pyDlq,
        bucket,
        serviceNameTs: args.serviceNameTs,
        serviceNamePy: args.serviceNamePy,
      })),
    );

  return new aws.cloudwatch.Dashboard("dash", {
    dashboardName: `${args.namePrefix}`,
    dashboardBody,
  });
}

interface DashboardInputs {
  region: string;
  tsFn: string;
  pyFn: string;
  tsMain: string;
  pyMain: string;
  tsDlq: string;
  pyDlq: string;
  bucket: string;
  serviceNameTs: string;
  serviceNamePy: string;
}

function buildDashboard(d: DashboardInputs): unknown {
  return {
    widgets: [
      header(0, 0, 24, 1, `# ${d.serviceNameTs} & ${d.serviceNamePy} — observability dashboard`),

      header(0, 1, 24, 1, "## SQS"),
      sqsDepth(0, 2, 12, 6, d.region, d.tsMain, d.pyMain),
      sqsAge(12, 2, 12, 6, d.region, d.tsMain, d.pyMain),
      dlqDepth(0, 8, 12, 6, d.region, d.tsDlq, d.pyDlq),

      header(0, 14, 24, 1, "## Lambda"),
      lambdaInvocations(0, 15, 8, 6, d.region, d.tsFn, d.pyFn),
      lambdaDuration(8, 15, 8, 6, d.region, d.tsFn, d.pyFn),
      lambdaErrors(16, 15, 8, 6, d.region, d.tsFn, d.pyFn),
      lambdaConcurrent(0, 21, 12, 6, d.region, d.tsFn, d.pyFn),
      lambdaInsightsInit(12, 21, 12, 6, d.region, d.tsFn, d.pyFn),

      header(0, 27, 24, 1, "## S3"),
      s3PutLatency(0, 28, 12, 6, d.region, d.bucket),
      s3Errors(12, 28, 12, 6, d.region, d.bucket),

      header(0, 34, 24, 1, "## Application Signals"),
      appSignalsLink(0, 35, 24, 4, d.region, d.serviceNameTs, d.serviceNamePy),
    ],
  };
}

function header(x: number, y: number, w: number, h: number, markdown: string) {
  return {
    type: "text",
    x,
    y,
    width: w,
    height: h,
    properties: { markdown },
  };
}

function metricWidget(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  title: string,
  metrics: unknown[][],
  stat = "Sum",
  period = 60,
) {
  return {
    type: "metric",
    x,
    y,
    width: w,
    height: h,
    properties: {
      view: "timeSeries",
      stacked: false,
      region,
      title,
      stat,
      period,
      metrics,
    },
  };
}

function sqsDepth(x: number, y: number, w: number, h: number, region: string, tsMain: string, pyMain: string) {
  return metricWidget(x, y, w, h, region, "Main queue depth", [
    ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", tsMain],
    [".", ".", ".", pyMain],
  ], "Average");
}

function sqsAge(x: number, y: number, w: number, h: number, region: string, tsMain: string, pyMain: string) {
  return metricWidget(x, y, w, h, region, "Age of oldest message (s)", [
    ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", tsMain],
    [".", ".", ".", pyMain],
  ], "Maximum");
}

function dlqDepth(x: number, y: number, w: number, h: number, region: string, tsDlq: string, pyDlq: string) {
  return metricWidget(x, y, w, h, region, "DLQ depth", [
    ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", tsDlq],
    [".", ".", ".", pyDlq],
  ], "Maximum");
}

function lambdaInvocations(x: number, y: number, w: number, h: number, region: string, tsFn: string, pyFn: string) {
  return metricWidget(x, y, w, h, region, "Invocations", [
    ["AWS/Lambda", "Invocations", "FunctionName", tsFn],
    [".", ".", ".", pyFn],
  ]);
}

function lambdaDuration(x: number, y: number, w: number, h: number, region: string, tsFn: string, pyFn: string) {
  return metricWidget(x, y, w, h, region, "Duration p95", [
    ["AWS/Lambda", "Duration", "FunctionName", tsFn],
    [".", ".", ".", pyFn],
  ], "p95");
}

function lambdaErrors(x: number, y: number, w: number, h: number, region: string, tsFn: string, pyFn: string) {
  return metricWidget(x, y, w, h, region, "Errors + Throttles", [
    ["AWS/Lambda", "Errors", "FunctionName", tsFn],
    [".", ".", ".", pyFn],
    ["AWS/Lambda", "Throttles", "FunctionName", tsFn],
    [".", ".", ".", pyFn],
  ]);
}

function lambdaConcurrent(x: number, y: number, w: number, h: number, region: string, tsFn: string, pyFn: string) {
  return metricWidget(x, y, w, h, region, "Concurrent executions", [
    ["AWS/Lambda", "ConcurrentExecutions", "FunctionName", tsFn],
    [".", ".", ".", pyFn],
  ], "Maximum");
}

function lambdaInsightsInit(x: number, y: number, w: number, h: number, region: string, tsFn: string, pyFn: string) {
  return metricWidget(x, y, w, h, region, "Lambda Insights — init duration (ms)", [
    ["LambdaInsights", "init_duration", "function_name", tsFn],
    [".", ".", ".", pyFn],
  ], "Average");
}

function s3PutLatency(x: number, y: number, w: number, h: number, region: string, bucket: string) {
  return metricWidget(x, y, w, h, region, "S3 first-byte latency (ms)", [
    [
      "AWS/S3",
      "FirstByteLatency",
      "BucketName",
      bucket,
      "FilterId",
      "EntireBucket",
    ],
  ], "Average", 300);
}

function s3Errors(x: number, y: number, w: number, h: number, region: string, bucket: string) {
  return metricWidget(x, y, w, h, region, "S3 4xx + 5xx errors", [
    [
      "AWS/S3",
      "4xxErrors",
      "BucketName",
      bucket,
      "FilterId",
      "EntireBucket",
    ],
    [".", "5xxErrors", ".", ".", ".", "."],
  ], "Sum", 300);
}

function appSignalsLink(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  serviceTs: string,
  servicePy: string,
) {
  const md = [
    "### Service map",
    "",
    "**Use the Application Signals service map for the canonical one-node-per-service view.** The X-Ray Trace Map is the lower-level view: each Lambda invocation produces multiple X-Ray segment types (`AWS::Lambda`, `AWS::Lambda::Function`, plus ADOT's untyped service span), so a single Lambda renders as several adjacent nodes there — that's by design and the AWS docs explicitly direct you at AppSignals for the consolidated view.",
    "",
    `- **[Application Signals service map](https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#application-signals/services)** — one node per runtime`,
    `- [SLOs](https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#application-signals/slos)`,
    `- [\`${serviceTs}\` service detail](https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#application-signals/services/${encodeURIComponent(serviceTs)})`,
    `- [\`${servicePy}\` service detail](https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#application-signals/services/${encodeURIComponent(servicePy)})`,
    `- [X-Ray Trace Map (deep-dive)](https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#xray:service-map/map)`,
  ].join("\n");
  return header(x, y, w, h, md);
}
