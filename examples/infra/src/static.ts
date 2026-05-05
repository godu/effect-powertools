import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";

const APP_PUBLIC_DIR = path.join(
  __dirname,
  "..",
  "..",
  "trigger",
  ".output",
  "public",
);

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

export interface StaticArgs {
  namePrefix: string;
  appFunctionUrl: aws.lambda.FunctionUrl;
  tags: Record<string, string>;
}

export interface StaticResult {
  bucket: aws.s3.Bucket;
  distribution: aws.cloudfront.Distribution;
}

// Private S3 bucket for the TanStack Start client bundle (Nitro's
// .output/public/), fronted by a CloudFront distribution that routes
// /assets/* to S3 and everything else to the app Lambda's Function URL.
export function createStaticBucket(args: StaticArgs): StaticResult {
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

  const appHost = args.appFunctionUrl.functionUrl.apply(
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
        domainName: appHost,
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

  return { bucket, distribution };
}
