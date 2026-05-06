import * as aws from "@pulumi/aws";

const POWERTOOLS_NAMESPACE = "cloudwatch-observability-demo";

export interface AlarmArgs {
  namePrefix: string;
  // Pulumi stack name; used as the `environment` dimension on Powertools
  // metrics. Matches what the bridge sets in acquireObservability.
  stack: string;
  producer: aws.lambda.Function;
  consumer: aws.lambda.Function;
  trigger: aws.lambda.Function;
  mainQueue: aws.sqs.Queue;
  dlq: aws.sqs.Queue;
  tags: Record<string, string>;
}

export function createAlarms(args: AlarmArgs): aws.cloudwatch.MetricAlarm[] {
  const alarms: aws.cloudwatch.MetricAlarm[] = [];

  for (const [role, fn] of [
    ["producer", args.producer],
    ["consumer", args.consumer],
    ["trigger", args.trigger],
  ] as const) {
    alarms.push(
      lambdaErrorsAlarm(args.namePrefix, role, fn, args.tags),
      lambdaDurationAlarm(args.namePrefix, role, fn, args.tags),
      lambdaThrottlesAlarm(args.namePrefix, role, fn, args.tags),
    );
  }

  alarms.push(
    dlqDepthAlarm(args.namePrefix, args.dlq, args.tags),
    recordFailuresNonPoisonAlarm(
      args.namePrefix,
      args.stack,
      args.consumer,
      args.tags,
    ),
    e2eLatencyAlarm(args.namePrefix, args.stack, args.trigger, args.tags),
    queueAgeAlarm(args.namePrefix, args.mainQueue, args.tags),
    queueDepthAlarm(args.namePrefix, args.mainQueue, args.tags),
  );

  return alarms;
}

// -----------------------------------------------------------------------------
// Lambda-level alarms (existing)
// -----------------------------------------------------------------------------

function lambdaErrorsAlarm(
  prefix: string,
  role: string,
  fn: aws.lambda.Function,
  tags: Record<string, string>,
): aws.cloudwatch.MetricAlarm {
  return new aws.cloudwatch.MetricAlarm(`${role}-errors-alarm`, {
    name: `${prefix}-${role}-errors`,
    alarmDescription: `${role} lambda errors over 5 min`,
    namespace: "AWS/Lambda",
    metricName: "Errors",
    statistic: "Sum",
    period: 300,
    evaluationPeriods: 1,
    threshold: 1,
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    treatMissingData: "notBreaching",
    dimensions: { FunctionName: fn.name },
    tags: { ...tags, severity: "p1" },
  });
}

function lambdaDurationAlarm(
  prefix: string,
  role: string,
  fn: aws.lambda.Function,
  tags: Record<string, string>,
): aws.cloudwatch.MetricAlarm {
  return new aws.cloudwatch.MetricAlarm(`${role}-duration-alarm`, {
    name: `${prefix}-${role}-duration-p99`,
    alarmDescription: `${role} lambda P99 duration > 3000 ms over 5 min`,
    namespace: "AWS/Lambda",
    metricName: "Duration",
    extendedStatistic: "p99",
    period: 300,
    evaluationPeriods: 1,
    threshold: 3000,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
    dimensions: { FunctionName: fn.name },
    tags: { ...tags, severity: "p2" },
  });
}

function lambdaThrottlesAlarm(
  prefix: string,
  role: string,
  fn: aws.lambda.Function,
  tags: Record<string, string>,
): aws.cloudwatch.MetricAlarm {
  return new aws.cloudwatch.MetricAlarm(`${role}-throttles-alarm`, {
    name: `${prefix}-${role}-throttles`,
    alarmDescription: `${role} lambda throttles over 5 min`,
    namespace: "AWS/Lambda",
    metricName: "Throttles",
    statistic: "Sum",
    period: 300,
    evaluationPeriods: 1,
    threshold: 1,
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    treatMissingData: "notBreaching",
    dimensions: { FunctionName: fn.name },
    tags: { ...tags, severity: "p2" },
  });
}

function dlqDepthAlarm(
  prefix: string,
  dlq: aws.sqs.Queue,
  tags: Record<string, string>,
): aws.cloudwatch.MetricAlarm {
  return new aws.cloudwatch.MetricAlarm("dlq-alarm", {
    name: `${prefix}-dlq-depth`,
    alarmDescription: "DLQ has messages (consumer failed to process)",
    namespace: "AWS/SQS",
    metricName: "ApproximateNumberOfMessagesVisible",
    statistic: "Maximum",
    period: 60,
    evaluationPeriods: 1,
    threshold: 1,
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    treatMissingData: "notBreaching",
    dimensions: { QueueName: dlq.name },
    tags: { ...tags, severity: "p1" },
  });
}

// -----------------------------------------------------------------------------
// New alarms — pipeline-level
// -----------------------------------------------------------------------------

// Non-poison RecordFailures: BatchRecordFailures (auto-emitted by the bridge,
// one per failed SQS record) minus RecordFailures{reason=PoisonOrderError}
// (emitted by the consumer's onRecordFailure hook for explicitly-classified
// poison records). The remainder is the count of failures whose reason is
// *not* PoisonOrderError — bridge bug, downstream S3 outage, IAM issue, etc.
//
// Using BatchRecordFailures avoids enumerating every possible non-poison
// reason; a new error variant added to the consumer is alarmed automatically
// without infra change.
//
// Note: CloudWatch metric alarms don't support SEARCH() expressions
// ("SEARCH is not supported on Metric Alarms"); each metricQueries entry
// must be a direct metric reference.
function recordFailuresNonPoisonAlarm(
  prefix: string,
  stack: string,
  consumer: aws.lambda.Function,
  tags: Record<string, string>,
): aws.cloudwatch.MetricAlarm {
  return new aws.cloudwatch.MetricAlarm("record-failures-non-poison", {
    name: `${prefix}-record-failures-non-poison`,
    alarmDescription:
      "Consumer non-poison record failures over 5 min — bridge or downstream issue",
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    evaluationPeriods: 1,
    threshold: 1,
    treatMissingData: "notBreaching",
    metricQueries: [
      {
        id: "total",
        metric: {
          namespace: POWERTOOLS_NAMESPACE,
          metricName: "BatchRecordFailures",
          dimensions: { service: consumer.name, environment: stack },
          period: 300,
          stat: "Sum",
        },
        returnData: false,
      },
      {
        id: "poison",
        metric: {
          namespace: POWERTOOLS_NAMESPACE,
          metricName: "RecordFailures",
          dimensions: {
            service: consumer.name,
            reason: "PoisonOrderError",
          },
          period: 300,
          stat: "Sum",
        },
        returnData: false,
      },
      {
        id: "nonPoison",
        expression: "total - poison",
        label: "Non-poison failures",
        returnData: true,
      },
    ],
    tags: { ...tags, severity: "p1" },
  });
}

// End-to-end perceived latency at the trigger handler. TriggerProcessDuration
// is the wall-clock from Meter.instrument("TriggerProcess", ...) — it bounds
// trigger handler + lambda.invoke + SQS hand-off; if this breaches, every
// section of the pipeline upstream of SQS is under SLO threshold.
function e2eLatencyAlarm(
  prefix: string,
  stack: string,
  trigger: aws.lambda.Function,
  tags: Record<string, string>,
): aws.cloudwatch.MetricAlarm {
  return new aws.cloudwatch.MetricAlarm("e2e-latency-alarm", {
    name: `${prefix}-e2e-latency-p95`,
    alarmDescription:
      "TriggerProcessDuration p95 > 5000 ms over 10 min — user-perceptible slowdown",
    namespace: POWERTOOLS_NAMESPACE,
    metricName: "TriggerProcessDuration",
    extendedStatistic: "p95",
    period: 300,
    evaluationPeriods: 2,
    datapointsToAlarm: 2,
    threshold: 5000,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
    dimensions: { service: trigger.name, environment: stack },
    tags: { ...tags, severity: "p2" },
  });
}

// Queue age — early warning that the consumer is falling behind. Threshold
// 60 s before any record's invisibility expires; tune higher for queues
// with deliberately delayed processing.
function queueAgeAlarm(
  prefix: string,
  mainQueue: aws.sqs.Queue,
  tags: Record<string, string>,
): aws.cloudwatch.MetricAlarm {
  return new aws.cloudwatch.MetricAlarm("queue-age-alarm", {
    name: `${prefix}-queue-age`,
    alarmDescription:
      "Main queue oldest-message age > 60 s for 5 consecutive minutes — consumer is behind",
    namespace: "AWS/SQS",
    metricName: "ApproximateAgeOfOldestMessage",
    statistic: "Maximum",
    period: 60,
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    threshold: 60,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
    dimensions: { QueueName: mainQueue.name },
    tags: { ...tags, severity: "p2" },
  });
}

// Queue depth — capacity / cold-start backlog warning. Average over 5 min so
// a transient spike (single batch unprocessed) doesn't fire.
function queueDepthAlarm(
  prefix: string,
  mainQueue: aws.sqs.Queue,
  tags: Record<string, string>,
): aws.cloudwatch.MetricAlarm {
  return new aws.cloudwatch.MetricAlarm("queue-depth-alarm", {
    name: `${prefix}-queue-depth`,
    alarmDescription:
      "Main queue average depth > 100 messages over 5 min — backlog forming",
    namespace: "AWS/SQS",
    metricName: "ApproximateNumberOfMessagesVisible",
    statistic: "Average",
    period: 300,
    evaluationPeriods: 1,
    threshold: 100,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
    dimensions: { QueueName: mainQueue.name },
    tags: { ...tags, severity: "p2" },
  });
}
