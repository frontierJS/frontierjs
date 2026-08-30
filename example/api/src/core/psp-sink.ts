// api/src/core/psp-sink.ts — the payment provider, standing in for a real one.
//
// A dev PSP: it speaks the shape a card provider speaks (create an intent,
// confirm it, then tell the shop about it over a signed webhook), and it keeps
// what it has been sent so a drive can read it back. api/src/core/mail-sink.ts
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
//     actually serialised, no clock skew exists, and the endpoint's own
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
  status:   'requires_confirmation' | 'succeeded' | 'failed'
  /** How much of it has gone back. */
  refunded: number
  /** Every event this intent has produced, newest last. */
  events:   { id: string; type: string; at: number; delivered: number | null; status: number | null }[]
}

const intents = new Map<string, Intent>()

/** `Idempotency-Key` → the answer that key already got. A provider's, not the
 *  shop's: this is what stops a retried refund being a second refund. */
const replays = new Map<string, Record<string, unknown>>()

let seq = 0
const mint = (prefix: string) => `${prefix}_${(++seq).toString().padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`

export function startPspSink(): { stop(): void; port: number } {
  let failNext = false

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
   * The body is serialised ONCE and those exact bytes are both signed and
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
      },
    })

    const path = new URL(HOOK_URL).pathname
    const headers = await signRequest({
      secret:    OUTBOUND_KEY,
      method:    'POST',
      path,
      body,
      prefix:    'X-Psp',
      timestamp: Math.floor(Date.now() / 1000),
      nonce:     crypto.randomUUID(),
    })

    const record = intent.events.find(e => e.id === event.id)!
    try {
      const res = await fetch(HOOK_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      })
      record.status    = res.status
      record.delivered = res.ok ? Date.now() : null
      return res.status
    } catch {
      // The shop is not listening. A real provider would schedule a retry;
      // this one records the miss and `redeliver` is the manual version.
      record.status    = 0
      record.delivered = null
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
          failNext = false
          return Response.json({ ok: true })
        }

        // A provider having a bad minute. `send()` reports this as
        // `server_error`, retryable — the branch nothing else exercises.
        if (path === '/fail-next' && req.method === 'POST') {
          failNext = true
          return Response.json({ ok: true })
        }

        // ── The API half. Signed, and refused otherwise ──────────────────
        //
        // Read the body as BYTES and verify over those. Parsing first and
        // re-serialising to check the hash is the mistake that makes a scheme
        // pass every test and fail on the first payload whose keys come back
        // in a different order.
        const signed = async () => {
          const raw = await req.text()
          const check = await verifyRequest({
            secret:  INBOUND_KEY,
            method:  req.method,
            path,
            body:    raw,
            headers: req.headers,
            prefix:  'X-Hub',
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

          if (failNext) {
            failNext = false
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
            refunded:  0,
            events:    [],
          }
          intents.set(intent.id, intent)
          return Response.json(intent, { status: 201 })
        }

        // ── Refunds. Signed, and IDEMPOTENT ─────────────────────────────
        //
        // The only endpoint here where a retry costs real money, so it is the
        // only one that honours `Idempotency-Key` — which conduit sends when
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

          if (failNext) {
            failNext = false
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
