import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";
import {
  powertoolsPythonLayerArn,
  powertoolsTypescriptLayerArn,
  lambdaInsightsArmArn,
} from "../layers";

const POWERTOOLS_NAMESPACE = "cloudwatch-observability-demo";

export interface PipelineLambdaArgs {
  namePrefix: string;
  queue: aws.sqs.Queue;
  dataBucket: aws.s3.Bucket;
  tags: Record<string, string>;
}

export interface PipelineLambdas {
  producer: aws.lambda.Function;
  consumer: aws.lambda.Function;
  producerLogGroup: aws.cloudwatch.LogGroup;
  consumerLogGroup: aws.cloudwatch.LogGroup;
}

export function createLambdas(args: PipelineLambdaArgs): PipelineLambdas {
  const producer = createProducerLambda(args);
  const consumer = createConsumerLambda(args);
  return {
    producer: producer.fn,
    consumer: consumer.fn,
    producerLogGroup: producer.logGroup,
    consumerLogGroup: consumer.logGroup,
  };
}

interface FnResult {
  fn: aws.lambda.Function;
  logGroup: aws.cloudwatch.LogGroup;
}

function createProducerLambda(args: PipelineLambdaArgs): FnResult {
  const role = createProducerRole({
    namePrefix: args.namePrefix,
    queueArn: args.queue.arn,
    tags: args.tags,
  });

  const fnName = `${args.namePrefix}-producer`;
  const logGroup = new aws.cloudwatch.LogGroup("producer-log", {
    name: `/aws/lambda/${fnName}`,
    retentionInDays: 7,
    tags: args.tags,
  });

  const handlerPath = path.join(
    __dirname,
    "..",
    "..",
    "lambdas",
    "python",
    "src",
    "handler.py",
  );

  const fn = new aws.lambda.Function(
    "producer",
    {
      name: fnName,
      role: role.arn,
      runtime: aws.lambda.Runtime.Python3d12,
      architectures: ["arm64"],
      handler: "handler.handler",
      memorySize: 256,
      timeout: 10,
      code: new pulumi.asset.AssetArchive({
        "handler.py": new pulumi.asset.FileAsset(handlerPath),
      }),
      layers: [powertoolsPythonLayerArn, lambdaInsightsArmArn],
      tracingConfig: { mode: "Active" },
      environment: {
        variables: {
          QUEUE_URL: args.queue.url,
          POWERTOOLS_SERVICE_NAME: fnName,
          POWERTOOLS_METRICS_NAMESPACE: POWERTOOLS_NAMESPACE,
          POWERTOOLS_LOG_LEVEL: "INFO",
          POWERTOOLS_LOGGER_LOG_EVENT: "false",
        },
      },
      tags: args.tags,
    },
    { dependsOn: [logGroup] },
  );

  return { fn, logGroup };
}

function createConsumerLambda(args: PipelineLambdaArgs): FnResult {
  const role = createConsumerRole({
    namePrefix: args.namePrefix,
    queueArn: args.queue.arn,
    bucketArn: args.dataBucket.arn,
    bucketPrefix: "orders/",
    tags: args.tags,
  });

  const fnName = `${args.namePrefix}-consumer`;
  const logGroup = new aws.cloudwatch.LogGroup("consumer-log", {
    name: `/aws/lambda/${fnName}`,
    retentionInDays: 7,
    tags: args.tags,
  });

  const handlerPath = path.join(
    __dirname,
    "..",
    "..",
    "lambdas",
    "typescript",
    "dist",
    "handler.js",
  );

  const fn = new aws.lambda.Function(
    "consumer",
    {
      name: fnName,
      role: role.arn,
      runtime: aws.lambda.Runtime.NodeJS20dX,
      architectures: ["arm64"],
      handler: "handler.handler",
      memorySize: 256,
      timeout: 10,
      code: new pulumi.asset.AssetArchive({
        "handler.js": new pulumi.asset.FileAsset(handlerPath),
      }),
      layers: [powertoolsTypescriptLayerArn, lambdaInsightsArmArn],
      tracingConfig: { mode: "Active" },
      environment: {
        variables: {
          DATA_BUCKET: args.dataBucket.bucket,
          POWERTOOLS_SERVICE_NAME: fnName,
          POWERTOOLS_METRICS_NAMESPACE: POWERTOOLS_NAMESPACE,
          POWERTOOLS_LOG_LEVEL: "INFO",
          POWERTOOLS_LOGGER_LOG_EVENT: "false",
        },
      },
      tags: args.tags,
    },
    { dependsOn: [logGroup] },
  );

  new aws.lambda.EventSourceMapping("consumer-esm", {
    eventSourceArn: args.queue.arn,
    functionName: fn.arn,
    batchSize: 10,
    maximumBatchingWindowInSeconds: 5,
    functionResponseTypes: ["ReportBatchItemFailures"],
  });

  return { fn, logGroup };
}

interface ProducerRoleArgs {
  namePrefix: string;
  queueArn: pulumi.Output<string>;
  tags: Record<string, string>;
}

function createProducerRole(args: ProducerRoleArgs): aws.iam.Role {
  const role = new aws.iam.Role("producer-role", {
    name: `${args.namePrefix}-producer-role`,
    assumeRolePolicy: assumeLambda,
    tags: args.tags,
  });

  attachManagedPolicies(role, "producer");

  new aws.iam.RolePolicy("producer-inline", {
    role: role.id,
    policy: args.queueArn.apply((queueArn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["sqs:SendMessage"],
            Resource: queueArn,
          },
        ],
      }),
    ),
  });

  return role;
}

interface ConsumerRoleArgs {
  namePrefix: string;
  queueArn: pulumi.Output<string>;
  bucketArn: pulumi.Output<string>;
  bucketPrefix: string;
  tags: Record<string, string>;
}

function createConsumerRole(args: ConsumerRoleArgs): aws.iam.Role {
  const role = new aws.iam.Role("consumer-role", {
    name: `${args.namePrefix}-consumer-role`,
    assumeRolePolicy: assumeLambda,
    tags: args.tags,
  });

  attachManagedPolicies(role, "consumer");

  new aws.iam.RolePolicy("consumer-inline", {
    role: role.id,
    policy: pulumi
      .all([args.queueArn, args.bucketArn])
      .apply(([queueArn, bucketArn]) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: [
                "sqs:ReceiveMessage",
                "sqs:DeleteMessage",
                "sqs:GetQueueAttributes",
                "sqs:ChangeMessageVisibility",
              ],
              Resource: queueArn,
            },
            {
              Effect: "Allow",
              Action: ["s3:PutObject"],
              Resource: `${bucketArn}/${args.bucketPrefix}*`,
            },
          ],
        }),
      ),
  });

  return role;
}

export const assumeLambda = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

export function attachManagedPolicies(role: aws.iam.Role, prefix: string): void {
  for (const [name, arn] of [
    ["basic", "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
    ["xray", "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"],
    [
      "insights",
      "arn:aws:iam::aws:policy/CloudWatchLambdaInsightsExecutionRolePolicy",
    ],
  ] as const) {
    new aws.iam.RolePolicyAttachment(`${prefix}-${name}`, {
      role: role.name,
      policyArn: arn,
    });
  }
}
