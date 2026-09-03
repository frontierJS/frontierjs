// api/src/providers/index.ts — the parties this shop speaks to.
//
// A Provider is a third party the app talks to (`FJS-D06` §4) — an identity
// provider, a payment provider — and NOT Laravel's Service Provider, which in
// this framework is a Plugin. That ruling is why this directory exists and why
// none of what is in it lives under `core/`: `core/` is how this app is wired
// to ITSELF, and everything here is somebody else.
//
// ─── One folder per party, holding both halves ────────────────────────────
//
// Each provider directory holds the app's side of the relationship and, where
// there is one, the stand-in that lets it run on a laptop:
//
//   psp/index.ts     what the payment provider IS to this app — a conduit
//                    target, the webhook path, and the two credentials that
//                    make the directions independent
//   psp/sink.ts      a payment provider, standing in for a real one
//
// They are paired rather than filed by kind because **they have to agree**. A
// sink speaks the shape its connector sends: change the signature scheme in
// `psp/index.ts` and `psp/sink.ts` is the thing that stops verifying. Two trees
// is how the pair drifts, and the drift is silent — the connector still builds,
// the sink still answers, and the only symptom is a drive that fails somewhere
// else entirely.
//
// ─── What a sink is, and what it is not ───────────────────────────────────
//
// A sink is a SECOND LISTENER on its own port, started by `api/index.ts` and by
// nothing else. It is not mounted on this app, it holds no route of this app's,
// and it is dev-only: `PSP_URL`, `STRIPE_URL`, `MAIL_SINK_URL` and `IDP_URL`
// each point the connector at the real vendor instead, and the sink is simply
// never started. It is announced through `app.registerDevService`, which is the
// one place an app says what else it is serving.
//
// A sink is worth having for the reason `verify:stripe` exists: a connector
// tested against a mock the same author wrote agrees with itself. What makes
// these honest is that the sink implements the VENDOR's shape — Stripe's
// form-encoded bodies and its `t=…,v1=…` signature header — and the connector
// has to satisfy it.
//
// ─── Where the boundary sits ──────────────────────────────────────────────
//
//   providers/     a party outside this app: a connector, and its stand-in
//   core/          the Junction wiring any app of this shape has — the client,
//                  the gate, the auth options, which channels a connection
//                  joins. Nothing in it is about shops, baskets or payroll
//   domain/        what this shop KNOWS, in modules — each a directory with an
//                  `index.ts` that IS its surface:
//
//                    payroll/   a real module: five files, a strict internal
//                               order, and exactly one edge leaving it (a pay
//                               run posts to the books)
//                    shop/      grouped by subject rather than by coupling —
//                               four of its five import nothing from each
//                               other, so the boundary is this door and not
//                               the arrangement
//                    billing/   closed, and a folder before it needs one
//                    ledger.ts  a FILE at the root, and that position is the
//                               statement: both modules post to it, so it
//                               belongs to neither. A `shared/` would have
//                               hidden that behind a word
//
// The line between the last two is what the file is ABOUT, not what it plugs
// into. `cart-claim.ts` is the `createApp({ principal })` seam, which is as
// Junction-shaped as anything in `core/` — and it is in `domain/` because what
// it resolves is a BASKET TOKEN, which only a shop has.
//
// `mail/mailer.ts` is the edge case worth stating: it implements junction's own
// `IMail`, so it is a framework contract AND the app's side of speaking to a
// mail provider. It is here rather than in `core/` because what it is FOR is
// the party — swap the target and the same file talks to Resend.
//
// This file exists to be read. Nothing imports it: each caller imports the
// provider it needs, so there is no barrel to keep in step and no import of a
// dev sink that a production build would have to shake out.

export {}
