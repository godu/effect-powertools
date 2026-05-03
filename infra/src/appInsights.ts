import * as aws from "@pulumi/aws";

export interface AppInsightsArgs {
  namePrefix: string;
  projectTag: string;
  stackTag: string;
  tags: Record<string, string>;
}

export function createAppInsights(args: AppInsightsArgs): {
  group: aws.resourcegroups.Group;
  application: aws.applicationinsights.Application;
} {
  const groupName = `${args.namePrefix}-rg`;

  const group = new aws.resourcegroups.Group("rg", {
    name: groupName,
    description: "Tag-based group covering all stack resources for Application Insights.",
    resourceQuery: {
      type: "TAG_FILTERS_1_0",
      query: JSON.stringify({
        ResourceTypeFilters: ["AWS::AllSupported"],
        TagFilters: [
          { Key: "Project", Values: [args.projectTag] },
          { Key: "Stack", Values: [args.stackTag] },
        ],
      }),
    },
    tags: args.tags,
  });

  // Application Insights' auto-config uses a fixed-name role at
  // /service-role/ServiceRoleForCloudWatchCrossAccountV2 to read CloudWatch
  // and dependent service data. The AWS console creates it on first use; via
  // API we must provision it explicitly or AppInsights raises an
  // "Unauthorized to perform sts:AssumeRole" detected problem.
  const crossAccountRole = new aws.iam.Role("appinsights-cross-account-role", {
    name: "ServiceRoleForCloudWatchCrossAccountV2",
    path: "/service-role/",
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: {
            Service: [
              "application-insights.amazonaws.com",
              "events.amazonaws.com",
            ],
          },
          Action: "sts:AssumeRole",
        },
      ],
    }),
    tags: args.tags,
  });

  new aws.iam.RolePolicyAttachment("appinsights-cross-account-attach", {
    role: crossAccountRole.name,
    policyArn: "arn:aws:iam::aws:policy/CloudWatchApplicationInsightsFullAccess",
  });

  const application = new aws.applicationinsights.Application(
    "app",
    {
      resourceGroupName: group.name,
      autoConfigEnabled: true,
      cweMonitorEnabled: true,
      opsCenterEnabled: false,
      tags: args.tags,
    },
    { dependsOn: [crossAccountRole] },
  );

  return { group, application };
}
