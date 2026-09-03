// api/src/providers/stripe/sink.ts — Stripe, standing in for Stripe.
//
// A dev listener that speaks the real thing's shape: form-encoded requests, a
// bearer secret key, Stripe-shaped JSON back, and webhooks signed the way
// Stripe signs them (`t=…,v1=…` over `"<t>.<body>"`).
//
// A SEPARATE LISTENER, for `mail-sink.ts`'s reason and one more. The general
// one: an in-process fake proves the payload was built and nothing else — no
// credential resolves, no timeout or 5xx is reachable, `error.kind` is
// untestable. The one specific to this connector: **the form encoding is the
// feature**, and a fake that took a JavaScript object would never put bytes on
// a wire, so the one thing worth proving would be the one thing not proved.
// This parses `amount=500&automatic_payment_methods%5Benabled%5D=true` back
// into a structure, which is how the nesting is checked at all.
//
// What it does NOT do is pretend to be Stripe's semantics. There are no card
// tokens, no 3DS, no balance. It answers the four shapes this app calls and the
// three refusals worth testing — a bad key, a declined card, and a provider
// having a bad minute.
//
// Started by api/index.ts unless STRIPE_URL points somewhere else.

import { createHmac } from 'node:crypto'

const PORT = Number(process.env.STRIPE_SINK_PORT ?? 8114)

/** What this stand-in accepts as a secret key. */
const KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_dev'

/** What it signs events with. Stripe's endpoint secrets look like this. */
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_dev'

/** Where the shop listens. The sink is TOLD this, exactly as Stripe is — a
 *  literal default with an env override, which is what psp-sink.ts does. */
const HOOK_URL = process.env.STRIPE_HOOK_URL ?? 'http://localhost:8110/api/webhooks/stripe'

interface Intent {
  id: string; object: 'payment_intent'; amount: number; currency: string
  status: string; client_secret: string; metadata: Record<string, string>
  refunded: number
}

/**
 * `a[b]=1&c[0][d]=2` → `{ a: { b: '1' }, c: [ { d: '2' } ] }`.
 *
 * The mirror of conduit's `encodeBody(_, 'form')`, and written here rather than
 * imported from it deliberately: a sink that decoded with the encoder's own code
 * would agree with it by construction, and the question being asked is whether
 * an INDEPENDENT reader can get the structure back. Values stay strings, which
 * is what a form carries and what every real form parser answers.
 */
function parseForm(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  if (!text) return root

  for (const pair of text.split('&')) {
    if (!pair) continue
    const eq  = pair.indexOf('=')
    const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, ' ')
    const val = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '))

    // `a[b][0]` → ['a','b','0']
    const path = [key.replace(/\[.*$/, ''), ...[...key.matchAll(/\[([^\]]*)\]/g)].map(m => m[1])]

    let node: Record<string, unknown> = root
    for (let i = 0; i < path.length - 1; i++) {
      const seg  = path[i]
      const next = path[i + 1]
      // A numeric next segment means the container is a list. `[]` (empty) is
      // not produced by conduit's encoder and is refused rather than guessed.
      if (node[seg] === undefined) node[seg] = /^\d+$/.test(next) ? [] : {}
      node = node[seg] as Record<string, unknown>
    }
    node[path[path.length - 1]] = val
  }
  return root
}

let counter = 0
const id = (prefix: string) => `${prefix}_${(++counter).toString().padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`

export function startStripeSink(): { stop(): void; port: number } {
  const intents = new Map<string, Intent>()
  const events: { id: string; type: string; at: number; status: number | null }[] = []
  let failNext = false

  /**
   * Tell the shop, signed the way Stripe signs.
   *
   * The signature is over `"<timestamp>.<exact bytes sent>"`, so the body is
   * serialised ONCE and that string is both signed and sent. Signing a
   * re-serialisation is the bug this shape exists to make impossible — the same
   * document, different bytes, and every event refused.
   */
  async function deliver(type: string, data: unknown): Promise<number | null> {
    const evt = { id: id('evt'), type, at: Date.now(), status: null as number | null }
    const payload = JSON.stringify({
      id: evt.id, object: 'event', type, created: Math.floor(evt.at / 1000),
      data: { object: data },
    })
    const t   = Math.floor(Date.now() / 1000)
    const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex')

    try {
      const res = await fetch(HOOK_URL, {
        method:  'POST',
        headers: {
          'Content-Type':     'application/json',
          'Stripe-Signature': `t=${t},v1=${sig}`,
        },
        body: payload,
      })
      evt.status = res.status
    } catch {
      // The shop being unreachable is not this listener's failure. Recorded so
      // /events can show the miss.
      evt.status = null
    }
    events.push(evt)
    return evt.status
  }

  const inUse = (): never => {
    throw new Error(
      `stripe sink: port ${PORT} is already answering.\n` +
      `Another \`bun run api\` is probably still running. Stop it, or point this ` +
      `one elsewhere with STRIPE_SINK_PORT=… , or at a real Stripe with STRIPE_URL=…`
    )
  }

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      port: PORT,
      async fetch(req) {
        const url  = new URL(req.url)
        const path = url.pathname

        // ── the catcher half, for a drive and for a person ──────────────
        if (path === '/intents' && req.method === 'GET') return Response.json([...intents.values()])
        if (path === '/events'  && req.method === 'GET') return Response.json(events)
        if (path === '/reset'   && req.method === 'POST') {
          intents.clear(); events.length = 0; failNext = false
          return Response.json({ ok: true })
        }
        // Arms one `api_error`, which is the only Stripe failure that is
        // legitimately retryable — the branch nothing else exercises.
        if (path === '/fail-next' && req.method === 'POST') {
          failNext = true
          return Response.json({ ok: true })
        }

        // ── the API half ────────────────────────────────────────────────
        if (req.headers.get('authorization') !== `Bearer ${KEY}`) {
          return Response.json({
            error: { type: 'invalid_request_error', code: 'api_key_invalid',
                     message: 'Invalid API Key provided' },
          }, { status: 401 })
        }

        // The body is read once, here, because the content-type check below is
        // about a body that EXISTS: a POST with no parameters carries no
        // content-type, and Stripe takes those — `/confirm` is one. Demanding
        // the header unconditionally refuses a legitimate call with a message
        // about encoding, which is a wrong diagnosis in the one place this sink
        // exists to give a right one.
        const text = req.method === 'POST' ? await req.text() : ''

        // Refusing a wrong content-type rather than parsing whatever arrives is
        // the assertion that makes this sink worth having: it is what catches
        // conduit sending JSON under a form content-type (`FJS-556`).
        const ct = (req.headers.get('content-type') ?? '').split(';')[0].trim()
        if (text && ct !== 'application/x-www-form-urlencoded') {
          return Response.json({
            error: { type: 'invalid_request_error', code: 'content_type',
                     message: `Stripe wants application/x-www-form-urlencoded, got '${ct || '(none)'}'` },
          }, { status: 400 })
        }

        if (failNext) {
          failNext = false
          return Response.json({
            error: { type: 'api_error', message: 'An unexpected error occurred' },
          }, { status: 500 })
        }

        const form = parseForm(text)

        if (path === '/v1/payment_intents' && req.method === 'POST') {
          const amount = Number(form.amount)
          if (!Number.isInteger(amount) || amount <= 0) {
            return Response.json({
              error: { type: 'invalid_request_error', code: 'parameter_invalid_integer',
                       message: 'Invalid integer: amount' },
            }, { status: 400 })
          }
          // The decline. Stripe's own magic amounts are card-driven; a single
          // reserved amount is the same idea with nothing to tokenise, and it is
          // what makes `translate()`'s card_error branch reachable.
          if (amount === 4242) {
            return Response.json({
              error: { type: 'card_error', code: 'card_declined',
                       decline_code: 'generic_decline', message: 'Your card was declined.' },
            }, { status: 402 })
          }

          const intent: Intent = {
            id: id('pi'), object: 'payment_intent', amount,
            currency: String(form.currency ?? 'usd'),
            status: 'requires_payment_method',
            client_secret: id('pi') + '_secret',
            metadata: (form.metadata ?? {}) as Record<string, string>,
            refunded: 0,
          }
          intents.set(intent.id, intent)
          return Response.json(intent)
        }

        // Confirming is not Stripe's real flow — that happens in a browser with
        // a card. This is the sink's own hook for "the money arrived", and it is
        // what makes the webhook path drivable at all.
        const confirm = path.match(/^\/v1\/payment_intents\/([^/]+)\/confirm$/)
        if (confirm && req.method === 'POST') {
          const intent = intents.get(confirm[1])
          if (!intent) return Response.json({ error: { type: 'invalid_request_error', message: 'No such payment_intent' } }, { status: 404 })
          intent.status = 'succeeded'
          await deliver('payment_intent.succeeded', intent)
          return Response.json(intent)
        }

        if (path === '/v1/refunds' && req.method === 'POST') {
          const intent = intents.get(String(form.payment_intent ?? ''))
          if (!intent) return Response.json({ error: { type: 'invalid_request_error', message: 'No such payment_intent' } }, { status: 404 })

          const left = intent.amount - intent.refunded
          const asked = form.amount === undefined ? left : Number(form.amount)
          if (!Number.isInteger(asked) || asked <= 0 || asked > left) {
            return Response.json({
              error: { type: 'invalid_request_error', code: 'amount_too_large',
                       message: `Refund amount (${asked}) is greater than unrefunded amount (${left})` },
            }, { status: 400 })
          }
          intent.refunded += asked
          const refund = {
            id: id('re'), object: 'refund' as const, amount: asked,
            currency: intent.currency, payment_intent: intent.id, status: 'succeeded',
          }
          await deliver('charge.refunded', { ...intent, refunded: intent.refunded })
          return Response.json(refund)
        }

        return Response.json({
          error: { type: 'invalid_request_error', message: `Unrecognized request URL: ${req.method} ${path}` },
        }, { status: 404 })
      },
    })
  } catch (err) {
    if ((err as { code?: string }).code === 'EADDRINUSE') inUse()
    throw err
  }

  return { stop: () => server.stop(true), port: PORT }
}
