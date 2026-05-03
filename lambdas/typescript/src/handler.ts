import {
  BatchProcessor,
  EventType,
  processPartialResponse,
} from "@aws-lambda-powertools/batch";
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type {
  Context,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from "aws-lambda";

const logger = new Logger();
const tracer = new Tracer();
const metrics = new Metrics();

const s3 = tracer.captureAWSv3Client(new S3Client({}));
const BUCKET = process.env.DATA_BUCKET;
if (!BUCKET) throw new Error("DATA_BUCKET env var is required");

const processor = new BatchProcessor(EventType.SQS);

interface Order {
  orderId: string;
  customerId: string;
  amountCents: number;
  createdAt: string;
}

const writeOne = async (record: SQSRecord): Promise<void> => {
  const parent = tracer.getSegment();
  const subsegment = parent?.addNewSubsegment("writeOne");
  if (subsegment) tracer.setSegment(subsegment);

  try {
    const order = JSON.parse(record.body) as Order;

    logger.info("order_received", {
      orderId: order.orderId,
      messageId: record.messageId,
    });
    tracer.putAnnotation("orderId", order.orderId);
    tracer.putMetadata("order", order);

    if (order.amountCents < 0) {
      metrics.addMetric("RecordsRejected", MetricUnit.Count, 1);
      logger.error("poison_rejected", {
        orderId: order.orderId,
        amountCents: order.amountCents,
      });
      throw new Error("poison: negative amount");
    }

    const started = Date.now();
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: `orders/${order.orderId}.json`,
        Body: record.body,
        ContentType: "application/json",
      }),
    );
    const elapsedMs = Date.now() - started;

    metrics.addMetric("OrdersWritten", MetricUnit.Count, 1);
    metrics.addMetric("OrderAmountCents", MetricUnit.Count, order.amountCents);
    metrics.addMetric("WriteLatencyMs", MetricUnit.Milliseconds, elapsedMs);
    logger.info("order_written", { orderId: order.orderId, elapsedMs });
  } finally {
    subsegment?.close();
    if (parent) tracer.setSegment(parent);
  }
};

export const handler = async (
  event: SQSEvent,
  context: Context,
): Promise<SQSBatchResponse> => {
  metrics.captureColdStartMetric();
  logger.addContext(context);
  try {
    return await processPartialResponse(event, writeOne, processor, {
      context,
    });
  } finally {
    metrics.publishStoredMetrics();
  }
};
