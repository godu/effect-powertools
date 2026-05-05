import * as aws from "@pulumi/aws";

export interface AlarmArgs {
  namePrefix: string;
  producer: aws.lambda.Function;
  consumer: aws.lambda.Function;
  trigger: aws.lambda.Function;
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

  alarms.push(dlqDepthAlarm(args.namePrefix, args.dlq, args.tags));

  return alarms;
}

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
    tags,
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
    tags,
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
    tags,
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
    tags,
  });
}
