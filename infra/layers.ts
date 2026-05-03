// Pinned AWS-managed Lambda layer ARNs for eu-west-3.
// Latest versions discovered via `aws lambda list-layer-versions` against the
// publishing AWS accounts.

export const REGION = "eu-west-3";

// AWS Lambda Powertools (publisher account: 017000801446 for Python,
// 094274105915 for TypeScript). Versions probed via get-layer-version-by-arn
// against the publishing accounts (cross-account list-layer-versions is denied).
export const powertoolsPythonLayerArn =
  "arn:aws:lambda:eu-west-3:017000801446:layer:AWSLambdaPowertoolsPythonV3-python312-arm64:32";

export const powertoolsTypescriptLayerArn =
  "arn:aws:lambda:eu-west-3:094274105915:layer:AWSLambdaPowertoolsTypeScriptV2:47";

// CloudWatch Lambda Insights extension (publisher account: 580247275435).
// Both Lambdas run on arm64.
export const lambdaInsightsArmArn =
  "arn:aws:lambda:eu-west-3:580247275435:layer:LambdaInsightsExtension-Arm64:29";
