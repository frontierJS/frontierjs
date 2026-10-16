// ============================================================
// Conduit — Receiving
//
// The other end of a Provider (FJS-D177, FJS-D681, FJS-D899). A Receiver is
// declared once, like a Target; conduit owns the route's order and what a
// duplicate means, and nothing else here is conduit's:
//
//   connector   the DIALECT — how this vendor signs, what its envelope is,
//               which field or header names one delivery. Pure functions of
//               the delivery and a credential; the clock is passed in.
//   app         the RECEIVER — the path, which credential verifies a delivery,
//               whose tenant an event is about, and what to do with it.
//   conduit     credential → verify → parse → owner → receipt → apply → mark
//
// Resilience does not cross. The retry is the sender's, so the only jobs are
// to be idempotent and to answer quickly; a breaker has no inbound meaning.
//
// A receiver never mints a principal. Nothing here produces a session; the
// app's `apply` runs as the system, or as whoever the app says, and a
// counterparty signing with FrontierJS's OWN scheme and becoming a caller is
// junction's door (`createApp({ credentials })`), not this.
// ============================================================

import { valueOf } from './credentials.ts'
import type { ConduitStore, CredentialResolver, Receipt } from './types.ts'

// ─── What arrives ─────────────────────────────────────────────

/** One inbound request, before anything about it is believed. */
export interface Delivery {
  method:  string
  /** The path as the sender addressed it, prefix included. */
  path:    string
  /** The raw search string as it arrived, `?` included, or '' — a signature covers what was sent, never a re-serialized parse. */
  query:   string
  /** The route's own captures — `{hookId}`. */
  route:   Record<string, string>
  /** Lowercased names. */
  headers: Record<string, string>
  /** The exact bytes, as text. Every dialect signs these. */
  rawBody: string
  /** The transport's parse of the body, for a dialect that reads a field. */
  body:    unknown
}

export type Verdict = { ok: true } | { ok: false; reason: string }

/**
 * What a dialect's `verify` is handed beside the delivery and the credential.
 * `now` is seconds, from this process's clock. `seenNonce` is the replay half
 * for a scheme whose nonce is not inside the signed timestamp's reach: one
 * memory per receiver, kept for the seconds the dialect states (twice its
 * tolerance, `FJS-1833`).
 */
export interface VerifyContext {
  now:       number
  seenNonce: (nonce: string, keepSeconds: number) => boolean
}

/** An event, flattened from its dialect's envelope. */
export interface ReceivedEvent {
  id:      string
  type:    string
  payload: unknown
}

/**
 * The vendor's half, exported by its connector (`FJS-D153`). Three pure
 * functions: no clock, no store, no app — a dialect written once is correct
 * in every app that names it.
 */
export interface Dialect<Cred = string, Ev extends ReceivedEvent = ReceivedEvent> {
  /** The signature and the freshness window together; the window is a check on a signed field, in the dialect's unit. */
  verify(d: Delivery, cred: Cred, ctx: VerifyContext): Verdict | Promise<Verdict>
  /** The event out of the envelope. `null` is *not an event* — answered 200 and ignored, because a 4xx retries forever. */
  parse(d: Delivery, cred: Cred): Ev | null
  /** What names ONE delivery: a body id, a header (Standard Webhooks' `webhook-id`), or the subject's own natural key. */
  dedupeKey(d: Delivery, ev: Ev, cred: Cred): string
}

/**
 * What the app did with an event. `applied` marks the receipt, so a redelivery
 * is a duplicate. `ignored` is recorded and done, and marks it too. `parked`
 * leaves the receipt UNAPPLIED: the subject does not exist yet (a receipt that
 * beats the send that minted the id), and the sender's retry or the app's own
 * re-drive applies it later.
 */
export type Outcome = 'applied' | 'ignored' | 'parked'

/** The app's half. */
export interface Receiver<Cred = string, Ev extends ReceivedEvent = ReceivedEvent, Owner = unknown> {
  /** The Provider this is the other end of — `stripe`. Receipts are keyed under it. */
  provider:   string
  /** Under the app's `apiPrefix`, like `app.post`. May carry a capture. */
  path:       string
  dialect:    Dialect<Cred, Ev>
  /**
   * Which credential verifies THIS delivery, chosen BEFORE the body is
   * believed. A string is a ref, resolved through the conduit's own
   * `CredentialResolver` — one key per relationship, the ordinary case. A
   * function is for a key that is a ROW: a per-subscription secret the path
   * names (`FJS-1804`). `null` refuses the delivery.
   */
  credential: string | ((d: Delivery) => Cred | null | Promise<Cred | null>)
  /**
   * Whose tenant the event is about, found AFTER verify: the vendor names our
   * number or our mailbox, never our tenant. Optional for an app with one.
   * `null` is an event about nothing of ours, still recorded.
   */
  owner?:     (ev: Ev, cred: Cred) => Owner | null | Promise<Owner | null>
  apply(ev: Ev, ctx: { owner: Owner | null; cred: Cred; delivery: Delivery }): Outcome | Promise<Outcome>
}

/** What the route answers, and why — `reason` is for the log and never the body. */
export interface Received {
  status: number
  body:   Record<string, unknown>
  /** `applied` · `ignored` · `parked` · `duplicate` · `refused` · `failed` */
  result: ReceiveResult
  reason?: string
}

export type ReceiveResult = Outcome | 'duplicate' | 'refused' | 'failed'
export const RECEIVE_RESULTS = ['applied', 'ignored', 'parked', 'duplicate', 'refused', 'failed'] as const

// ─── Declaring one ────────────────────────────────────────────

// A `Record` over the interface's own keys, as `DESCRIPTOR_FIELDS` is: a field
// added to `Receiver` without a line here fails the typecheck.
const RECEIVER_FIELDS: Record<keyof Receiver, true> = {
  provider: true, path: true, dialect: true, credential: true, owner: true, apply: true,
}
const DIALECT_FIELDS: Record<keyof Dialect, true> = { verify: true, parse: true, dedupeKey: true }

export function assertReceiver(r: Receiver<unknown, ReceivedEvent, unknown>): void {
  const where = `Receiver '${String((r as { path?: unknown })?.path ?? '?')}'`
  if (!r || typeof r !== 'object') throw new TypeError('receive(): a receiver is an object')
  for (const key of Object.keys(r))
    if (!Object.hasOwn(RECEIVER_FIELDS, key))
      throw new TypeError(`${where}: unknown field '${key}'. A receiver holds ${Object.keys(RECEIVER_FIELDS).join(', ')}`)
  if (typeof r.provider !== 'string' || !r.provider)
    throw new TypeError(`${where}: provider must name the Provider this is the other end of — 'stripe'`)
  if (typeof r.path !== 'string' || !r.path.startsWith('/'))
    throw new TypeError(`${where}: path must start with '/'`)
  if (!r.dialect || typeof r.dialect !== 'object')
    throw new TypeError(`${where}: dialect is the connector's { verify, parse, dedupeKey }`)
  for (const key of Object.keys(r.dialect))
    if (!Object.hasOwn(DIALECT_FIELDS, key))
      throw new TypeError(`${where}: dialect has an unknown field '${key}'. A dialect holds ${Object.keys(DIALECT_FIELDS).join(', ')}`)
  for (const key of Object.keys(DIALECT_FIELDS) as Array<keyof Dialect>)
    if (typeof r.dialect[key] !== 'function')
      throw new TypeError(`${where}: dialect.${key} must be a function`)
  if (!(typeof r.credential === 'string' && r.credential) && typeof r.credential !== 'function')
    throw new TypeError(`${where}: credential is a ref the resolver answers, or a function choosing the key for one delivery`)
  if (r.owner !== undefined && typeof r.owner !== 'function')
    throw new TypeError(`${where}: owner must be a function`)
  if (typeof r.apply !== 'function')
    throw new TypeError(`${where}: apply must be a function`)
}

// ─── The order ────────────────────────────────────────────────

const REFUSED = (reason: string): Received =>
  // One sentence for every refusal: which check failed is the log's, not the
  // sender's — *your clock is out* and *wrong secret* are one 401 to a forger.
  ({ status: 401, body: { error: 'not verified' }, result: 'refused', reason })

export interface AcceptDeps {
  store:       ConduitStore
  credentials: CredentialResolver
  /** This receiver's nonce memory — `@frontierjs/toolbelt/signature`'s `nonceMemory()`, one per receiver. */
  seenNonce:   (nonce: string, now: number, keepSeconds: number) => boolean
}

/**
 * One delivery, start to finish. The order is the finding (`FJS-1804`):
 * credential → verify → parse → owner → receipt → apply → mark applied.
 *
 * Dedupe means APPLIED, not SEEN (`FJS-1805`): the receipt is written first and
 * unapplied, a retry that finds it unapplied applies again, and only an applied
 * receipt makes a retry a duplicate. An apply that throws answers 500 and
 * leaves the receipt, so the sender's retry gets a clean run. Applying twice
 * must be safe — the subject's own unique key, inside the apply's write, is
 * what makes it so; one fact can also arrive as two deliveries with two ids.
 */
export async function accept<Cred, Ev extends ReceivedEvent, Owner>(
  r:    Receiver<Cred, Ev, Owner>,
  d:    Delivery,
  now:  number,
  deps: AcceptDeps,
): Promise<Received> {
  const cred = typeof r.credential === 'string'
    ? (valueOf(await deps.credentials.get(r.credential)) as Cred | null)
    : await r.credential(d)
  if (cred === null || cred === undefined || cred === '')
    return REFUSED(typeof r.credential === 'string' ? `credential '${r.credential}' did not resolve` : 'no credential for this delivery')

  const verdict = await r.dialect.verify(d, cred, { now, seenNonce: (nonce, keep) => deps.seenNonce(nonce, now, keep) })
  if (!verdict.ok) return REFUSED(verdict.reason)

  const ev = r.dialect.parse(d, cred)
  if (!ev) return { status: 200, body: { received: true, outcome: 'ignored' }, result: 'ignored', reason: 'not an event envelope' }

  const owner = (await r.owner?.(ev, cred)) ?? null
  const key   = r.dialect.dedupeKey(d, ev, cred)

  const seen = await deps.store.receipt(r.provider, key)
  if (seen?.applied_at) return { status: 200, body: { received: true, outcome: 'duplicate' }, result: 'duplicate' }
  if (!seen) {
    await deps.store.record({
      provider:    r.provider,
      key,
      event_type:  ev.type,
      owner:       owner === null ? null : String(owner),
      received_at: now * 1000,
      applied_at:  null,
    })
  }

  let outcome: Outcome
  try {
    outcome = await r.apply(ev, { owner, cred, delivery: d })
  } catch (err) {
    return {
      status: 500, body: { error: 'not applied' }, result: 'failed',
      reason: `${ev.type} ${ev.id} failed to apply, the sender will retry — ${(err as Error)?.message ?? String(err)}`,
    }
  }
  if (outcome !== 'parked') await deps.store.markApplied(r.provider, key, now * 1000)
  return { status: 200, body: { received: true, outcome }, result: outcome }
}

export type { Receipt }
