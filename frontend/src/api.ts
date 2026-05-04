import * as Effect from "effect/Effect";

export interface TriggerResponse {
  readonly orderId: string;
  readonly amountCents?: number;
}

export class TriggerError {
  readonly _tag = "TriggerError";
  constructor(readonly props: { readonly cause: string }) {}
}

export const triggerOrder = Effect.tryPromise({
  try: async () => {
    const res = await fetch("/api/trigger", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as TriggerResponse;
  },
  catch: (cause) => new TriggerError({ cause: String(cause) }),
});
