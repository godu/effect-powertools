import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";

import {
  powertoolsTypescriptLayerArn,
  lambdaInsightsArmArn,
} from "../layers";
import { assumeLambda, attachManagedPolicies } from "./lambdas";

const POWERTOOLS_NAMESPACE = "cloudwatch-observability-demo";

const APP_OUTPUT_DIR = path.join(__dirname, "..", "..", "app", ".output");
const APP_SERVER_DIR = path.join(APP_OUTPUT_DIR, "server");
const APP_PUBLIC_DIR = path.join(APP_OUTPUT_DIR, "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function walk(dir: string, base = dir): { abs: string; rel: string }[] {
  const out: { abs: string; rel: string }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(abs, base));
    } else {
      out.push({ abs, rel: path.relative(base, abs) });
    }
  }
  return out;
}

export interface AppArgs {
  namePrefix: string;
  producerLambda: aws.lambda.Function;
  tags: Record<string, string>;
}

export interface AppResult {
  fn: aws.lambda.Function;
  functionUrl: aws.lambda.FunctionUrl;
  logGroup: aws.cloudwatch.LogGroup;
  distribution: aws.cloudfront.Distribution;
}

// Nitro v3 (aws_lambda preset) builds the TanStack Start app to:
//   .output/server/index.mjs   — Lambda handler (SSR + /api/*)
//   .output/public/            — static client assets
// We deploy the server dir as the Lambda code and the public dir to a
// private S3 bucket fronted by CloudFront. CloudFront routes /assets/* to
// S3 and everything else to the Lambda Function URL.
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
      runtime: aws.lambda.Runtime.NodeJS20dX,
      architectures: ["arm64"],
      handler: "index.handler",
      memorySize: 512,
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

  // Static-assets bucket
  const bucket = new aws.s3.Bucket("frontend", {
    bucketPrefix: `${args.namePrefix.slice(0, 30)}-web-`.toLowerCase(),
    forceDestroy: true,
    tags: args.tags,
  });

  new aws.s3.BucketPublicAccessBlock("frontend-pab", {
    bucket: bucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  new aws.s3.BucketOwnershipControls("frontend-ownership", {
    bucket: bucket.id,
    rule: { objectOwnership: "BucketOwnerEnforced" },
  });

  const oac = new aws.cloudfront.OriginAccessControl("frontend-oac", {
    name: `${args.namePrefix}-frontend-oac`,
    description: "OAC for frontend S3 origin",
    originAccessControlOriginType: "s3",
    signingBehavior: "always",
    signingProtocol: "sigv4",
  });

  const triggerHost = functionUrl.functionUrl.apply(
    (url) => new URL(url).hostname,
  );

  const S3_ORIGIN_ID = "frontend-s3";
  const LAMBDA_ORIGIN_ID = "app-lambda";

  const distribution = new aws.cloudfront.Distribution("frontend-cdn", {
    enabled: true,
    isIpv6Enabled: true,
    httpVersion: "http2",
    priceClass: "PriceClass_100",
    comment: `${args.namePrefix} app`,
    origins: [
      {
        originId: S3_ORIGIN_ID,
        domainName: bucket.bucketRegionalDomainName,
        originAccessControlId: oac.id,
        s3OriginConfig: { originAccessIdentity: "" },
      },
      {
        originId: LAMBDA_ORIGIN_ID,
        domainName: triggerHost,
        customOriginConfig: {
          httpPort: 80,
          httpsPort: 443,
          originProtocolPolicy: "https-only",
          originSslProtocols: ["TLSv1.2"],
        },
      },
    ],
    defaultCacheBehavior: {
      // SSR HTML + /api/* — handled by Lambda
      targetOriginId: LAMBDA_ORIGIN_ID,
      viewerProtocolPolicy: "redirect-to-https",
      allowedMethods: [
        "GET",
        "HEAD",
        "OPTIONS",
        "POST",
        "PUT",
        "DELETE",
        "PATCH",
      ],
      cachedMethods: ["GET", "HEAD"],
      compress: true,
      // Managed-CachingDisabled — Lambda decides cacheability via headers
      cachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
      // Managed-AllViewerExceptHostHeader (Lambda Function URL signs by its own host)
      originRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
    },
    orderedCacheBehaviors: [
      {
        // Static client chunks, immutable, served from S3
        pathPattern: "/assets/*",
        targetOriginId: S3_ORIGIN_ID,
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD"],
        cachedMethods: ["GET", "HEAD"],
        compress: true,
        // Managed-CachingOptimized
        cachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
      },
    ],
    restrictions: { geoRestriction: { restrictionType: "none" } },
    viewerCertificate: { cloudfrontDefaultCertificate: true },
    tags: args.tags,
  });

  new aws.s3.BucketPolicy("frontend-policy", {
    bucket: bucket.id,
    policy: pulumi
      .all([bucket.arn, distribution.arn])
      .apply(([bucketArn, distArn]) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "AllowCloudFrontServicePrincipal",
              Effect: "Allow",
              Principal: { Service: "cloudfront.amazonaws.com" },
              Action: "s3:GetObject",
              Resource: `${bucketArn}/*`,
              Condition: { StringEquals: { "AWS:SourceArn": distArn } },
            },
          ],
        }),
      ),
  });

  if (fs.existsSync(APP_PUBLIC_DIR)) {
    for (const file of walk(APP_PUBLIC_DIR)) {
      const ext = path.extname(file.rel).toLowerCase();
      new aws.s3.BucketObject(`frontend-asset-${file.rel}`, {
        bucket: bucket.id,
        key: file.rel,
        source: new pulumi.asset.FileAsset(file.abs),
        contentType: CONTENT_TYPES[ext] ?? "application/octet-stream",
        cacheControl: "public, max-age=31536000, immutable",
      });
    }
  }

  return { fn, functionUrl, logGroup, distribution };
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
