import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface BucketArgs {
  namePrefix: string;
  tags: Record<string, string>;
}

export function createDataBucket(args: BucketArgs): aws.s3.Bucket {
  const bucket = new aws.s3.Bucket("data", {
    bucketPrefix: `${args.namePrefix.slice(0, 30)}-data-`.toLowerCase(),
    forceDestroy: true,
    tags: args.tags,
  });

  new aws.s3.BucketPublicAccessBlock("data-pab", {
    bucket: bucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  new aws.s3.BucketOwnershipControls("data-ownership", {
    bucket: bucket.id,
    rule: { objectOwnership: "BucketOwnerEnforced" },
  });

  return bucket;
}

export function bucketArn(bucket: aws.s3.Bucket): pulumi.Output<string> {
  return bucket.arn;
}
