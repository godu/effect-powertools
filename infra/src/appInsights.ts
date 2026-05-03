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

  const application = new aws.applicationinsights.Application("app", {
    resourceGroupName: group.name,
    autoConfigEnabled: true,
    cweMonitorEnabled: true,
    opsCenterEnabled: false,
    tags: args.tags,
  });

  return { group, application };
}
