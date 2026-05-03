import * as aws from "@pulumi/aws";

export interface QueueArgs {
  namePrefix: string;
  tags: Record<string, string>;
}

export interface QueuePair {
  main: aws.sqs.Queue;
  dlq: aws.sqs.Queue;
}

export interface QueueSet {
  ts: QueuePair;
  py: QueuePair;
}

export function createQueues(args: QueueArgs): QueueSet {
  return {
    ts: createPair("ts", args),
    py: createPair("py", args),
  };
}

function createPair(runtime: "ts" | "py", args: QueueArgs): QueuePair {
  const dlq = new aws.sqs.Queue(`${runtime}-dlq`, {
    name: `${args.namePrefix}-${runtime}-dlq`,
    messageRetentionSeconds: 1209600, // 14 days
    tags: args.tags,
  });

  const main = new aws.sqs.Queue(`${runtime}-main`, {
    name: `${args.namePrefix}-${runtime}-main`,
    visibilityTimeoutSeconds: 60, // ≥ 6× lambda timeout (10s)
    redrivePolicy: dlq.arn.apply((arn) =>
      JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 5 }),
    ),
    tags: args.tags,
  });

  return { main, dlq };
}
