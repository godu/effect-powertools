import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Metric from "effect/Metric";

import { counter } from "./metrics";

/**
 * Effect-native port of @aws-lambda-powertools/batch.
 *
 * Each record handler returns its own typed Effect; the processor `Effect.exit`s
 * each one, never letting per-record failures abort the batch. Failed records'
 * `messageId`s travel back via `SQSBatchResponse.batchItemFailures` so SQS
 * retries (or DLQs) only the failed messages, not the whole batch.
 *
 * `processPartialResponse` runs records in parallel (configurable concurrency).
 * `processFifoPartialResponse` runs them strictly sequentially and short-circuits
 * on the first failure — every subsequent record is marked as failed without
 * being processed, matching Powertools `SqsFifoPartialProcessor` semantics
 * (FIFO ordering must be preserved across retries).
 */

const batchRecordSuccesses = counter("BatchRecordSuccesses");
const batchRecordFailures = counter("BatchRecordFailures");

export interface BatchProcessOptions<E, R> {
  readonly concurrency?: number | "unbounded";
  readonly onRecordFailure?: (
    record: SQSRecord,
    cause: Cause.Cause<E>,
  ) => Effect.Effect<void, never, R>;
}

export interface FifoBatchProcessOptions<E, R> {
  readonly onRecordFailure?: (
    record: SQSRecord,
    cause: Cause.Cause<E>,
  ) => Effect.Effect<void, never, R>;
}

const handleSuccess = (record: SQSRecord) =>
  Effect.zipRight(
    Effect.logDebug("batch_record_success").pipe(
      Effect.annotateLogs({ messageId: record.messageId }),
    ),
    Metric.update(batchRecordSuccesses, 1),
  );

const handleFailure = <E, R>(
  record: SQSRecord,
  cause: Cause.Cause<E>,
  onRecordFailure:
    | ((record: SQSRecord, cause: Cause.Cause<E>) => Effect.Effect<void, never, R>)
    | undefined,
): Effect.Effect<void, never, R> =>
  Effect.zipRight(
    Effect.logError("batch_record_failed").pipe(
      Effect.annotateLogs({
        messageId: record.messageId,
        cause: Cause.pretty(cause),
      }),
    ),
    Effect.zipRight(
      Metric.update(batchRecordFailures, 1),
      onRecordFailure ? onRecordFailure(record, cause) : Effect.void,
    ),
  );

export const processPartialResponse = <E, R>(
  event: SQSEvent,
  recordHandler: (record: SQSRecord) => Effect.Effect<unknown, E, R>,
  options: BatchProcessOptions<E, R> = {},
): Effect.Effect<SQSBatchResponse, never, R> =>
  Effect.gen(function* () {
    const records = event.Records;
    const exits = yield* Effect.forEach(
      records,
      (record) => Effect.exit(recordHandler(record)),
      { concurrency: options.concurrency ?? "unbounded", discard: false },
    );
    const failures: Array<{ readonly itemIdentifier: string }> = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      const exit = exits[i]!;
      if (Exit.isSuccess(exit)) {
        yield* handleSuccess(record);
      } else {
        yield* handleFailure(record, exit.cause, options.onRecordFailure);
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  });

export const processFifoPartialResponse = <E, R>(
  event: SQSEvent,
  recordHandler: (record: SQSRecord) => Effect.Effect<unknown, E, R>,
  options: FifoBatchProcessOptions<E, R> = {},
): Effect.Effect<SQSBatchResponse, never, R> =>
  Effect.gen(function* () {
    const failures: Array<{ readonly itemIdentifier: string }> = [];
    let shortCircuited = false;
    for (const record of event.Records) {
      if (shortCircuited) {
        yield* Effect.logWarning("batch_record_skipped_after_failure").pipe(
          Effect.annotateLogs({ messageId: record.messageId }),
        );
        yield* Metric.update(batchRecordFailures, 1);
        failures.push({ itemIdentifier: record.messageId });
        continue;
      }
      const exit = yield* Effect.exit(recordHandler(record));
      if (Exit.isSuccess(exit)) {
        yield* handleSuccess(record);
      } else {
        yield* handleFailure(record, exit.cause, options.onRecordFailure);
        failures.push({ itemIdentifier: record.messageId });
        shortCircuited = true;
      }
    }
    return { batchItemFailures: failures };
  });
