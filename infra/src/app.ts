import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";

import {
  powertoolsTypescriptLayerArn,
  lambdaInsightsArmArn,
} from "../layers";
import { assumeLambda, attachManagedPolicies } from "./lambdas";

const POWERTOOLS_NAMESPACE = "cloudwatch-observability-demo";

const APP_SERVER_DIR = path.join(
  __dirname,
  "..",
  "..",
  "app",
  ".output",
  "server",
);

export interface AppArgs {
  namePrefix: string;
  producerLambda: aws.lambda.Function;
  tags: Record<string, string>;
}

export interface AppResult {
  fn: aws.lambda.Function;
  functionUrl: aws.lambda.FunctionUrl;
  logGroup: aws.cloudwatch.LogGroup;
}

// Unified TanStack Start Lambda built by Nitro v3 (preset: aws_lambda).
// Serves SSR HTML + /api/trigger from .output/server/. Static assets in
// .output/public/ are uploaded to S3 by createStaticBucket() in static.ts.
export function createApp(args: AppArgs): AppResult {
  const role = createAppRole({
    namePrefix: args.namePrefix,
    producerArn: args.producerLambda.arn,
    tags: args.tags,
  });

  const fnName = `${args.namePrefix}-trigger`;
  const logGroup = new aws.cloudwatch.LogGroup("trigger-log", {
    name: `/aws/lambda/${fnName}`,
    retentionInDays: 7,
    tags: args.tags,
  });

  const fn = new aws.lambda.Function(
    "trigger",
    {
      name: fnName,
      role: role.arn,
      runtime: aws.lambda.Runtime.NodeJS24dX,
      architectures: ["arm64"],
      handler: "index.handler",
      memorySize: 1024,
      timeout: 15,
      code: new pulumi.asset.FileArchive(APP_SERVER_DIR),
      layers: [powertoolsTypescriptLayerArn, lambdaInsightsArmArn],
      tracingConfig: { mode: "Active" },
      environment: {
        variables: {
          PRODUCER_FUNCTION_NAME: args.producerLambda.name,
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

  const functionUrl = new aws.lambda.FunctionUrl("trigger-url", {
    functionName: fn.name,
    authorizationType: "NONE",
    cors: {
      allowOrigins: ["*"],
      allowMethods: ["*"],
      allowHeaders: ["*"],
      maxAge: 300,
    },
  });

  return { fn, functionUrl, logGroup };
}

interface AppRoleArgs {
  namePrefix: string;
  producerArn: pulumi.Output<string>;
  tags: Record<string, string>;
}

function createAppRole(args: AppRoleArgs): aws.iam.Role {
  const role = new aws.iam.Role("trigger-role", {
    name: `${args.namePrefix}-trigger-role`,
    assumeRolePolicy: assumeLambda,
    tags: args.tags,
  });

  attachManagedPolicies(role, "trigger");

  new aws.iam.RolePolicy("trigger-inline", {
    role: role.id,
    policy: args.producerArn.apply((arn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["lambda:InvokeFunction"],
            Resource: arn,
          },
        ],
      }),
    ),
  });

  return role;
}
