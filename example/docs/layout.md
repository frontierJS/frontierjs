# Layout — `example/`

```
example/
├── db/
│   ├── schema.lite         ← the seed. Read by api/ and by web/'s build
│   └── seed.ts             ← `bun run db:seed`. 13 products, 2 customers, 3 orders,
│                             2 demo users. A SCRIPT — nothing imports it
├── api/
│   ├── index.ts            ← the entry. start(), the dev mail sink, and nothing else
│   ├── *.snapshot.md       ← surface · jobs · principal · notifications. Four
│   │                         committed artefacts about THIS surface, generated
│   │                         from here and rechecked from here by CI
│   ├── config/             ← junction.config.js — caravan, and where the services are
│   └── src/
│       ├── app.ts          ← createApp, auth plugin (+ its three services), caravan, channels.
│       │                     Exported unstarted, so `junction surface` can import it
│       ├── core/db.ts      ← client + GatePlugin + autoMigrate; appends auth's
│       │                     schema fragments rather than pasting a copy
│       ├── core/gate.ts    ← the ONE place a session becomes a number
│       ├── jobs/           ← courier-book, payment-announce, holds-release (its own cron) — all autoloaded
│       ├── providers/mail/mailer.ts      ← IMail over app.conduit.send() — the provider is a TARGET
│       ├── providers/mail/sink.ts   ← the dev mail catcher on :8111, provider-shaped
│       │                          plus the inbox it serves at /
│       ├── providers/stripe/index.ts      ← the Stripe connection, both directions
│       ├── providers/stripe/sink.ts ← Stripe standing in for Stripe, on :8114
│       ├── notifications/  ← OrderPaid (staff, inApp) + OrderConfirmation (customer, email)
│       ├── emails/         ← order-confirmation.mesa — the body, in the email
│       │                     realm + preview.mjs (`bun run email:preview`)
│       └── services/       ← one per model/domain; orders.service.ts has the order transitions
└── web/                    ← Vite root
    ├── config/             ← vite.config.js + sierra.config.js + routes.js
    ├── test/
    │   ├── verify.mjs      ← the framework drive. 37 assertions
    │   ├── verify-ui.mjs   ← the KIT drive. 26 — overlays, keyboard, stores
    │   ├── verify-live.mjs ← the REAL-TIME drive. 14 — a watcher tab that never acts
    │   ├── verify-jobs.mjs ← the DEFERRED-WORK drive. 8 — no browser at all
    │   ├── verify-notify.mjs ← the OUTBOUND drive. 9 — mail at a real server
    │   ├── preview.mjs     ← serves dist/ with the dev server's proxies
    │   └── verify-build.mjs
    └── src/
        ├── stores/prefs.js       ← browser preferences; the only non-model state
        ├── lib/money.js          ← BASE, the display currency, and the one
        │                           `fromMinor` this surface performs
        ├── resources/Order.mesa  ← .mesa, invariants 18 + 19
        └── routes/               ← index, orders/{index,create,[id]}, products,
                                    customers, cart, inventory, settings

site/                       ← the PUBLIC storefront. Its own surface (FJS-D127),
  config/                     never a routesDir inside web/: one Vite root is one
    sierra.config.js          dist/, and `vite build` empties outDir — the SPA's
    vite.config.js            build deleted it, silently, for as long as it lived
  index.html                  there
  src/
    api.js                  ← the API's ORIGIN. An island crosses one; the SPA,
                                behind Vite's proxy, never has
    money.js                ← the shop's BASE currency, and cents → what a
                                person reads. No reader, no storage
    islands/                ← CatalogList (client:load), LiveStock (client:visible),
                                LivePrices (client:load — corrects a stale price)
    routes/
      _module.mesa          ← the layout. The first this repo PRERENDERS
      index.mesa            ← the home page, three products baked in
      404.mesa              ← and the reason `404.mesa` used to break the build
      catalog/              ← index.mesa + index.meta.js — load() at BUILD time
      products/[slug].mesa  ← ONE PAGE PER PRODUCT, via getStaticPaths()
  test/verify.mjs           ← the storefront drive. 37 assertions
  deploy/                   ← serve.js + Dockerfile — the site origin
```
