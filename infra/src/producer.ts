import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface ProducerArgs {
  namePrefix: string;
  tsQueue: aws.sqs.Queue;
  pyQueue: aws.sqs.Queue;
  tags: Record<string, string>;
}

export function createProducer(args: ProducerArgs): aws.cloudwatch.EventRule {
  const role = new aws.iam.Role("producer-role", {
    name: `${args.namePrefix}-producer-role`,
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "events.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    }),
    tags: args.tags,
  });

  new aws.iam.RolePolicy("producer-send", {
    role: role.id,
    policy: pulumi
      .all([args.tsQueue.arn, args.pyQueue.arn])
      .apply(([tsArn, pyArn]) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["sqs:SendMessage"],
              Resource: [tsArn, pyArn],
            },
          ],
        }),
      ),
  });

  const rule = new aws.cloudwatch.EventRule("producer", {
    name: `${args.namePrefix}-producer`,
    description: "Fires every minute to drive demo load through both lambdas.",
    scheduleExpression: "rate(1 minute)",
    tags: args.tags,
  });

  new aws.cloudwatch.EventTarget("producer-ts", {
    rule: rule.name,
    arn: args.tsQueue.arn,
    roleArn: role.arn,
    input: JSON.stringify({ source: "eventbridge", target: "ts" }),
  });

  new aws.cloudwatch.EventTarget("producer-py", {
    rule: rule.name,
    arn: args.pyQueue.arn,
    roleArn: role.arn,
    input: JSON.stringify({ source: "eventbridge", target: "py" }),
  });

  return rule;
}
