import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";

const s3 = new S3Client({});
const BUCKET = process.env.DATA_BUCKET;
if (!BUCKET) throw new Error("DATA_BUCKET env var is required");

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      await writeRecord(record);
    } catch (err) {
      console.error(
        JSON.stringify({
          msg: "record_failed",
          messageId: record.messageId,
          error: (err as Error).message,
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

async function writeRecord(record: SQSRecord): Promise<void> {
  const key = `messages/typescript/${record.messageId}.json`;
  const body = record.body;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/json",
      Metadata: {
        "source-queue": record.eventSourceARN,
        "sent-at": record.attributes.SentTimestamp,
      },
    }),
  );

  console.log(
    JSON.stringify({
      msg: "record_written",
      messageId: record.messageId,
      key,
      bytes: Buffer.byteLength(body, "utf8"),
    }),
  );
}
