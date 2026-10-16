// api/src/providers/psp/index.ts — what the payment provider IS, to this app.
//
// Both directions of one relationship, in one file, because they share a
// vocabulary and drifting apart is the failure worth designing against:
//
//   OUT  a declared conduit target, `auth: { type: 'hmac' }`, so every call
//        the shop makes is signed with `@frontierjs/toolbelt/signature`
//   IN   `pspDialect`, the receiving end conduit runs — verified with the SAME
//        function, over the raw bytes the request arrived as
//
// ─── Two secrets, not one ────────────────────────────────────────────────
//
// `SHOP_PSP_KEY` is what the shop signs with. `SHOP_PSP_WEBHOOK_SECRET` is
// what the provider signs with. Sharing one would mean that leaking the key
// the shop uses to spend money also lets anybody forge an event saying money
// arrived — one compromise, both directions. Every real provider issues them
// separately and it is worth spelling out why.
//
// Both are credential REFERENCES to conduit and plain env reads here. Neither
// has a default in production: the fallbacks below are the dev sink's, which
// is what keeps `bun run api` working with no setup while still being a real
// lookup rather than a literal in a header.

import { verifyRequest } from '@frontierjs/toolbelt/signature'
import type { App }      from '@frontierjs/junction'
import type { Dialect, ReceivedEvent } from '@frontierjs/conduit'

export const PSP_TARGET = 'provider:payments'

/** Where the provider lives. api/src/providers/psp/sink.ts unless pointed elsewhere. */
export const PSP_URL = process.env.PSP_URL ?? `http://localhost:${process.env.PSP_SINK_PORT ?? 8112}`

/** The path the provider POSTs to. One constant, because it is written down in
 *  three places that must agree — the route, the sink's default, and the
 *  signature, which binds the path so a captured event cannot be replayed at a
 *  different endpoint. `apiPrefix` supplies the `/api`. */
export const WEBHOOK_PATH = '/webhooks/payments'

/** The header family the provider signs under. */
const PREFIX = 'X-Psp'

/** How far out a provider's clock may be. Five minutes is the default and is
 *  what a provider's own docs assume; a tighter window starts refusing real
 *  events on a laptop that has been asleep. */
const TOLERANCE_SECONDS = 300

// ─── The receiving end — the provider's dialect ───────────────────────────
//
// Conduit runs the order (credential → verify → parse → owner → receipt →
// apply) and keeps the receipt that makes a redelivery a duplicate; this is the
// vendor's half, three pure functions (`FJS-D899`). The provider speaks this
// project's own scheme, so `verify` is `verifyRequest` over the bytes that
// arrived — `rawBody`, never a re-serialized parse, since both ends would then
// have to agree about key order forever.
//
// Two replay refusals with two lifetimes, and neither is the other:
//
//   the nonce    has this exact SIGNATURE been presented inside its window — a
//                captured request replayed. Conduit's memory, per receiver,
//                kept for twice the tolerance (FJS-1833); a process restarting
//                with a cold memory loses nothing, because
//   the receipt  has this EVENT been applied — for all time, in conduit's
//                store, and `model PaymentEvent`'s @unique behind it is what
//                makes applying twice safe.
export const pspDialect: Dialect<string, PspEvent> = {
  verify: (d, secret, { now, seenNonce }) => verifyRequest({
    secret,
    method: d.method,
    // The path AS THE PROVIDER ADDRESSED IT, prefix included, and the raw
    // search string: `apiPrefix` moves every route, and a signature covers the
    // bytes the sender put on the wire (`FJS-678`).
    path:    d.path,
    query:   d.query,
    body:    d.rawBody,
    headers: d.headers,
    prefix:  PREFIX,
    toleranceSeconds: TOLERANCE_SECONDS,
    now,
    seenNonce: nonce => seenNonce(nonce, 2 * TOLERANCE_SECONDS),
  }),
  parse: (d) => {
    const b = d.body as Partial<PspEvent> | null
    return b && typeof b.id === 'string' && typeof b.type === 'string'
      ? { id: b.id, type: b.type, payload: b }
      : null
  },
  dedupeKey: (_d, ev) => ev.id,
}

/** What the provider posts: `id` names the event, `data.paymentRef` the intent. */
export interface PspEvent extends ReceivedEvent {
  id:      string
  type:    string
  payload: Record<string, unknown>
}

/**
 * Ask the provider to give money back.
 *
 * ─── The `key` argument is the whole difference from `createIntent` ──────
 *
 * Creating an intent twice makes two intents, and the second is abandoned and
 * costs nothing. Refunding twice pays the customer twice, with two 200s and
 * nothing to distinguish them afterwards — so this is the one outbound call in
 * this app that states an idempotency key, and conduit puts it on the wire as
 * `Idempotency-Key` for the provider to honor.
 *
 * The key is the CALLER's to choose and is not defaulted here, because what
 * makes two attempts "the same refund" is a question about the shop's
 * intention and not about this function: a uuid minted per call would be
 * perfectly unique and would guard nothing.
 *
 * `amount` is minor units, and omitting it means all of what is left, which is
 * what a shop means nine times in ten. Stating a number to mean "everything" is the shape that goes
 * wrong when the number is stale.
 */
export async function createRefund(app: App, req: {
  paymentRef: string
  amount?: number
  key: string
}): Promise<{ refund?: Refund; error?: { kind: string; message: string; retryable: boolean } }> {
  const conduit = app.conduit
  if (!conduit) throw new Error('psp: app.conduit is not configured')

  const result = await conduit.send<Refund>({
    target: PSP_TARGET,
    method: 'POST',
    path:   '/v1/refunds',
    body:   { paymentRef: req.paymentRef, ...(req.amount === undefined ? {} : { amount: req.amount }) },
    idempotency_key: req.key,
  })

  if (result.error) {
    const { kind, message, retryable } = result.error
    return { error: { kind, message, retryable: retryable ?? false } }
  }
  return { refund: result.data }
}

/** What the provider answers when a refund is taken. Both figures are minor
 *  units — see `Intent.amount`. */
export interface Refund {
  id:         string
  paymentRef: string
  /** What went back on THIS call. */
  amount:     number
  /** What has gone back in total, this call included. */
  total:      number
}

/** What the provider answers when an intent is created. */
export interface Intent {
  id:       string
  /** MINOR units — cents for a dollar, whole yen for a yen. The same unit
   *  `@money` stores and the same unit every real provider is addressed in;
   *  `stripe.ts` refuses a non-integer here by name, for the reason written
   *  there. A major-unit amount charges a hundredth of what was meant. */
  amount:   number
  currency: string
  status:   string
}

/** The instrument the provider has filed, as it describes it.
 *
 *  `id` is the only part that can move money and is the only part this app
 *  keeps guarded; the rest exists so a person can tell one card from another.
 *  There is no card number here and there is no route by which there could
 *  be — the shop asks the provider to hold one and is handed a handle. */
export interface ProviderInstrument {
  id:       string
  brand:    string
  last4:    string
  expMonth: number
  expYear:  number
}

/** What the provider answers when asked to file an instrument.
 *
 *  `instrument` is absent until somebody has confirmed it: a setup intent is a
 *  conversation with a PERSON, so the shop mints one, hands its id to a
 *  browser, and learns how it went from a signed event rather than from this
 *  reply. */
export interface SetupIntent {
  id:         string
  status:     string
  instrument?: ProviderInstrument
}

/**
 * Ask the provider to file an instrument for later.
 *
 * The counterpart of `createIntent` and deliberately a separate call: this one
 * takes no amount, because nothing is being charged. It is the only way a shop
 * ends up able to bill somebody who is not there, and every provider spells it
 * as its own object for the same reason (Stripe's SetupIntent, Adyen's
 * zero-auth, Braintree's vaulting).
 *
 * `reference` is the shop's own name for who this is for. It comes back on the
 * event, which is how the app knows whose card was filed without holding state
 * between two requests that may reach different processes.
 */
export async function createSetupIntent(app: App, req: {
  reference: string
}): Promise<{ setup?: SetupIntent; error?: { kind: string; message: string; retryable: boolean } }> {
  const conduit = app.conduit
  if (!conduit) throw new Error('psp: app.conduit is not configured')

  const result = await conduit.send<SetupIntent>({
    target: PSP_TARGET,
    method: 'POST',
    path:   '/v1/setup-intents',
    body:   req,
  })

  if (result.error) {
    const { kind, message, retryable } = result.error
    return { error: { kind, message, retryable: retryable ?? false } }
  }
  return { setup: result.data }
}

/**
 * Ask the provider for a payment intent.
 *
 * Through `app.conduit`, never `fetch`: the credential is a ref resolved at
 * send time, the timeout / retry / breaker are the target's, and a failure
 * arrives as a typed `error.kind` rather than a thrown string — which matters
 * here more than it does for mail, because "the provider is down" (retry) and
 * "our key is wrong" (do not) are the two branches a payment must not confuse.
 *
 * It does NOT throw on a provider failure. The caller is writing a row about
 * what happened and needs the failure as a value; `payments.start` turns it
 * into the shop's own sentence.
 */
export async function createIntent(app: App, req: {
  /** Minor units. See `Intent.amount`. */
  amount: number
  currency: string
  reference: string
}): Promise<{ intent?: Intent; error?: { kind: string; message: string; retryable: boolean } }> {
  const conduit = app.conduit
  if (!conduit) throw new Error('psp: app.conduit is not configured')

  const result = await conduit.send<Intent>({
    target: PSP_TARGET,
    method: 'POST',
    path:   '/v1/intents',
    body:   req,
    // Minting an intent moves no money and writes no row here until it
    // succeeds, so repeating one is harmless — which conduit cannot know from
    // `POST` alone and will not assume. An idempotency key would be the wrong
    // way to say it: a key asserts the provider COLLAPSES duplicates, and after
    // a decline the shopper needs a genuinely new intent rather than the
    // refused one back.
    replayable: true,
  })

  if (result.error) {
    const { kind, message, retryable } = result.error
    return { error: { kind, message, retryable: retryable ?? false } }
  }
  return { intent: result.data }
}

/**
 * Present a filed instrument against an intent this shop has already minted.
 *
 * ─── Why this is a second call and not a flag on `createIntent` ──────────
 *
 * An intent has to EXIST as a row here before money can move, because the
 * provider's event arrives on its own connection and may beat the reply to the
 * call that caused it. `chargeInvoice` mints the intent, writes its `Payment`
 * row, and only then asks for the money — so there is always something for
 * `payments.record` to find. Charging inside the create would make the two a
 * race the shop loses silently: the webhook says *paid* about a payment the
 * shop has no row for, which is `unknown-payment` and a 200.
 *
 * ─── And why it is SIGNED where the shopper's confirm is not ─────────────
 *
 * The hosted page a person is sent to confirms with no credential — it is
 * reached with a browser and the person IS the authorization. This one is the
 * shop acting on its own, with nobody there, which is the only kind of caller a
 * signature can speak for.
 *
 * `offSession` is stated rather than inferred from the instrument, because a
 * shop presenting a filed card with the person present is an ordinary thing —
 * a second order from a saved card — and the two want different answers when
 * the bank asks for the cardholder.
 */
export async function confirmOffSession(app: App, req: {
  intentId:   string
  instrument: string
}): Promise<{ intent?: Intent; error?: { kind: string; message: string; retryable: boolean } }> {
  const conduit = app.conduit
  if (!conduit) throw new Error('psp: app.conduit is not configured')

  const result = await conduit.send<Intent>({
    target: PSP_TARGET,
    method: 'POST',
    path:   `/v1/intents/${encodeURIComponent(req.intentId)}/confirm-off-session`,
    body:   { instrument: req.instrument, offSession: true },
  })

  if (result.error) {
    const { kind, message, retryable } = result.error
    return { error: { kind, message, retryable: retryable ?? false } }
  }
  return { intent: result.data }
}
