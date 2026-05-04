import json
import os
import random
import time
import uuid
from datetime import datetime, timezone

import boto3
from aws_lambda_powertools import Logger, Metrics, Tracer
from aws_lambda_powertools.metrics import MetricUnit
from aws_lambda_powertools.metrics import single_metric

logger = Logger()
tracer = Tracer()
metrics = Metrics()

QUEUE_URL = os.environ["QUEUE_URL"]
sqs = boto3.client("sqs")  # Tracer auto-patches boto3

HIGH_AMOUNT_CENTS = 100_000
POISON_RATE = 0.05
DEBUG_LOG_RATE = 0.1


@tracer.capture_method
def _classify_amount(amount: int) -> str:
    if amount < 0:
        return "poison"
    if amount >= HIGH_AMOUNT_CENTS:
        return "high"
    return "normal"


@tracer.capture_method
def _build_order() -> dict:
    if random.random() < POISON_RATE:
        amount = -random.randint(1, 100)
    else:
        amount = random.randint(100, 250_000)
    order = {
        "orderId": str(uuid.uuid4()),
        "customerId": str(uuid.uuid4()),
        "amountCents": amount,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    if random.random() < DEBUG_LOG_RATE:
        logger.debug("order_serialized", extra={"orderId": order["orderId"]})
    return order


@tracer.capture_method
def _send_order(order: dict) -> None:
    sqs.send_message(QueueUrl=QUEUE_URL, MessageBody=json.dumps(order))


@logger.inject_lambda_context(log_event=False)
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def handler(event, _context):
    metrics.add_dimension(name="environment", value=os.environ.get("STAGE", "dev"))

    order = _build_order()
    shape = _classify_amount(order["amountCents"])

    tracer.put_annotation(key="orderId", value=order["orderId"])
    tracer.put_annotation(key="orderShape", value=shape)
    tracer.put_metadata(key="order", value=order)

    started = time.perf_counter()
    try:
        _send_order(order)
    except Exception:
        logger.exception("send_failed", extra={"orderId": order["orderId"]})
        metrics.add_metric(name="SendFailures", unit=MetricUnit.Count, value=1)
        raise
    elapsed_ms = (time.perf_counter() - started) * 1000

    payload_bytes = len(json.dumps(order).encode("utf-8"))
    metrics.add_metric(name="OrdersEmitted", unit=MetricUnit.Count, value=1)
    metrics.add_metric(name="PayloadBytes", unit=MetricUnit.Bytes, value=payload_bytes)
    metrics.add_metric(
        name="EmitLatencyMs", unit=MetricUnit.Milliseconds, value=elapsed_ms
    )

    with single_metric(
        name="OrdersByShape",
        unit=MetricUnit.Count,
        value=1,
        namespace=os.environ.get("POWERTOOLS_METRICS_NAMESPACE", ""),
    ) as m:
        m.add_dimension(name="orderShape", value=shape)

    if shape == "poison":
        logger.critical(
            "poison_emitted",
            extra={"orderId": order["orderId"], "amountCents": order["amountCents"]},
        )
    elif shape == "high":
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
            "orderShape": shape,
            "elapsedMs": round(elapsed_ms, 2),
        },
    )
    return {"orderId": order["orderId"]}
