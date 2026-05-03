import * as awsNative from "@pulumi/aws-native";
import * as pulumi from "@pulumi/pulumi";

export interface SloArgs {
  namePrefix: string;
  // The values that Application Signals records as the service Name + Environment.
  // For Lambda, ADOT reports `Name = <function name>` and `Environment = <stack>`.
  serviceNameTs: pulumi.Input<string>;
  serviceNamePy: pulumi.Input<string>;
  environment: string;
  tags: Record<string, string>;
}

// Application Signals must be enabled per region (one-time, idempotent).
export function enableApplicationSignals(): awsNative.applicationsignals.Discovery {
  return new awsNative.applicationsignals.Discovery("appsignals-discovery", {});
}

export function createSlos(
  args: SloArgs,
  parent?: pulumi.Resource,
): awsNative.applicationsignals.ServiceLevelObjective[] {
  const opts: pulumi.ResourceOptions | undefined = parent ? { dependsOn: [parent] } : undefined;
  const tagList = Object.entries(args.tags).map(([key, value]) => ({ key, value }));
  const slos: awsNative.applicationsignals.ServiceLevelObjective[] = [];

  for (const [runtime, serviceName] of [
    ["ts", args.serviceNameTs],
    ["py", args.serviceNamePy],
  ] as const) {
    const keyAttrs = lambdaKeyAttributes(serviceName, args.environment);
    slos.push(
      latencySlo(
        `${runtime}-latency-slo`,
        `${args.namePrefix}-${runtime}-latency-p95`,
        runtime,
        keyAttrs,
        tagList,
        opts,
      ),
      availabilitySlo(
        `${runtime}-availability-slo`,
        `${args.namePrefix}-${runtime}-availability`,
        runtime,
        keyAttrs,
        tagList,
        opts,
      ),
    );
  }

  return slos;
}

type KeyAttrs = { [key: string]: pulumi.Input<string> };

const lambdaKeyAttributes = (
  serviceName: pulumi.Input<string>,
  environment: string,
): KeyAttrs => ({
  Type: "Service",
  Name: serviceName,
  Environment: environment,
});

function latencySlo(
  pulumiName: string,
  awsName: string,
  runtime: string,
  keyAttrs: KeyAttrs,
  tagList: { key: string; value: string }[],
  opts: pulumi.ResourceOptions | undefined,
): awsNative.applicationsignals.ServiceLevelObjective {
  return new awsNative.applicationsignals.ServiceLevelObjective(
    pulumiName,
    {
      name: awsName,
      description: `Latency P95 < 1000 ms for ${runtime} lambda`,
      sli: {
        comparisonOperator:
          awsNative.types.enums.applicationsignals.ServiceLevelObjectiveSliComparisonOperator
            .LessThan,
        metricThreshold: 1000,
        sliMetric: {
          metricType:
            awsNative.types.enums.applicationsignals.ServiceLevelObjectiveSliMetricMetricType
              .Latency,
          statistic: "p95",
          keyAttributes: keyAttrs,
          periodSeconds: 60,
        },
      },
      goal: {
        attainmentGoal: 99,
        warningThreshold: 50,
        interval: {
          rollingInterval: {
            duration: 7,
            durationUnit:
              awsNative.types.enums.applicationsignals.ServiceLevelObjectiveDurationUnit.Day,
          },
        },
      },
      tags: tagList,
    },
    opts,
  );
}

function availabilitySlo(
  pulumiName: string,
  awsName: string,
  runtime: string,
  keyAttrs: KeyAttrs,
  tagList: { key: string; value: string }[],
  opts: pulumi.ResourceOptions | undefined,
): awsNative.applicationsignals.ServiceLevelObjective {
  return new awsNative.applicationsignals.ServiceLevelObjective(
    pulumiName,
    {
      name: awsName,
      description: `Availability > 99 % for ${runtime} lambda`,
      sli: {
        comparisonOperator:
          awsNative.types.enums.applicationsignals.ServiceLevelObjectiveSliComparisonOperator
            .GreaterThanOrEqualTo,
        metricThreshold: 99,
        sliMetric: {
          metricType:
            awsNative.types.enums.applicationsignals.ServiceLevelObjectiveSliMetricMetricType
              .Availability,
          keyAttributes: keyAttrs,
          periodSeconds: 60,
        },
      },
      goal: {
        attainmentGoal: 99,
        warningThreshold: 50,
        interval: {
          rollingInterval: {
            duration: 7,
            durationUnit:
              awsNative.types.enums.applicationsignals.ServiceLevelObjectiveDurationUnit.Day,
          },
        },
      },
      tags: tagList,
    },
    opts,
  );
}
