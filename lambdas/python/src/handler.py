import json
import logging
import os

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client("s3")
BUCKET = os.environ["DATA_BUCKET"]


def handler(event, _context):
    batch_item_failures = []

    for record in event.get("Records", []):
        try:
            _write_record(record)
        except Exception as err:  # noqa: BLE001
            logger.error(
                json.dumps(
                    {
                        "msg": "record_failed",
                        "messageId": record.get("messageId"),
                        "error": str(err),
                    }
                )
            )
            batch_item_failures.append({"itemIdentifier": record["messageId"]})

    return {"batchItemFailures": batch_item_failures}


def _write_record(record):
    message_id = record["messageId"]
    body = record["body"]
    key = f"messages/python/{message_id}.json"

    s3.put_object(
        Bucket=BUCKET,
        Key=key,
        Body=body.encode("utf-8"),
        ContentType="application/json",
        Metadata={
            "source-queue": record["eventSourceARN"],
            "sent-at": record["attributes"]["SentTimestamp"],
        },
    )

    logger.info(
        json.dumps(
            {
                "msg": "record_written",
                "messageId": message_id,
                "key": key,
                "bytes": len(body.encode("utf-8")),
            }
        )
    )
