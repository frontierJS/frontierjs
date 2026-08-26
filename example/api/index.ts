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
import { PSP_URL }              from './src/core/psp.ts'
import { sys }                  from './src/core/db.ts'

// The two dev sinks are SECOND AND THIRD LISTENERS, so they are bound here
// rather than wherever conduit's targets are declared — describing the app
// (`junction surface`, `junction jobs`) imports src/app.ts, and that must not
// take 8111 and 8112 off the dev server already using them.
const sink = process.env.MAIL_SINK_URL ? null : startMailSink()
const psp  = process.env.PSP_URL       ? null : startPspSink()
// Fourth listener, and only when the app is in the mode that can use it.
const idp  = COOKIE_AUTH && !process.env.IDP_URL ? startIdpSink() : null

await app.start()

if (sink) console.log(`  [mail] dev sink on ${MAIL_SINK} — GET ${MAIL_SINK}/outbox`)
if (psp)  console.log(`  [psp]  dev provider on ${PSP_URL} — GET ${PSP_URL}/v1/intents`)
if (idp)  console.log(`  [idp]  dev identity provider on ${IDP_URL}`)

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
