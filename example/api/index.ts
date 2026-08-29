// api/index.ts — the entry.
//
//   bun run api        → http://localhost:8110
//
// It starts things and assembles nothing: the app is built in src/app.ts and
// arrives here already configured. The split is what lets `junction surface`
// and `junction jobs` import that file to describe the app without binding a
// port, which is the only reason it is two files rather than one.

import app, { MAIL_SINK, PORT, COOKIE_AUTH } from './src/app.ts'
import { startMailSink }        from './src/core/mail-sink.ts'
import { startPspSink }         from './src/core/psp-sink.ts'
import { startIdpSink, IDP_URL } from './src/core/idp-sink.ts'
import { startStripeSink }      from './src/core/stripe-sink.ts'
import { PSP_URL }              from './src/core/psp.ts'
import { STRIPE_URL }           from './src/core/stripe.ts'
import { sys }                  from './src/core/db.ts'

// The two dev sinks are SECOND AND THIRD LISTENERS, so they are bound here
// rather than wherever conduit's targets are declared — describing the app
// (`junction surface`, `junction jobs`) imports src/app.ts, and that must not
// take 8111 and 8112 off the dev server already using them.
const sink = process.env.MAIL_SINK_URL ? null : startMailSink()
const psp  = process.env.PSP_URL       ? null : startPspSink()
// Fifth. A REAL vendor's shape beside this project's own — form-encoded bodies
// and Stripe's `t=…,v1=…` webhook signature — which is what shows whether the
// conduit boundary is generic (`FJS-D153`).
const stripe = process.env.STRIPE_URL ? null : startStripeSink()
// Fourth listener, and only when the app is in the mode that can use it.
const idp  = COOKIE_AUTH && !process.env.IDP_URL ? startIdpSink() : null

// Announced rather than printed. Each of these is a second listener with no
// route on this app, so the boot banner — which is derived from mounted routes
// — could not name them, and the three console.logs that used to sit below
// `app.start()` were the only record they existed. Registering says it once, in
// the place `/manifest` and the banner both read.
if (sink) app.registerDevService({ name: 'mail', url: MAIL_SINK, note: `inbox: ${MAIL_SINK}/  ·  json: ${MAIL_SINK}/outbox` })
if (psp)  app.registerDevService({ name: 'psp',  url: PSP_URL,   note: `GET ${PSP_URL}/v1/intents` })
if (stripe) app.registerDevService({ name: 'stripe', url: STRIPE_URL, note: `GET ${STRIPE_URL}/intents · GET ${STRIPE_URL}/events` })
if (idp)  app.registerDevService({ name: 'idp',  url: IDP_URL,   note: 'dev identity provider' })

await app.start()

// An empty database is the correct state for a first run and is indistinguishable
// from a broken query on screen: every route answers, every list is empty, and
// nothing says why. Seeding is a step now rather than a boot side effect, so
// this is the line that says the step has not been taken.
if (await sys.product.count() === 0) console.log(`
  ─────────────────────────────────────────────────────────────
    The database has no products. Nothing is broken — nothing
    has been seeded yet:

      bun run db:seed

    It prints the demo sign-ins. A second run adds only what is
    missing, so it is safe to repeat.
  ─────────────────────────────────────────────────────────────
`)

console.log(`
  ─────────────────────────────────────────────────────────────
    API   http://localhost:${PORT}/api/products
    UI    bun run dev        → http://localhost:8010

    curl http://localhost:${PORT}/api/products                # 200, the catalogue reads at 0
    curl http://localhost:${PORT}/api/orders                  # 401, the ledger does not
    curl http://localhost:${PORT}/api/shipping-methods        # 200, a storefront must offer these
    curl http://localhost:${PORT}/api/discounts               # 401, listing the codes IS the exploit
  ─────────────────────────────────────────────────────────────
`)
