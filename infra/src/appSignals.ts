import * as awsNative from "@pulumi/aws-native";
import * as pulumi from "@pulumi/pulumi";

export interface SloArgs {
  namePrefix: string;
  producerName: pulumi.Input<string>;
  consumerName: pulumi.Input<string>;
  observerName: pulumi.Input<string>;
  tags: Record<string, string>;
}

// Application Signals must be enabled per region (one-time, idempotent).
export function enableApplicationSignals(): awsNative.applicationsignals.Discovery {
  return new awsNative.applicationsignals.Discovery("appsignals-discovery", {});
}

// Metric-based SLOs (period-based SLI on AWS/Lambda metrics). These don't
// depend on Application Signals service discovery, so they work without ADOT
// instrumentation.
export function createSlos(
  args: SloArgs,
  parent?: pulumi.Resource,
): awsNative.applicationsignals.ServiceLevelObjective[] {
  const opts: pulumi.ResourceOptions | undefined = parent
    ? { dependsOn: [parent] }
    : undefined;
  const tagList = Object.entries(args.tags).map(([key, value]) => ({
    key,
    value,
  }));
  const slos: awsNative.applicationsignals.ServiceLevelObjective[] = [];

  for (const [role, fnName] of [
    ["producer", args.producerName],
    ["consumer", args.consumerName],
    ["observer", args.observerName],
  ] as const) {
    slos.push(
      latencySlo(
        `${role}-latency-slo`,
        `${args.namePrefix}-${role}-latency-p95`,
        role,
        fnName,
        tagList,
        opts,
      ),
      availabilitySlo(
        `${role}-availability-slo`,
        `${args.namePrefix}-${role}-availability`,
        role,
        fnName,
        tagList,
        opts,
      ),
    );
  }

  return slos;
}

function latencySlo(
  pulumiName: string,
  awsName: string,
  role: string,
  fnName: pulumi.Input<string>,
  tagList: { key: string; value: string }[],
  opts: pulumi.ResourceOptions | undefined,
): awsNative.applicationsignals.ServiceLevelObjective {
  return new awsNative.applicationsignals.ServiceLevelObjective(
    pulumiName,
    {
      name: awsName,
      description: `Latency P95 < 1000 ms for ${role} lambda`,
      sli: {
        comparisonOperator:
          awsNative.types.enums.applicationsignals
            .ServiceLevelObjectiveSliComparisonOperator.LessThan,
        metricThreshold: 1000,
        sliMetric: {
          metricDataQueries: [
            {
              id: "m1",
              returnData: true,
              metricStat: {
                metric: {
                  namespace: "AWS/Lambda",
                  metricName: "Duration",
                  dimensions: [{ name: "FunctionName", value: fnName }],
                },
                period: 60,
                stat: "p95",
              },
            },
          ],
        },
      },
      goal: {
        attainmentGoal: 99,
        warningThreshold: 50,
        interval: {
          rollingInterval: {
            duration: 7,
            durationUnit:
              awsNative.types.enums.applicationsignals
                .ServiceLevelObjectiveDurationUnit.Day,
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
  role: string,
  fnName: pulumi.Input<string>,
  tagList: { key: string; value: string }[],
  opts: pulumi.ResourceOptions | undefined,
): awsNative.applicationsignals.ServiceLevelObjective {
  return new awsNative.applicationsignals.ServiceLevelObjective(
    pulumiName,
    {
      name: awsName,
      description: `Availability ≥ 99 % for ${role} lambda`,
      sli: {
        comparisonOperator:
          awsNative.types.enums.applicationsignals
            .ServiceLevelObjectiveSliComparisonOperator.GreaterThanOrEqualTo,
        metricThreshold: 99,
        sliMetric: {
          metricDataQueries: [
            {
              id: "invocations",
              returnData: false,
              metricStat: {
                metric: {
                  namespace: "AWS/Lambda",
                  metricName: "Invocations",
                  dimensions: [{ name: "FunctionName", value: fnName }],
                },
                period: 60,
                stat: "Sum",
              },
            },
            {
              id: "errors",
              returnData: false,
              metricStat: {
                metric: {
                  namespace: "AWS/Lambda",
                  metricName: "Errors",
                  dimensions: [{ name: "FunctionName", value: fnName }],
                },
                period: 60,
                stat: "Sum",
              },
            },
            {
              id: "availability",
              returnData: true,
              expression:
                "100 * (1 - (FILL(errors, 0) / IF(invocations > 0, invocations, 1)))",
            },
          ],
        },
      },
      goal: {
        attainmentGoal: 99,
        warningThreshold: 50,
        interval: {
          rollingInterval: {
            duration: 7,
            durationUnit:
              awsNative.types.enums.applicationsignals
                .ServiceLevelObjectiveDurationUnit.Day,
          },
        },
      },
      tags: tagList,
    },
    opts,
  );
}
