import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const POWERTOOLS_NAMESPACE = "cloudwatch-observability-demo";

export interface DashboardArgs {
  namePrefix: string;
  // Pulumi stack name; used as the `environment` dimension on Powertools
  // metrics (see acquireObservability in effect-powertools/handlers.ts).
  stack: string;
  region: string;
  producer: aws.lambda.Function;
  consumer: aws.lambda.Function;
  trigger: aws.lambda.Function;
  mainQueue: aws.sqs.Queue;
  dlq: aws.sqs.Queue;
}

export function createDashboard(args: DashboardArgs): aws.cloudwatch.Dashboard {
  const dashboardBody = pulumi
    .all([
      args.producer.name,
      args.consumer.name,
      args.trigger.name,
      args.mainQueue.name,
      args.dlq.name,
    ])
    .apply(
      ([producerName, consumerName, triggerName, mainQueueName, dlqName]) =>
        JSON.stringify(
          buildDashboard({
            region: args.region,
            stack: args.stack,
            producerName,
            consumerName,
            triggerName,
            mainQueueName,
            dlqName,
          }),
        ),
    );

  return new aws.cloudwatch.Dashboard("dash", {
    dashboardName: args.namePrefix,
    dashboardBody,
  });
}

interface DashboardInputs {
  region: string;
  stack: string;
  producerName: string;
  consumerName: string;
  triggerName: string;
  mainQueueName: string;
  dlqName: string;
}

// =============================================================================
// Layout grid (width = 24 columns, conventional CloudWatch dashboard).
// Sections are stacked vertically; y/h tracked manually.
// =============================================================================

function buildDashboard(d: DashboardInputs): unknown {
  return {
    widgets: [
      header(
        0,
        0,
        24,
        2,
        [
          `# ${d.triggerName.replace(/-trigger$/, "")} — orders pipeline`,
          "",
          "Trigger ▶ Producer ▶ SQS ▶ Consumer ▶ S3. Stakeholder view: traffic, success, latency, failure attribution.",
        ].join("\n"),
      ),

      // ---------- Top KPI tiles --------------------------------------------
      kpiOrdersEmitted(0, 2, 6, 3, d),
      kpiOrdersWritten(6, 2, 6, 3, d),
      kpiFailureRate(12, 2, 6, 3, d),
      kpiDlqDepth(18, 2, 6, 3, d),

      // ---------- ## Orders -------------------------------------------------
      header(0, 5, 24, 1, "## Orders"),
      ordersEmittedTotal(0, 6, 12, 6, d),
      ordersEmittedByShape(12, 6, 12, 6, d),
      ordersWrittenTotal(0, 12, 12, 6, d),
      ordersWrittenByShape(12, 12, 12, 6, d),
      orderAmountCentsTotal(0, 18, 12, 6, d),
      orderAmountCentsByShape(12, 18, 12, 6, d),
      orderAmountHistogramPercentiles(0, 24, 24, 6, d),

      // ---------- ## Failures -----------------------------------------------
      header(0, 30, 24, 1, "## Failures"),
      recordFailuresByReason(0, 31, 8, 6, d),
      batchRecordFailuresTotal(8, 31, 8, 6, d),
      dlqDepthChart(16, 31, 8, 6, d),

      // ---------- ## Latency ------------------------------------------------
      header(0, 37, 24, 1, "## Latency"),
      e2ePipelineLatency(0, 38, 24, 8, d),
      payloadBytesPercentiles(0, 46, 12, 6, d),
      producerResponseBytesPercentiles(12, 46, 12, 6, d),

      // ---------- ## Traffic & faults (slim) --------------------------------
      header(0, 52, 24, 1, "## Traffic & faults"),
      lambdaInvocations(0, 53, 12, 6, d),
      lambdaErrors(12, 53, 12, 6, d),

      // ---------- ## Trace map (kept) ---------------------------------------
      header(0, 59, 24, 1, "## Trace map"),
      traceMapLink(0, 60, 24, 4, d.region),
    ],
  };
}

// =============================================================================
// Generic helpers
// =============================================================================

function header(x: number, y: number, w: number, h: number, markdown: string) {
  return {
    type: "text",
    x,
    y,
    width: w,
    height: h,
    properties: { markdown },
  };
}

interface MetricWidgetOptions {
  stat?: string;
  period?: number;
  stacked?: boolean;
  yAxis?: { left?: { min?: number }; right?: { min?: number } };
}

function metricWidget(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  title: string,
  metrics: unknown[],
  opts: MetricWidgetOptions = {},
) {
  return {
    type: "metric",
    x,
    y,
    width: w,
    height: h,
    properties: {
      view: "timeSeries",
      stacked: opts.stacked ?? false,
      region,
      title,
      stat: opts.stat ?? "Sum",
      period: opts.period ?? 60,
      metrics,
      ...(opts.yAxis ? { yAxis: opts.yAxis } : {}),
    },
  };
}

function singleValueWidget(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
  title: string,
  metrics: unknown[],
  opts: { period?: number; stat?: string; sparkline?: boolean } = {},
) {
  return {
    type: "metric",
    x,
    y,
    width: w,
    height: h,
    properties: {
      view: "singleValue",
      region,
      title,
      stat: opts.stat ?? "Sum",
      period: opts.period ?? 60,
      sparkline: opts.sparkline ?? true,
      metrics,
    },
  };
}

interface ExpressionEntry {
  expression: string;
  label: string;
  id: string;
  visible?: boolean;
}

// CloudWatch widget `metrics` is `Array<Array<MetricEntry>>` — each inner
// array is one metric line. Wrap a single expression entry into the
// expected `[[entry]]` shape.
function expressionMetric(entry: ExpressionEntry): unknown[][] {
  return [[entry]];
}

// CloudWatch SEARCH() over a 3-dim Powertools schema (env + orderShape +
// service). The `orderShape` keyword in the dimension list makes SEARCH return
// one series per distinct value; wrapping in SUM(...) collapses them into one.
function searchByShape(
  metricName: string,
  service: string,
  stat: string,
  period: number,
): string {
  return `SEARCH('{${POWERTOOLS_NAMESPACE},environment,orderShape,service} MetricName="${metricName}" service="${service}"', '${stat}', ${period})`;
}

function searchByShapeNoEnv(
  metricName: string,
  service: string,
  stat: string,
  period: number,
): string {
  // Effect-side `Metric.tagged(...)` emits via Powertools `singleMetric()`,
  // which does NOT inherit `addDimension`-added dimensions — so the schema
  // has only `service + orderShape`, no `environment`.
  return `SEARCH('{${POWERTOOLS_NAMESPACE},orderShape,service} MetricName="${metricName}" service="${service}"', '${stat}', ${period})`;
}

// =============================================================================
// Top KPI tiles (singleValue widgets)
// =============================================================================

function kpiOrdersEmitted(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  return singleValueWidget(
    x,
    y,
    w,
    h,
    d.region,
    "Orders/min (last)",
    expressionMetric({
      expression: `SUM(${searchByShape("OrdersEmitted", d.producerName, "Sum", 60)})`,
      label: "OrdersEmitted",
      id: "ord",
    }),
  );
}

function kpiOrdersWritten(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  return singleValueWidget(
    x,
    y,
    w,
    h,
    d.region,
    "Orders written/min (last)",
    expressionMetric({
      expression: `SUM(${searchByShapeNoEnv("OrdersWritten", d.consumerName, "Sum", 60)})`,
      label: "OrdersWritten",
      id: "wrt",
    }),
  );
}

function kpiFailureRate(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  // Failure rate = sum(RecordFailures) / sum(OrdersEmitted) over 5 min, as %.
  // RecordFailures is `Metric.tagged("reason")` on the consumer → schema is
  // {reason, service}. OrdersEmitted is `addDimension`-poisoned on producer
  // → schema {environment, orderShape, service}.
  const fail = `SUM(SEARCH('{${POWERTOOLS_NAMESPACE},reason,service} MetricName="RecordFailures" service="${d.consumerName}"', 'Sum', 300))`;
  const emit = `SUM(${searchByShape("OrdersEmitted", d.producerName, "Sum", 300)})`;
  return singleValueWidget(
    x,
    y,
    w,
    h,
    d.region,
    "Failure rate % (5 min)",
    [
      [{ expression: fail, label: "fail", id: "fail", visible: false }],
      [{ expression: emit, label: "emit", id: "emit", visible: false }],
      [
        {
          expression: "IF(emit > 0, 100 * fail / emit, 0)",
          label: "Failure rate %",
          id: "rate",
        },
      ],
    ],
    { period: 300, sparkline: true },
  );
}

function kpiDlqDepth(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  return singleValueWidget(
    x,
    y,
    w,
    h,
    d.region,
    "DLQ depth (now)",
    [["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", d.dlqName]],
    { stat: "Maximum", period: 60, sparkline: true },
  );
}

// =============================================================================
// ## Orders — paired total + per-shape widgets
// =============================================================================

function ordersEmittedTotal(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    d.region,
    "OrdersEmitted — total/min",
    expressionMetric({
      expression: `SUM(${searchByShape("OrdersEmitted", d.producerName, "Sum", 60)})`,
      label: "Total",
      id: "tot",
    }),
  );
}

function ordersEmittedByShape(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    d.region,
    "OrdersEmitted — by orderShape",
    expressionMetric({
      expression: searchByShape("OrdersEmitted", d.producerName, "Sum", 60),
      label: "",
      id: "shape",
    }),
    { stacked: true },
  );
}

function ordersWrittenTotal(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    d.region,
    "OrdersWritten — total/min",
    expressionMetric({
      expression: `SUM(${searchByShapeNoEnv("OrdersWritten", d.consumerName, "Sum", 60)})`,
      label: "Total",
      id: "tot",
    }),
  );
}

function ordersWrittenByShape(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    d.region,
    "OrdersWritten — by orderShape",
    expressionMetric({
      expression: searchByShapeNoEnv(
        "OrdersWritten",
        d.consumerName,
        "Sum",
        60,
      ),
      label: "",
      id: "shape",
    }),
    { stacked: true },
  );
}

function orderAmountCentsTotal(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    d.region,
    "OrderAmountCents — total processed/min",
    expressionMetric({
      expression: `SUM(${searchByShapeNoEnv("OrderAmountCents", d.consumerName, "Sum", 60)})`,
      label: "Total cents",
      id: "tot",
    }),
  );
}

function orderAmountCentsByShape(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    d.region,
    "OrderAmountCents — by orderShape",
    expressionMetric({
      expression: searchByShapeNoEnv(
        "OrderAmountCents",
        d.consumerName,
        "Sum",
        60,
      ),
      label: "",
      id: "shape",
    }),
    { stacked: true },
  );
}

function orderAmountHistogramPercentiles(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  // OrderAmountHistogram is `Metric.tagged("orderShape")` per shape; aggregate
  // across shapes via SEARCH+stat per percentile. Three lines, period 300s.
  const search = (stat: string) =>
    `SEARCH('{${POWERTOOLS_NAMESPACE},orderShape,service} MetricName="OrderAmountHistogram" service="${d.consumerName}"', '${stat}', 300)`;
  return metricWidget(
    x,
    y,
    w,
    h,
    d.region,
    "OrderAmountHistogram — p50 / p95 / p99 (5 min)",
    [
      [{ expression: search("p50"), label: "p50", id: "p50" }],
      [{ expression: search("p95"), label: "p95", id: "p95" }],
      [{ expression: search("p99"), label: "p99", id: "p99" }],
    ],
    { period: 300, stat: "p95" },
  );
}

// =============================================================================
// ## Failures
// =============================================================================

function recordFailuresByReason(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    d.region,
    "RecordFailures — by reason",
    expressionMetric({
      expression: `SEARCH('{${POWERTOOLS_NAMESPACE},reason,service} MetricName="RecordFailures" service="${d.consumerName}"', 'Sum', 60)`,
      label: "",
      id: "reason",
    }),
    { stacked: true },
  );
}

function batchRecordFailuresTotal(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  // BatchRecordFailures auto-emitted by the bridge (untagged) → schema
  // {environment, service}.
  return metricWidget(x, y, w, h, d.region, "BatchRecordFailures", [
    [
      POWERTOOLS_NAMESPACE,
      "BatchRecordFailures",
      "service",
      d.consumerName,
      "environment",
      d.stack,
    ],
  ]);
}

function dlqDepthChart(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  return metricWidget(
    x,
    y,
    w,
    h,
    d.region,
    "DLQ depth",
    [["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", d.dlqName]],
    { stat: "Maximum" },
  );
}

// =============================================================================
// ## Latency
// =============================================================================

function e2ePipelineLatency(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  // All durations are histogram-typed (Metric.timer / Meter.instrument →
  // *Duration counter); chart at p95, period 300s.
  // `Metric.timer` and `Meter.instrument` produce untagged metrics → schema
  // {environment, service}.
  const trigger = (name: string) => [
    POWERTOOLS_NAMESPACE,
    name,
    "service",
    d.triggerName,
    "environment",
    d.stack,
    { stat: "p95", label: name },
  ];
  const producer = (name: string) => [
    POWERTOOLS_NAMESPACE,
    name,
    "service",
    d.producerName,
    "environment",
    d.stack,
    { stat: "p95", label: name },
  ];
  const consumer = (name: string) => [
    POWERTOOLS_NAMESPACE,
    name,
    "service",
    d.consumerName,
    "environment",
    d.stack,
    { stat: "p95", label: name },
  ];
  return metricWidget(
    x,
    y,
    w,
    h,
    d.region,
    "End-to-end pipeline latency (p95, 5 min)",
    [
      trigger("TriggerProcessDuration"),
      trigger("TriggerLatency"),
      producer("EmitLatencyMs"),
      [
        "AWS/SQS",
        "ApproximateAgeOfOldestMessage",
        "QueueName",
        d.mainQueueName,
        { stat: "Maximum", label: "SQS queue age (s)", yAxis: "right" },
      ],
      consumer("WriteLatency"),
      consumer("OrderProcessDuration"),
    ],
    { period: 300, stat: "p95" },
  );
}

function payloadBytesPercentiles(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  // PayloadBytes is `Metric.tagged("orderShape")` on producer → schema
  // {orderShape, service} (singleMetric path).
  const search = (stat: string) =>
    `SEARCH('{${POWERTOOLS_NAMESPACE},orderShape,service} MetricName="PayloadBytes" service="${d.producerName}"', '${stat}', 300)`;
  return metricWidget(
    x,
    y,
    w,
    h,
    d.region,
    "PayloadBytes — p50 / p95 / p99 (5 min)",
    [
      [{ expression: search("p50"), label: "p50", id: "p50" }],
      [{ expression: search("p95"), label: "p95", id: "p95" }],
      [{ expression: search("p99"), label: "p99", id: "p99" }],
    ],
    { period: 300, stat: "p95" },
  );
}

function producerResponseBytesPercentiles(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  // ProducerResponseBytes is untagged on trigger → schema
  // {environment, service}.
  return metricWidget(
    x,
    y,
    w,
    h,
    d.region,
    "ProducerResponseBytes — p50 / p95 / p99 (5 min)",
    [
      [
        POWERTOOLS_NAMESPACE,
        "ProducerResponseBytes",
        "service",
        d.triggerName,
        "environment",
        d.stack,
        { stat: "p50", label: "p50" },
      ],
      [".", ".", ".", ".", ".", ".", { stat: "p95", label: "p95" }],
      [".", ".", ".", ".", ".", ".", { stat: "p99", label: "p99" }],
    ],
    { period: 300, stat: "p95" },
  );
}

// =============================================================================
// ## Traffic & faults — slim
// =============================================================================

function lambdaInvocations(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  return metricWidget(x, y, w, h, d.region, "Lambda Invocations", [
    ["AWS/Lambda", "Invocations", "FunctionName", d.triggerName],
    [".", ".", ".", d.producerName],
    [".", ".", ".", d.consumerName],
  ]);
}

function lambdaErrors(
  x: number,
  y: number,
  w: number,
  h: number,
  d: DashboardInputs,
) {
  return metricWidget(x, y, w, h, d.region, "Lambda Errors", [
    ["AWS/Lambda", "Errors", "FunctionName", d.triggerName],
    [".", ".", ".", d.producerName],
    [".", ".", ".", d.consumerName],
  ]);
}

// =============================================================================
// ## Trace map — kept verbatim
// =============================================================================

function traceMapLink(
  x: number,
  y: number,
  w: number,
  h: number,
  region: string,
) {
  const md = [
    "### X-Ray Trace Map",
    "",
    "**Use the X-Ray Trace Map for end-to-end pipeline visualization.** A single trace spans the full request: trigger → producer → SQS → consumer → S3 (X-Ray context propagates automatically through SQS message attributes when active tracing is on).",
    "",
    `- **[X-Ray Trace Map](https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#xray:service-map/map)** — pipeline view`,
    `- [X-Ray Traces](https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#xray:traces)`,
    `- [Application Signals SLOs](https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#application-signals/slos)`,
  ].join("\n");
  return header(x, y, w, h, md);
}
