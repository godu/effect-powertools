// Pinned AWS-managed Lambda layer ARNs for eu-west-3.
// Latest versions discovered via `aws lambda get-layer-version-by-arn` probing
// against the publishing AWS accounts.

export const REGION = "eu-west-3";

// Application Signals ADOT distros (publisher account: 615299751070).
// Both layers list arm64 + x86_64 as compatible architectures.
export const adotJsLayerArn =
  "arn:aws:lambda:eu-west-3:615299751070:layer:AWSOpenTelemetryDistroJs:14";

export const adotPythonLayerArn =
  "arn:aws:lambda:eu-west-3:615299751070:layer:AWSOpenTelemetryDistroPython:5";

// CloudWatch Lambda Insights extension (publisher account: 580247275435).
export const lambdaInsightsArmArn =
  "arn:aws:lambda:eu-west-3:580247275435:layer:LambdaInsightsExtension-Arm64:29";

export const lambdaInsightsX86Arn =
  "arn:aws:lambda:eu-west-3:580247275435:layer:LambdaInsightsExtension:63";
