import * as aws from "@pulumi/aws";

export interface AlarmArgs {
  namePrefix: string;
  tsLambda: aws.lambda.Function;
  pyLambda: aws.lambda.Function;
  tsDlq: aws.sqs.Queue;
  pyDlq: aws.sqs.Queue;
  tags: Record<string, string>;
}

export function createAlarms(args: AlarmArgs): aws.cloudwatch.MetricAlarm[] {
  const alarms: aws.cloudwatch.MetricAlarm[] = [];

  for (const [runtime, fn] of [
    ["ts", args.tsLambda],
    ["py", args.pyLambda],
  ] as const) {
    alarms.push(
      lambdaErrorsAlarm(args.namePrefix, runtime, fn, args.tags),
      lambdaDurationAlarm(args.namePrefix, runtime, fn, args.tags),
      lambdaThrottlesAlarm(args.namePrefix, runtime, fn, args.tags),
    );
  }

  for (const [runtime, dlq] of [
    ["ts", args.tsDlq],
    ["py", args.pyDlq],
  ] as const) {
    alarms.push(dlqDepthAlarm(args.namePrefix, runtime, dlq, args.tags));
  }

  return alarms;
}

function lambdaErrorsAlarm(
  prefix: string,
  runtime: string,
  fn: aws.lambda.Function,
  tags: Record<string, string>,
): aws.cloudwatch.MetricAlarm {
  return new aws.cloudwatch.MetricAlarm(`${runtime}-errors-alarm`, {
    name: `${prefix}-${runtime}-errors`,
    alarmDescription: `${runtime} lambda errors over 5 min`,
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
  runtime: string,
  fn: aws.lambda.Function,
  tags: Record<string, string>,
): aws.cloudwatch.MetricAlarm {
  return new aws.cloudwatch.MetricAlarm(`${runtime}-duration-alarm`, {
    name: `${prefix}-${runtime}-duration-p99`,
    alarmDescription: `${runtime} lambda P99 duration > 3000 ms over 5 min`,
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
  runtime: string,
  fn: aws.lambda.Function,
  tags: Record<string, string>,
): aws.cloudwatch.MetricAlarm {
  return new aws.cloudwatch.MetricAlarm(`${runtime}-throttles-alarm`, {
    name: `${prefix}-${runtime}-throttles`,
    alarmDescription: `${runtime} lambda throttles over 5 min`,
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
  runtime: string,
  dlq: aws.sqs.Queue,
  tags: Record<string, string>,
): aws.cloudwatch.MetricAlarm {
  return new aws.cloudwatch.MetricAlarm(`${runtime}-dlq-alarm`, {
    name: `${prefix}-${runtime}-dlq-depth`,
    alarmDescription: `${runtime} DLQ has messages (failed to process)`,
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
