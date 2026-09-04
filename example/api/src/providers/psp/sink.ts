// api/src/providers/psp/sink.ts — the payment provider, standing in for a real one.
//
// A dev PSP: it speaks the shape a card provider speaks (create an intent,
// confirm it, then tell the shop about it over a signed webhook), and it keeps
// what it has been sent so a drive can read it back. api/src/providers/mail/sink.ts
// is the same idea for email; this is the one that talks BACK.
//
// It is a SEPARATE LISTENER for the reason the mail sink is, and one more.
//
//   • an in-process fake would prove the app builds a payload and nothing else
//     — no credential resolved, no timeout, no 5xx, and `error.kind`
//     untestable
//   • it is the only way the INBOUND half is real. A webhook that arrives
//     from inside the process is a function call wearing a URL: nothing
//     crosses a socket, so no signature is computed over bytes that were
//     actually serialized, no clock skew exists, and the endpoint's own
//     `rawBody` is never exercised
//
// ─── It VERIFIES the shop's signature, and that is the point ──────────────
//
// `POST /v1/intents` answers 401 unless the request carries a valid HMAC. The
// shop's conduit target declares `auth: { type: 'hmac' }`, so every call it
// makes is signed — and a signer with no verifier reads as a scheme being
// enforced while enforcing nothing, which is exactly how basecamp's Outpost
// endpoints ended up taking no credential at all behind a comment saying the
// transport had checked one (FJS-349). Both sides run
// `@frontierjs/toolbelt/signature`; neither has an implementation of its own.
//
// ─── Delivery is synchronous, deliberately ────────────────────────────────
//
// A real provider queues the webhook and retries it for a day. This one POSTs
// it before answering `confirm`, so a drive that has awaited the confirm knows
// the shop has been told — no polling, no sleep, no flake. What that costs is
// the retry story, and `POST /v1/intents/{id}/redeliver` buys it back: the
// SAME event, sent again, which is what a provider does when it did not get a
// 2xx and is the case the shop's ledger exists for.
//
// Started by api/index.ts unless PSP_URL points somewhere else. Nothing in the
// app imports it except that one line.

import { signRequest, verifyRequest } from '@frontierjs/toolbelt/signature'

// dev/be/project 1/service 2 — see mail-sink.ts on where the number comes from.
const PORT = Number(process.env.PSP_SINK_PORT ?? 8112)

/** How the provider addresses ITSELF, for the one link it hands out. A
 *  challenge URL is followed by a person's browser, so it cannot be derived
 *  from the request that produced it — that request came from the shop. */
const PUBLIC_URL = process.env.PSP_URL ?? `http://localhost:${PORT}`

/** What the provider accepts as the shop's signing key — the other side of
 *  `auth: { type: 'hmac', ref: 'SHOP_PSP_KEY' }` on the conduit target. */
const INBOUND_KEY = process.env.SHOP_PSP_KEY ?? 'dev-psp-key'

/** What the provider signs its webhooks with. A DIFFERENT secret from the one
 *  above, because the two directions are two credentials: leaking the key the
 *  shop signs with must not let anyone forge an event, and a single shared
 *  secret makes those one leak. */
const OUTBOUND_KEY = process.env.SHOP_PSP_WEBHOOK_SECRET ?? 'dev-psp-webhook-secret'

/** Where the shop listens. `apiPrefix` is `/api`, and this is the provider's
 *  configuration rather than something it discovers — a real one is told the
 *  URL in a dashboard. */
const HOOK_URL = process.env.PSP_HOOK_URL ?? 'http://localhost:8110/api/webhooks/payments'

export interface Intent {
  id:       string
  amount:   number
  currency: string
  /** The shop's own reference, echoed back untouched. */
  reference: string | null
  status:   'requires_confirmation' | 'requires_action' | 'succeeded' | 'failed'
  /** Where the CARDHOLDER has to go, once their bank has asked for them. The
   *  issuer's challenge, hosted here because here is the provider. */
  actionUrl: string | null
  /** How much of it has gone back. */
  refunded: number
  /** Every event this intent has produced, newest last. */
  events:   { id: string; type: string; at: number; delivered: number | null; status: number | null }[]
}

const intents = new Map<string, Intent>()

/** A setup intent — a conversation with a PERSON about filing a card. It has no
 *  amount, because nothing is being charged. */
interface Setup {
  id:        string
  reference: string | null
  status:    'requires_confirmation' | 'succeeded'
  instrument: Instrument | null
}

/** What the provider is holding, and how it will behave when presented.
 *
 *  `behavior` is the test-card convention every real provider ships — a number
 *  that always declines, one that always asks for the cardholder — kept here
 *  rather than encoded in the id, so the shop's stored handle is opaque to it
 *  and a drive cannot pass by reading the string. */
interface Instrument {
  id:        string
  brand:     string
  last4:     string
  expMonth:  number
  expYear:   number
  behavior: 'ok' | 'declines' | 'needs_action'
}

const setups      = new Map<string, Setup>()
const instruments = new Map<string, Instrument>()

/** `Idempotency-Key` → the answer that key already got. A provider's, not the
 *  shop's: this is what stops a retried refund being a second refund. */
const replays = new Map<string, Record<string, unknown>>()

let seq = 0
const mint = (prefix: string) => `${prefix}_${(++seq).toString().padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`

export function startPspSink(): { stop(): void; port: number } {
  // How many more calls answer 500. A COUNT rather than a boolean, because an
  // outage that heals on the second attempt is not an outage: conduit replays a
  // request the caller declared `replayable`, so a one-shot failure is repaired
  // before the shop ever sees it and the drive asserting the shop's outage
  // reporting had nothing to report. `?times=` says how long the bad minute is.
  let failFor = 0

  // A stale sink from a previous run answers on this port and Bun's own error
  // points at Bun.serve, which reads as "the example is broken". Two API
  // processes sharing one provider would also mean one drive confirming
  // another drive's intent.
  const inUse = (): never => {
    throw new Error(
      `psp sink: port ${PORT} is already answering.\n` +
      `Another \`bun run api\` is probably still running. Stop it, or point this ` +
      `one elsewhere with PSP_SINK_PORT=… , or at an existing one with PSP_URL=…`
    )
  }

  /**
   * Tell the shop. Signed with `signRequest` under the `X-Psp` prefix — the
   * same function the shop verifies with, so the canonical string cannot
   * disagree.
   *
   * The body is serialized ONCE and those exact bytes are both signed and
   * sent. Re-stringifying for the signature is the classic way to ship a
   * scheme that fails on the first payload whose key order differs.
   */
  async function deliver(
    intent: Intent,
    event: { id: string; type: string; at: number },
    extra?: { refunded: number },
  ) {
    const body = JSON.stringify({
      id:      event.id,
      type:    event.type,
      created: Math.floor(event.at / 1000),
      data: {
        paymentRef: intent.id,
        amount:     intent.amount,
        currency:   intent.currency,
        reference:  intent.reference,
        reason:     intent.status === 'failed' ? 'Your card was declined (test)' : null,
        // Only meaningful on a refund event, and stated on every one so the
        // shape of `data` does not depend on the type.
        refunded:      extra?.refunded ?? null,
        refundedTotal: intent.refunded,
        // Only meaningful on `payment.action_required`, and stated on every
        // event for the same reason `refunded` is: a body whose keys depend on
        // its type is one every reader has to branch on before it can parse.
        actionUrl:     intent.actionUrl,
      },
    })

    const record = intent.events.find(e => e.id === event.id)!
    const status = await post(body)
    record.status    = status
    record.delivered = status && status < 400 ? Date.now() : null
    return status
  }

  /**
   * Put one signed body on the shop's webhook and answer the status it gave.
   *
   * Extracted because a filed card produces an event too, and a second copy of
   * the signing would be a second canonical string — which is the one thing in
   * this file that cannot be allowed to drift, since the shop verifies with the
   * same function and a mismatch is a 401 on every real event.
   *
   * 0 means the shop is not listening. A real provider would schedule a retry;
   * this one records the miss and `redeliver` is the manual version.
   */
  async function post(body: string): Promise<number> {
    const hook = new URL(HOOK_URL)
    const headers = await signRequest({
      secret:    OUTBOUND_KEY,
      method:    'POST',
      path:      hook.pathname,
      // Signed since `FJS-678`, and the shop recomputes it from the raw request
      // URL — a hook URL carrying a parameter would 401 on every event if only
      // one side carried it.
      query:     hook.search,
      body,
      prefix:    'X-Psp',
      timestamp: Math.floor(Date.now() / 1000),
      nonce:     crypto.randomUUID(),
    })
    try {
      const res = await fetch(HOOK_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      })
      return res.status
    } catch {
      return 0
    }
  }

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      port: PORT,
      async fetch(req) {
        const url  = new URL(req.url)
        const path = url.pathname

        // ── The catcher half. No signature: this is the drive's window into
        //    the provider, not part of the API the shop calls.
        if (path === '/v1/intents' && req.method === 'GET')
          return Response.json([...intents.values()])

        if (path === '/v1/intents' && req.method === 'DELETE') {
          intents.clear()
          replays.clear()
          failFor = 0
          return Response.json({ ok: true })
        }

        // A provider having a bad minute. `send()` reports this as
        // `server_error`, retryable — the branch nothing else exercises.
        if (path === '/fail-next' && req.method === 'POST') {
          const times = Number(url.searchParams.get('times') ?? 1)
          // `times=0` disarms, which is how a drive staging a long outage puts the
          // provider back before the section after it.
          failFor = Number.isFinite(times) && times >= 0 ? Math.floor(times) : 1
          return Response.json({ ok: true, times: failFor })
        }

        // ── The API half. Signed, and refused otherwise ──────────────────
        //
        // Read the body as BYTES and verify over those. Parsing first and
        // re-serializing to check the hash is the mistake that makes a scheme
        // pass every test and fail on the first payload whose keys come back
        // in a different order.
        const signed = async () => {
          const raw = await req.text()
          const check = await verifyRequest({
            secret:  INBOUND_KEY,
            method:  req.method,
            path,
            // From the raw URL, never a path the router already stripped.
            query:   url.search,
            body:    raw,
            headers: req.headers,
            prefix:  'X-Fjs',
            now:     Math.floor(Date.now() / 1000),
          })
          // The reason is logged and never returned: a caller learns that it
          // failed, not which check it failed, because "the signature is
          // wrong" and "your clock is out" are the same 401 to an attacker
          // and different lines in a log to whoever is fixing it.
          if (!check.ok) console.warn(`[psp] refused ${req.method} ${path} — ${check.reason}`)
          return { ok: check.ok, raw }
        }

        if (path === '/v1/intents' && req.method === 'POST') {
          const { ok, raw } = await signed()
          if (!ok) return Response.json({ error: 'invalid signature' }, { status: 401 })

          if (failFor > 0) {
            failFor--
            return Response.json({ error: 'temporarily unavailable' }, { status: 500 })
          }

          const body = JSON.parse(raw || '{}') as
            { amount?: number; currency?: string; reference?: string }

          const intent: Intent = {
            id:        mint('pi'),
            amount:    Number(body.amount ?? 0),
            currency:  String(body.currency ?? 'USD').toUpperCase(),
            reference: body.reference ?? null,
            status:    'requires_confirmation',
            actionUrl: null,
            refunded:  0,
            events:    [],
          }
          intents.set(intent.id, intent)
          return Response.json(intent, { status: 201 })
        }

        // ── Filing a card ───────────────────────────────────────────────
        //
        // No amount, because nothing is being charged. This is the object every
        // provider grew for the same reason: a shop that bills on a cycle has
        // to be able to present a card with nobody at the keyboard, and the
        // only honest way to get one is a conversation with the person first.
        if (path === '/v1/setup-intents' && req.method === 'POST') {
          const { ok, raw } = await signed()
          if (!ok) return Response.json({ error: 'invalid signature' }, { status: 401 })

          if (failFor > 0) {
            failFor--
            return Response.json({ error: 'temporarily unavailable' }, { status: 500 })
          }

          const body = JSON.parse(raw || '{}') as { reference?: string }
          const setup: Setup = {
            id:         mint('seti'),
            reference:  body.reference ?? null,
            status:     'requires_confirmation',
            instrument: null,
          }
          setups.set(setup.id, setup)
          // The instrument is deliberately absent from this reply. It does not
          // exist yet — a person has not been asked — and answering a handle
          // here would let a shop file a card nobody ever agreed to.
          return Response.json({ id: setup.id, status: setup.status }, { status: 201 })
        }

        // The person's side of it, unsigned like the payment confirm below and
        // for the same reason: this stands in for the provider's hosted page,
        // which the shop never calls and a browser reaches. `card` picks a test
        // card — `declines` is the one that always says no when presented.
        const setupConfirm = path.match(/^\/v1\/setup-intents\/([^/]+)\/confirm$/)
        if (setupConfirm && req.method === 'POST') {
          const setup = setups.get(setupConfirm[1])
          if (!setup) return Response.json({ error: 'no such setup intent' }, { status: 404 })
          if (setup.status !== 'requires_confirmation')
            return Response.json({ error: `setup intent is already ${setup.status}` }, { status: 409 })

          // The test cards. `needs_action` is the one that makes a shop find out
          // whether it has an SCA path at all: it files perfectly and then asks
          // for the cardholder the first time it is presented with nobody there.
          const { card = 'ok' } = await req.json().catch(() => ({})) as { card?: string }
          const behavior: Instrument['behavior'] =
            card === 'declines'    ? 'declines'
            : card === 'needs_action' ? 'needs_action'
            : 'ok'
          const instrument: Instrument = {
            id:        mint('pm'),
            brand:     behavior === 'declines' ? 'visa' : 'mastercard',
            last4:     behavior === 'declines' ? '0002' : behavior === 'needs_action' ? '3155' : '4242',
            expMonth:  12,
            expYear:   2030,
            behavior,
          }
          instruments.set(instrument.id, instrument)
          setup.instrument = instrument
          setup.status     = 'succeeded'

          // The shop learns about it the same way it learns about money: a
          // signed event on its own connection. Not this reply — the browser
          // that confirmed is on the person's machine and is not a caller the
          // shop can believe about whose card was filed.
          const body = JSON.stringify({
            id:      mint('evt'),
            type:    'setup.succeeded',
            created: Math.floor(Date.now() / 1000),
            data: {
              setupRef:   setup.id,
              reference:  setup.reference,
              instrument: {
                id: instrument.id, brand: instrument.brand, last4: instrument.last4,
                expMonth: instrument.expMonth, expYear: instrument.expYear,
              },
            },
          })
          const status = await post(body)
          return Response.json({
            id: setup.id, status: setup.status, webhook: status,
            instrument: { id: instrument.id, brand: instrument.brand, last4: instrument.last4 },
          })
        }

        // ── Refunds. Signed, and IDEMPOTENT ─────────────────────────────
        //
        // The only endpoint here where a retry costs real money, so it is the
        // only one that honors `Idempotency-Key` — which conduit sends when
        // the caller states one. A refund is the case the header exists for:
        // a click, a timeout, a click again, and without a key the shop has
        // paid the customer twice with two 200s and no way to tell.
        //
        // Keyed by the header alone, and the first answer is REPLAYED verbatim
        // rather than recomputed. A key that answers a different thing the
        // second time is not idempotency, it is a cache with a bug.
        if (path === '/v1/refunds' && req.method === 'POST') {
          const { ok, raw } = await signed()
          if (!ok) return Response.json({ error: 'invalid signature' }, { status: 401 })

          const key = req.headers.get('idempotency-key')
          if (key && replays.has(key)) {
            const prior = replays.get(key)!
            return Response.json({ ...prior, replayed: true }, { status: 200 })
          }

          if (failFor > 0) {
            failFor--
            return Response.json({ error: 'temporarily unavailable' }, { status: 500 })
          }

          const body = JSON.parse(raw || '{}') as { paymentRef?: string; amount?: number }
          const intent = intents.get(String(body.paymentRef ?? ''))
          if (!intent) return Response.json({ error: 'no such payment' }, { status: 404 })
          if (intent.status !== 'succeeded')
            return Response.json({ error: `cannot refund a payment that is ${intent.status}` }, { status: 409 })

          // A whole refund is the default, because it is what a shop means
          // nine times in ten and stating the amount to mean "all of it" is
          // the shape that goes wrong when the amount is stale.
          const asked = body.amount === undefined ? intent.amount - intent.refunded : Number(body.amount)
          if (!(asked > 0)) return Response.json({ error: 'a refund is more than nothing' }, { status: 400 })
          if (asked > intent.amount - intent.refunded)
            return Response.json({ error: 'that is more than is left to refund' }, { status: 409 })

          intent.refunded = intent.refunded + asked

          const event = {
            id: mint('evt'), type: 'payment.refunded', at: Date.now(),
            delivered: null as number | null, status: null as number | null,
          }
          intent.events.push(event)
          const status = await deliver(intent, event, { refunded: asked })

          const answer = { id: mint('re'), paymentRef: intent.id, amount: asked, total: intent.refunded, webhook: status }
          if (key) replays.set(key, answer)
          return Response.json(answer, { status: 201 })
        }

        // ── The shop presenting a card it was given ─────────────────────
        //
        // SIGNED, where the confirm below is not, and the difference is the
        // whole point of the pair: down there a person is at a browser and the
        // person is the authorization; here there is nobody, and a signature is
        // the only kind of caller that can stand in for one.
        const offSession = path.match(/^\/v1\/intents\/([^/]+)\/confirm-off-session$/)
        if (offSession && req.method === 'POST') {
          const { ok, raw } = await signed()
          if (!ok) return Response.json({ error: 'invalid signature' }, { status: 401 })

          const intent = intents.get(offSession[1])
          if (!intent) return Response.json({ error: 'no such intent' }, { status: 404 })
          if (intent.status !== 'requires_confirmation')
            return Response.json({ error: `intent is already ${intent.status}` }, { status: 409 })

          const body = JSON.parse(raw || '{}') as { instrument?: string }
          const instrument = instruments.get(String(body.instrument ?? ''))
          // A handle this provider is not holding. 404 rather than a decline:
          // nothing was presented, so there is nothing for the shop to dun
          // somebody over.
          if (!instrument) return Response.json({ error: 'no such instrument' }, { status: 404 })

          // Three answers, not two. `requires_action` is the bank asking for the
          // cardholder, which is neither a decline nor a success: the shop has
          // nothing left to try and the money has not moved. The event carries
          // the only thing that can resolve it, which is somewhere to send a
          // person.
          intent.status =
            instrument.behavior === 'declines'     ? 'failed'
            : instrument.behavior === 'needs_action' ? 'requires_action'
            : 'succeeded'
          if (intent.status === 'requires_action')
            intent.actionUrl = `${PUBLIC_URL}/challenge/${intent.id}`

          const event = {
            id: mint('evt'),
            type: intent.status === 'requires_action'
              ? 'payment.action_required'
              : `payment.${intent.status}`,
            at: Date.now(),
            delivered: null as number | null, status: null as number | null,
          }
          intent.events.push(event)
          const status = await deliver(intent, event)
          return Response.json({
            id: intent.id, amount: intent.amount, currency: intent.currency,
            status: intent.status, webhook: status,
          })
        }

        // ── The shopper's side. Unsigned on purpose: this stands in for the
        //    provider's own hosted page, which the shop never calls and a
        //    person reaches with a browser.
        const confirm = path.match(/^\/v1\/intents\/([^/]+)\/confirm$/)
        if (confirm && req.method === 'POST') {
          const intent = intents.get(confirm[1])
          if (!intent) return Response.json({ error: 'no such intent' }, { status: 404 })

          const { outcome = 'succeeded' } = await req.json().catch(() => ({})) as { outcome?: string }
          if (intent.status !== 'requires_confirmation')
            return Response.json({ error: `intent is already ${intent.status}` }, { status: 409 })

          intent.status = outcome === 'failed' ? 'failed' : 'succeeded'
          const event = {
            id: mint('evt'), type: `payment.${intent.status}`, at: Date.now(),
            delivered: null as number | null, status: null as number | null,
          }
          intent.events.push(event)
          const status = await deliver(intent, event)
          return Response.json({ id: intent.id, status: intent.status, webhook: status })
        }

        // ── The issuer's challenge ──────────────────────────────────────
        //
        // Unsigned, like the two confirms above and for the same reason: a
        // person reaches it with a browser and the person is the authorization.
        // It is on the PROVIDER's origin, which is the whole design decision —
        // hosting a card network's challenge on the shop's own pages would put
        // a third party's script there to collect the one thing every other
        // line in this app is arranged not to see.
        const challenge = path.match(/^\/challenge\/([^/]+)$/)
        if (challenge && req.method === 'POST') {
          const intent = intents.get(challenge[1])
          if (!intent) return Response.json({ error: 'no such intent' }, { status: 404 })
          if (intent.status !== 'requires_action')
            return Response.json({ error: `intent is ${intent.status}` }, { status: 409 })

          const { outcome = 'succeeded' } = await req.json().catch(() => ({})) as { outcome?: string }
          intent.status    = outcome === 'failed' ? 'failed' : 'succeeded'
          intent.actionUrl = null
          const event = {
            id: mint('evt'), type: `payment.${intent.status}`, at: Date.now(),
            delivered: null as number | null, status: null as number | null,
          }
          intent.events.push(event)
          const status = await deliver(intent, event)
          return Response.json({ id: intent.id, status: intent.status, webhook: status })
        }

        // The retry a real provider does on its own when it did not get a 2xx.
        const again = path.match(/^\/v1\/intents\/([^/]+)\/redeliver$/)
        if (again && req.method === 'POST') {
          const intent = intents.get(again[1])
          if (!intent) return Response.json({ error: 'no such intent' }, { status: 404 })
          const last = intent.events.at(-1)
          if (!last) return Response.json({ error: 'nothing to redeliver' }, { status: 409 })
          const status = await deliver(intent, last)
          return Response.json({ id: intent.id, event: last.id, webhook: status })
        }

        return new Response('not found', { status: 404 })
      },
    })
  } catch (err) {
    if ((err as { code?: string }).code === 'EADDRINUSE') inUse()
    throw err
  }

  return { stop: () => server.stop(true), port: PORT }
}
