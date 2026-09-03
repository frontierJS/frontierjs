// api/src/providers/psp/index.ts — what the payment provider IS, to this app.
//
// Both directions of one relationship, in one file, because they share a
// vocabulary and drifting apart is the failure worth designing against:
//
//   OUT  a declared conduit target, `auth: { type: 'hmac' }`, so every call
//        the shop makes is signed with `@frontierjs/toolbelt/signature`
//   IN   `verifyWebhook`, which verifies with the SAME function, over the
//        raw bytes the request arrived as
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

// ─── The replay window ────────────────────────────────────────────────────
//
// `verifyRequest` binds a nonce and leaves STORING it to the caller, because
// the kit does no I/O. This is that store, and it is deliberately in memory
// and deliberately small.
//
// It is not the shop's idempotency and must not be mistaken for it. Two
// different questions, two different lifetimes:
//
//   this        has this exact SIGNATURE been presented inside its five-minute
//               freshness window — a captured request being replayed
//   the ledger  has this EVENT ever been handled — for all time
//
// `model PaymentEvent`'s @unique is the second, and it is the one correctness
// depends on. This one is a cheap refusal in front of it, and a process that
// restarts with a cold set is not a bug: every replay it would have caught is
// refused by the ledger a moment later, for the same 200 and a row saying the
// event was already handled. Which is also why a shared store across replicas
// would buy nothing here — worth saying out loud, because "the nonce set is
// per-process" reads like a defect until you ask what it is guarding.
const seen = new Map<string, number>()

function noteNonce(nonce: string, now: number): boolean {
  // Swept on use rather than on a timer: the set is bounded by the request
  // rate inside one window, and a timer would be a second thing to shut down.
  if (seen.size > 1_000) for (const [k, t] of seen) if (now - t > TOLERANCE_SECONDS) seen.delete(k)
  const already = seen.has(nonce)
  if (!already) seen.set(nonce, now)
  return already
}

/**
 * Is this request really from the provider?
 *
 * Answers `{ ok }` or `{ ok: false, reason }` — the reason is for the log and
 * never for the response, because "your signature is wrong" and "your clock is
 * out" are one 401 to a forger and two different problems to whoever is
 * on call.
 *
 * `rawBody` is REQUIRED and is why this takes a context rather than a parsed
 * body: the signature covers a hash of the bytes that were sent, and
 * re-serialising `ctx.body` to check it means both ends have to agree about
 * key order forever. Junction keeps the bytes for exactly this
 * (`ctx.rawBody` on a raw route, `ctx.$raw.rawBody` in a hook).
 */
export async function verifyWebhook(ctx: {
  method: string
  path: string
  /**
   * The RAW search string, as it arrived. Part of the canonical string since
   * `FJS-678`; it is taken raw rather than off a parsed query bag, because a
   * signature covers the bytes the sender put on the wire and a
   * re-serialisation of a parsed query is a different string.
   */
  query?: string
  headers: Record<string, string> | Headers
  rawBody?: string
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  return verifyRequest({
    secret:  process.env.SHOP_PSP_WEBHOOK_SECRET,
    method:  ctx.method,
    // The path AS THE PROVIDER ADDRESSED IT, prefix included. `apiPrefix`
    // moves every route the app registers, so deriving this from
    // WEBHOOK_PATH alone would verify a different string than the one signed
    // the day somebody changes the prefix — and the failure is a 401 on every
    // real event, which reads as the provider being broken.
    path:    ctx.path,
    query:   ctx.query ?? '',
    body:    ctx.rawBody ?? '',
    headers: ctx.headers,
    prefix:  PREFIX,
    toleranceSeconds: TOLERANCE_SECONDS,
    now:     Math.floor(Date.now() / 1000),
    seenNonce: (nonce) => noteNonce(nonce, Math.floor(Date.now() / 1000)),
  })
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
 * `Idempotency-Key` for the provider to honour.
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
 * reached with a browser and the person IS the authorisation. This one is the
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
