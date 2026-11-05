// The slice of Zapier this connector speaks: a hook URL the app holds in a
// row, what Zapier answers it, and the subscribe body Zapier sends. Zapier
// documents the status codes and not the body; the receipt fields are the
// ones a live Catch Hook answers.

export const ZAPIER_TARGET = 'provider:zapier'
/** The host every Zapier hook URL sits on — a Catch Hook and a REST Hook `target_url` alike. */
export const ZAPIER_HOOK_HOST = 'hooks.zapier.com'
/** Zapier's trigger ceiling. A bigger body is refused here, because Zapier's answer to one is worded for its own user. */
export const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024
/** Longer than any URL Zapier issues. */
export const MAX_URL_LENGTH = 2048

/** A JSON object or array; Zapier reads the keys as the trigger's fields. */
export type HookPayload = Record<string, unknown> | unknown[]

/** What a 200 carried. `silent` is a `/silent/` Catch Raw Hook, which answers an empty body. */
export interface HookReceipt {
  status:     number
  silent:     boolean
  attempt?:   string
  id?:        string
  requestId?: string
}

/** A REST Hook subscribe as Zapier sends it: the URL to post to and, where the integration names one, the event. */
export interface Subscription { targetUrl: string; event?: string }
export type SubscriptionRead = { ok: true; subscription: Subscription } | { ok: false; reason: string }
