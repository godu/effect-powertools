import json
import os
import random
import time
import uuid
from datetime import datetime, timezone

import boto3
from aws_lambda_powertools import Logger, Metrics, Tracer
from aws_lambda_powertools.metrics import MetricUnit

logger = Logger()
tracer = Tracer()
metrics = Metrics()

QUEUE_URL = os.environ["QUEUE_URL"]
sqs = boto3.client("sqs")  # Tracer auto-patches boto3

HIGH_AMOUNT_CENTS = 100_000


@tracer.capture_method
def _build_order() -> dict:
    order = {
        "orderId": str(uuid.uuid4()),
        "customerId": str(uuid.uuid4()),
        "amountCents": random.randint(100, 250_000),
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    logger.debug("order_serialized", extra={"orderId": order["orderId"]})
    return order


@tracer.capture_method
def _send_order(order: dict) -> None:
    sqs.send_message(QueueUrl=QUEUE_URL, MessageBody=json.dumps(order))


@logger.inject_lambda_context(log_event=False)
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def handler(event, _context):
    order = _build_order()
    tracer.put_annotation(key="orderId", value=order["orderId"])
    tracer.put_metadata(key="order", value=order)

    started = time.perf_counter()
    _send_order(order)
    elapsed_ms = (time.perf_counter() - started) * 1000

    payload_bytes = len(json.dumps(order).encode("utf-8"))
    metrics.add_metric(name="OrdersEmitted", unit=MetricUnit.Count, value=1)
    metrics.add_metric(name="PayloadBytes", unit=MetricUnit.Count, value=payload_bytes)
    metrics.add_metric(
        name="EmitLatencyMs", unit=MetricUnit.Milliseconds, value=elapsed_ms
    )

    if order["amountCents"] >= HIGH_AMOUNT_CENTS:
        logger.warning(
            "high_amount",
            extra={
                "orderId": order["orderId"],
                "amountCents": order["amountCents"],
            },
        )

    logger.info(
        "order_emitted",
        extra={
            "orderId": order["orderId"],
            "elapsedMs": round(elapsed_ms, 2),
        },
    )
    return {"orderId": order["orderId"]}
