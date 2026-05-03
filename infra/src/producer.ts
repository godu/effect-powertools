import * as aws from "@pulumi/aws";

export interface ScheduleArgs {
  namePrefix: string;
  producerLambda: aws.lambda.Function;
  tags: Record<string, string>;
}

export function createSchedule(args: ScheduleArgs): aws.cloudwatch.EventRule {
  const rule = new aws.cloudwatch.EventRule("schedule", {
    name: `${args.namePrefix}-schedule`,
    description: "Fires every minute to drive the demo pipeline.",
    scheduleExpression: "rate(1 minute)",
    tags: args.tags,
  });

  new aws.lambda.Permission("schedule-invoke", {
    action: "lambda:InvokeFunction",
    function: args.producerLambda.name,
    principal: "events.amazonaws.com",
    sourceArn: rule.arn,
  });

  new aws.cloudwatch.EventTarget("schedule-target", {
    rule: rule.name,
    arn: args.producerLambda.arn,
    input: JSON.stringify({ source: "eventbridge" }),
  });

  return rule;
}
