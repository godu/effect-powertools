import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const POWERTOOLS_NAMESPACE = "cloudwatch-observability-demo";

export interface DashboardArgs {
  namePrefix: string;
  region: string;
  producer: aws.lambda.Function;
  consumer: aws.lambda.Function;
  observer: aws.lambda.Function;
  mainQueue: aws.sqs.Queue;
  dlq: aws.sqs.Queue;
  dataBucket: aws.s3.Bucket;
}

export function createDashboard(args: DashboardArgs): aws.cloudwatch.Dashboard {
  const dashboardBody = pulumi
    .all([
      args.producer.name,
      args.consumer.name,
      args.observer.name,
      args.mainQueue.name,
      args.dlq.name,
      args.dataBucket.bucket,
    ])
    .apply(
      ([
        producerName,
        consumerName,
        observerName,
        mainQueueName,
        dlqName,
        bucket,
      ]) =>
        JSON.stringify(
          buildDashboard({
            region: args.region,
            producerName,
            consumerName,
            observerName,
            mainQueueName,
            dlqName,
            bucket,
          }),
        ),
    );

  return new aws.cloudwatch.Dashboard("dash", {
    dashboardName: args.namePrefix,
    dashboardBody,
  });
}

interface DashboardInputs {
  region: string;
  producerName: string;
  consumerName: string;
  observerName: string;
  mainQueueName: string;
  dlqName: string;
  bucket: string;
}

function buildDashboard(d: DashboardInputs): unknown {
  return {
    widgets: [
      header(
        0,
        0,
        24,
        2,
        [
          `# ${d.producerName} → SQS → ${d.consumerName} — observability dashboard`,
          "",
          "EventBridge (1/min) ▶ **producer** ▶ SQS ▶ **consumer** ▶ S3.",
          "Powertools emits structured logs, custom metrics (EMF), and X-Ray subsegments from both lambdas.",
        ].join("\n"),
      ),

      header(0, 2, 24, 1, "## Lambda"),
      lambdaInvocations(
        0,
        3,
        8,
        6,
        d.region,
        d.producerName,
        d.consumerName,
        d.observerName,
      ),
      lambdaDuration(
        8,
        3,
        8,
        6,
        d.region,
        d.producerName,
        d.consumerName,
        d.observerName,
      ),
      lambdaErrors(
        16,
        3,
        8,
        6,
        d.region,
        d.producerName,
        d.consumerName,
        d.observerName,
      ),
      lambdaConcurrent(
        0,
        9,
        12,
        6,
        d.region,
        d.producerName,
        d.consumerName,
        d.observerName,
      ),
      lambdaInsightsInit(
        12,
        9,
        12,
        6,
        d.region,
        d.producerName,
        d.consumerName,
        d.observerName,
      ),

      header(0, 15, 24, 1, "## SQS"),
      sqsDepth(0, 16, 8, 6, d.region, d.mainQueueName),
      sqsAge(8, 16, 8, 6, d.region, d.mainQueueName),
      dlqDepth(16, 16, 8, 6, d.region, d.dlqName),

      header(0, 22, 24, 1, "## S3"),
      s3PutLatency(0, 23, 12, 6, d.region, d.bucket),
      s3Errors(12, 23, 12, 6, d.region, d.bucket),

      header(0, 29, 24, 1, "## Powertools custom metrics"),
      powertoolsCount(
        0,
        30,
        12,
        6,
        d.region,
        d.producerName,
        d.consumerName,
        d.observerName,
      ),
      powertoolsLatency(
        12,
        30,
        12,
        6,
        d.region,
        d.producerName,
        d.consumerName,
        d.observerName,
      ),
      powertoolsBytes(0, 36, 12, 6, d.region, d.producerName),
      powertoolsAmount(12, 36, 12, 6, d.region, d.consumerName, d.observerName),
      powertoolsColdStart(
        0,
        42,
        24,
        6,
        d.region,
        d.producerName,
        d.consumerName,
        d.observerName,
      ),

      header(0, 48, 24, 1, "## Trace map"),
      traceMapLink(0, 49, 24, 4, d.region),
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

function lambdaInvocations(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  producerName: string,
  consumerName: string,
  observerName: string,
) {
  return metricWidget(x, y, w, h, region, "Invocations", [
    ["AWS/Lambda", "Invocations", "FunctionName", producerName],
    [".", ".", ".", consumerName],
    [".", ".", ".", observerName],
  ]);
}

function lambdaDuration(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  producerName: string,
  consumerName: string,
  observerName: string,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    region,
    "Duration p95",
    [
      ["AWS/Lambda", "Duration", "FunctionName", producerName],
      [".", ".", ".", consumerName],
      [".", ".", ".", observerName],
    ],
    "p95",
  );
}

function lambdaErrors(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  producerName: string,
  consumerName: string,
  observerName: string,
) {
  return metricWidget(x, y, w, h, region, "Errors + Throttles", [
    ["AWS/Lambda", "Errors", "FunctionName", producerName],
    [".", ".", ".", consumerName],
    [".", ".", ".", observerName],
    ["AWS/Lambda", "Throttles", "FunctionName", producerName],
    [".", ".", ".", consumerName],
    [".", ".", ".", observerName],
  ]);
}

function lambdaConcurrent(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  producerName: string,
  consumerName: string,
  observerName: string,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    region,
    "Concurrent executions",
    [
      ["AWS/Lambda", "ConcurrentExecutions", "FunctionName", producerName],
      [".", ".", ".", consumerName],
      [".", ".", ".", observerName],
    ],
    "Maximum",
  );
}

function lambdaInsightsInit(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  producerName: string,
  consumerName: string,
  observerName: string,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    region,
    "Lambda Insights — init duration (ms)",
    [
      ["LambdaInsights", "init_duration", "function_name", producerName],
      [".", ".", ".", consumerName],
      [".", ".", ".", observerName],
    ],
    "Average",
  );
}

function sqsDepth(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  queueName: string,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    region,
    "Main queue depth",
    [["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", queueName]],
    "Average",
  );
}

function sqsAge(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  queueName: string,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    region,
    "Age of oldest message (s)",
    [["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", queueName]],
    "Maximum",
  );
}

function dlqDepth(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  dlqName: string,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    region,
    "DLQ depth",
    [["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", dlqName]],
    "Maximum",
  );
}

function s3PutLatency(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  bucket: string,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    region,
    "S3 first-byte latency (ms)",
    [
      [
        "AWS/S3",
        "FirstByteLatency",
        "BucketName",
        bucket,
        "FilterId",
        "EntireBucket",
      ],
    ],
    "Average",
    300,
  );
}

function s3Errors(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  bucket: string,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    region,
    "S3 4xx + 5xx errors",
    [
      ["AWS/S3", "4xxErrors", "BucketName", bucket, "FilterId", "EntireBucket"],
      [".", "5xxErrors", ".", ".", ".", "."],
    ],
    "Sum",
    300,
  );
}

function powertoolsCount(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  producerName: string,
  consumerName: string,
  observerName: string,
) {
  return metricWidget(x, y, w, h, region, "Orders processed (count)", [
    [POWERTOOLS_NAMESPACE, "OrdersEmitted", "service", producerName],
    [".", "OrdersWritten", "service", consumerName],
    [".", "RecordsRejected", "service", consumerName],
    [".", "OrdersObserved", "service", observerName],
  ]);
}

function powertoolsLatency(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  producerName: string,
  consumerName: string,
  observerName: string,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    region,
    "Powertools work latency (ms)",
    [
      [POWERTOOLS_NAMESPACE, "EmitLatencyMs", "service", producerName],
      [".", "WriteLatencyMs", "service", consumerName],
      [".", "ObserveLatencyMs", "service", observerName],
    ],
    "Average",
  );
}

function powertoolsBytes(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  producerName: string,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    region,
    "Producer payload size (bytes)",
    [[POWERTOOLS_NAMESPACE, "PayloadBytes", "service", producerName]],
    "Average",
  );
}

function powertoolsAmount(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  consumerName: string,
  observerName: string,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    region,
    "Order amount (cents)",
    [
      [POWERTOOLS_NAMESPACE, "OrderAmountCents", "service", consumerName],
      [".", ".", ".", observerName],
    ],
    "Sum",
  );
}

function powertoolsColdStart(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  producerName: string,
  consumerName: string,
  observerName: string,
) {
  return metricWidget(x, y, w, h, region, "Powertools ColdStart", [
    [POWERTOOLS_NAMESPACE, "ColdStart", "service", producerName],
    [".", ".", ".", consumerName],
    [".", ".", ".", observerName],
  ]);
}

function traceMapLink(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
) {
  const md = [
    "### X-Ray Trace Map",
    "",
    "**Use the X-Ray Trace Map for end-to-end pipeline visualization.** A single trace spans EventBridge → producer → SQS → consumer → S3 (X-Ray context propagates automatically through SQS message attributes when active tracing is on).",
    "",
    `- **[X-Ray Trace Map](https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#xray:service-map/map)** — pipeline view`,
    `- [X-Ray Traces](https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#xray:traces)`,
    `- [Application Signals SLOs](https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#application-signals/slos)`,
    "",
    "_App Signals service map is empty for these Lambdas by design — the ADOT layer is not installed (Powertools-only). The X-Ray Trace Map is the equivalent view here._",
  ].join("\n");
  return header(x, y, w, h, md);
}
