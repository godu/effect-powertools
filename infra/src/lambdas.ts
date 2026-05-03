import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";
import {
  adotJsLayerArn,
  adotPythonLayerArn,
  lambdaInsightsArmArn,
  lambdaInsightsX86Arn,
} from "../layers";

export interface LambdaArgs {
  namePrefix: string;
  dataBucket: aws.s3.Bucket;
  tsQueue: aws.sqs.Queue;
  pyQueue: aws.sqs.Queue;
  serviceNameTs: string;
  serviceNamePy: string;
  tags: Record<string, string>;
}

export interface LambdaResult {
  ts: aws.lambda.Function;
  py: aws.lambda.Function;
  tsLogGroup: aws.cloudwatch.LogGroup;
  pyLogGroup: aws.cloudwatch.LogGroup;
}

export function createLambdas(args: LambdaArgs): LambdaResult {
  const ts = createTsLambda(args);
  const py = createPyLambda(args);
  return ts.merge(py);
}

interface PartialResult {
  fn: aws.lambda.Function;
  logGroup: aws.cloudwatch.LogGroup;
  merge: (other: PartialResult) => LambdaResult;
}

function createTsLambda(args: LambdaArgs): PartialResult {
  const role = createRole({
    runtime: "ts",
    namePrefix: args.namePrefix,
    queueArn: args.tsQueue.arn,
    bucketArn: args.dataBucket.arn,
    bucketPrefix: "messages/typescript/",
    tags: args.tags,
  });

  const fnName = `${args.namePrefix}-ts`;
  const logGroup = new aws.cloudwatch.LogGroup("ts-log", {
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
    "ts",
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
      layers: [adotJsLayerArn, lambdaInsightsArmArn],
      tracingConfig: { mode: "Active" },
      environment: {
        variables: {
          AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-instrument",
          OTEL_AWS_APPLICATION_SIGNALS_ENABLED: "true",
          OTEL_RESOURCE_ATTRIBUTES: pulumi.interpolate`service.name=${args.serviceNameTs},deployment.environment=${pulumi.getStack()}`,
          DATA_BUCKET: args.dataBucket.bucket,
        },
      },
      tags: args.tags,
    },
    { dependsOn: [logGroup] },
  );

  new aws.lambda.EventSourceMapping("ts-esm", {
    eventSourceArn: args.tsQueue.arn,
    functionName: fn.arn,
    batchSize: 10,
    maximumBatchingWindowInSeconds: 5,
    functionResponseTypes: ["ReportBatchItemFailures"],
  });

  return wrap(fn, logGroup, "ts");
}

function createPyLambda(args: LambdaArgs): PartialResult {
  const role = createRole({
    runtime: "py",
    namePrefix: args.namePrefix,
    queueArn: args.pyQueue.arn,
    bucketArn: args.dataBucket.arn,
    bucketPrefix: "messages/python/",
    tags: args.tags,
  });

  const fnName = `${args.namePrefix}-py`;
  const logGroup = new aws.cloudwatch.LogGroup("py-log", {
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
    "py",
    {
      name: fnName,
      role: role.arn,
      runtime: aws.lambda.Runtime.Python3d12,
      architectures: ["x86_64"],
      handler: "handler.handler",
      memorySize: 256,
      timeout: 10,
      code: new pulumi.asset.AssetArchive({
        "handler.py": new pulumi.asset.FileAsset(handlerPath),
      }),
      layers: [adotPythonLayerArn, lambdaInsightsX86Arn],
      tracingConfig: { mode: "Active" },
      environment: {
        variables: {
          AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-instrument",
          OTEL_AWS_APPLICATION_SIGNALS_ENABLED: "true",
          OTEL_RESOURCE_ATTRIBUTES: pulumi.interpolate`service.name=${args.serviceNamePy},deployment.environment=${pulumi.getStack()}`,
          DATA_BUCKET: args.dataBucket.bucket,
        },
      },
      tags: args.tags,
    },
    { dependsOn: [logGroup] },
  );

  new aws.lambda.EventSourceMapping("py-esm", {
    eventSourceArn: args.pyQueue.arn,
    functionName: fn.arn,
    batchSize: 10,
    maximumBatchingWindowInSeconds: 5,
    functionResponseTypes: ["ReportBatchItemFailures"],
  });

  return wrap(fn, logGroup, "py");
}

interface RoleArgs {
  runtime: "ts" | "py";
  namePrefix: string;
  queueArn: pulumi.Output<string>;
  bucketArn: pulumi.Output<string>;
  bucketPrefix: string;
  tags: Record<string, string>;
}

function createRole(args: RoleArgs): aws.iam.Role {
  const role = new aws.iam.Role(`${args.runtime}-role`, {
    name: `${args.namePrefix}-${args.runtime}-role`,
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    }),
    tags: args.tags,
  });

  for (const [name, arn] of [
    ["basic", "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
    ["xray", "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"],
    [
      "insights",
      "arn:aws:iam::aws:policy/CloudWatchLambdaInsightsExecutionRolePolicy",
    ],
    [
      "appsignals",
      "arn:aws:iam::aws:policy/CloudWatchApplicationSignalsFullAccess",
    ],
  ] as const) {
    new aws.iam.RolePolicyAttachment(`${args.runtime}-${name}`, {
      role: role.name,
      policyArn: arn,
    });
  }

  new aws.iam.RolePolicy(`${args.runtime}-inline`, {
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

function wrap(
  fn: aws.lambda.Function,
  logGroup: aws.cloudwatch.LogGroup,
  runtime: "ts" | "py",
): PartialResult {
  return {
    fn,
    logGroup,
    merge(other) {
      if (runtime === "ts") {
        return {
          ts: fn,
          py: other.fn,
          tsLogGroup: logGroup,
          pyLogGroup: other.logGroup,
        };
      }
      return {
        ts: other.fn,
        py: fn,
        tsLogGroup: other.logGroup,
        pyLogGroup: logGroup,
      };
    },
  };
}
