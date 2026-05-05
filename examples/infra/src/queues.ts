import * as aws from "@pulumi/aws";

export interface QueueArgs {
  namePrefix: string;
  tags: Record<string, string>;
}

export interface QueuePair {
  main: aws.sqs.Queue;
  dlq: aws.sqs.Queue;
}

export function createQueue(args: QueueArgs): QueuePair {
  const dlq = new aws.sqs.Queue("dlq", {
    name: `${args.namePrefix}-dlq`,
    messageRetentionSeconds: 1209600, // 14 days
    tags: args.tags,
  });

  const main = new aws.sqs.Queue("main", {
    name: `${args.namePrefix}-main`,
    visibilityTimeoutSeconds: 60, // ≥ 6× lambda timeout (10s)
    redrivePolicy: dlq.arn.apply((arn) =>
      JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 5 }),
    ),
    tags: args.tags,
  });

  return { main, dlq };
}
