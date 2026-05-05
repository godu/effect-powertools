import type { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import type * as Cause from "effect/Cause";
import { pretty as causePretty, failureOption as causeFailureOption } from "effect/Cause";
import * as Context from "effect/Context";
import * as HashMap from "effect/HashMap";
import * as List from "effect/List";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";

type PowertoolsMethod = "debug" | "info" | "warn" | "error" | "critical";

const defaultLevelMap = (level: LogLevel.LogLevel): PowertoolsMethod => {
  switch (level._tag) {
    case "Fatal":
      return "critical";
    case "Error":
      return "error";
    case "Warning":
      return "warn";
    case "Debug":
    case "Trace":
      return "debug";
    case "Info":
    case "All":
    default:
      return "info";
  }
};

const isEmptyCause = (cause: Cause.Cause<unknown>): boolean =>
  cause._tag === "Empty";

const stringifyMessage = (message: unknown): string => {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.map(stringifyMessage).join(" ");
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
};

const annotationsToObject = (
  annotations: HashMap.HashMap<string, unknown>,
): Record<string, unknown> => {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of annotations) {
    obj[k] = v;
  }
  return obj;
};

const spansToArray = (
  spans: List.List<{ readonly label: string; readonly startTime: number }>,
): ReadonlyArray<{ label: string; startTime: number }> => {
  const out: Array<{ label: string; startTime: number }> = [];
  for (const span of spans) {
    out.push({ label: span.label, startTime: span.startTime });
  }
  return out;
};

const causeToErrorPayload = (cause: Cause.Cause<unknown>): {
  errorString: string;
  error?: Error;
} => {
  const errorString = causePretty(cause);
  const failure = causeFailureOption(cause);
  if (Option.isSome(failure)) {
    const value = failure.value;
    if (value instanceof Error) {
      return { errorString, error: value };
    }
    const synthetic = new Error(stringifyMessage(value));
    synthetic.name = "EffectFailure";
    return { errorString, error: synthetic };
  }
  return { errorString };
};

export interface PowertoolsLoggerOptions {
  readonly logger: PowertoolsLogger;
  readonly levelMap?: (level: LogLevel.LogLevel) => PowertoolsMethod;
}

export const makePowertoolsLogger = (
  options: PowertoolsLoggerOptions,
): Logger.Logger<unknown, void> => {
  const map = options.levelMap ?? defaultLevelMap;
  return Logger.make((entry) => {
    const method = map(entry.logLevel);
    const extras: Record<string, unknown> = {
      ...annotationsToObject(entry.annotations),
    };
    const spanArray = spansToArray(entry.spans);
    if (spanArray.length > 0) {
      extras.effect_spans = spanArray;
    }
    const message = stringifyMessage(entry.message);
    const isFailure = !isEmptyCause(entry.cause);
    if (isFailure) {
      const { errorString, error } = causeToErrorPayload(entry.cause);
      extras.cause = errorString;
      if (error !== undefined) {
        options.logger[method](message, extras, { error });
        return;
      }
    }
    options.logger[method](message, extras);
  });
};

// Service tag for the raw Powertools Logger instance — exposed for the
// observability middleware (e.g., to call `addContext(ctx)` per request).
export class PowertoolsLoggerService extends Context.Tag(
  "@app/PowertoolsLoggerService",
)<PowertoolsLoggerService, PowertoolsLogger>() {}

export const PowertoolsLoggerLayer = (
  options: PowertoolsLoggerOptions,
): Layer.Layer<PowertoolsLoggerService> =>
  Layer.merge(
    Logger.replace(Logger.defaultLogger, makePowertoolsLogger(options)),
    Layer.succeed(PowertoolsLoggerService, options.logger),
  );
