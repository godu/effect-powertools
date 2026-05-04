import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";

import {
  powertoolsTypescriptLayerArn,
  lambdaInsightsArmArn,
} from "../layers";
import { assumeLambda, attachManagedPolicies } from "./lambdas";

const POWERTOOLS_NAMESPACE = "cloudwatch-observability-demo";

export interface TriggerArgs {
  namePrefix: string;
  producerLambda: aws.lambda.Function;
  tags: Record<string, string>;
}

export interface TriggerResult {
  fn: aws.lambda.Function;
  functionUrl: aws.lambda.FunctionUrl;
  logGroup: aws.cloudwatch.LogGroup;
}

export function createTrigger(args: TriggerArgs): TriggerResult {
  const role = createTriggerRole({
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

  const buildOutputDir = path.join(
    __dirname,
    "..",
    "..",
    "lambdas",
    "trigger",
    ".output",
    "server",
  );

  const fn = new aws.lambda.Function(
    "trigger",
    {
      name: fnName,
      role: role.arn,
      runtime: aws.lambda.Runtime.NodeJS20dX,
      architectures: ["arm64"],
      handler: "index.handler",
      memorySize: 512,
      timeout: 15,
      code: new pulumi.asset.FileArchive(buildOutputDir),
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
      allowMethods: ["POST"],
      allowHeaders: ["content-type"],
      maxAge: 300,
    },
  });

  return { fn, functionUrl, logGroup };
}

interface TriggerRoleArgs {
  namePrefix: string;
  producerArn: pulumi.Output<string>;
  tags: Record<string, string>;
}

function createTriggerRole(args: TriggerRoleArgs): aws.iam.Role {
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
