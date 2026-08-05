# Idea — Offline-first, portable, self-hostable: what it demands of Release

**Status: IDEA / VISION CONSTRAINTS. Nothing here is built.** Dated 2026-08-02.
Stated as project direction by the maintainer; the assessment of *current* state
below was probed against the tree (`VERIFYING.md`), and it is uniformly "absent."

---

## The vision, stated

FJS should be **offline-first**, **small and portable**, **FOSS**, and
**self-hostable**. These are not features to add later — they are constraints that
shape Deployment (Release) and bundling from the start.

## Where this stands today: nothing

Probed 2026-08-02, all negative:

- No service worker, PWA manifest, precache, or workbox anywhere in
  `packages/sierra/src` or `packages/cli/commands`.
- No client-side cache, no mutation queue, no `navigator.onLine` handling in
  `packages/sierra/src/junction/index.js` or `packages/junction/src/client/`.
  `localStorage` is used only to hold the auth token.
- No `bun build --compile` / standalone-binary path in `fli`.
- The string `offline` occurs once in the whole UI stack, at
  `packages/sierra/src/junction/index.js:56` — a WebSocket status label in a doc
  comment.

Greenfield. But the substrate is unusually well-suited, which is the point.

---

## Why FJS is positioned for this better than the alternatives

**1. One database engine on both sides. This is the whole thing.**
The hardest problem in offline-first is that the server DB and the client DB are
different engines with different query semantics, so you end up maintaining two
query languages, two validation paths, and two authorization models that drift.
Litestone is SQLite. The same `.lite` schema, the same client API, and the same
gates can run in the browser (OPFS / wa-sqlite) and on the server. Prisma cannot
do this. Drizzle half-can. **FJS gets it as a consequence of a choice already
made.**

**2. Authorization is declared, so it can be enforced locally.**
Gates and policies live in the schema, not in handlers. An offline client can
evaluate them before queueing a mutation — the user is told "you can't do that"
immediately, with no round trip — and the server re-checks on sync. That story is
only available to a framework whose authz is in the seed.

**3. The pieces are already small and dependency-light.**
Mesa is a true leaf with zero workspace deps. The css package has no build step —
plain CSS ships as-is. Bun compiles to a single binary. A FJS app as *one
executable plus one `.db` file* is a literal possibility, and it is the cleanest
imaginable self-hosting story.

**4. jetty already proves the offline shell.**
A browser-extension container running Mesa UI with a service-worker relay to
Junction is structurally the same thing as an offline-capable web app. The pattern
exists in one package and has never been generalized.

**5. Conduit is an auditability asset.**
Self-hosters and FOSS users want to know what an app phones home to. Conduit's
declared-target model means every outbound call is enumerable *by design* — a
`fli` command could print the complete outbound surface of an app. Very few
frameworks can answer that question at all.

---

## What the design has to answer

### Sync, and where conflict policy lives

**Ruling needed: conflict resolution must be a schema concern.** If a Model cannot
declare something like `@@sync(lww)` / `@@conflict(...)` / "server wins" / "not
syncable", then every app hand-rolls merge logic — which is exactly the glue FJS
exists to eliminate. This is the one place where offline-first could quietly
betray the framework's own thesis, so it should be settled before anything is
built.

Related, unanswered: does the mutation queue replay *operations* or *rows*? Do
gates re-evaluate at replay time against the level the user has **then**, or the
level they had when queueing? (Latter is surprising; former can silently drop
queued work — either way it needs to be a documented ruling, not an accident.)

### Shipping gates to an untrusted client

Local gate enforcement means shipping the trust hierarchy and policy predicates to
the browser. It is *safe* — the server re-checks, that boundary does not move —
but it is **disclosure**: policy predicates can name columns and business rules.
Needs an explicit ruling, plus probably a per-Model opt-out, rather than a silent
default.

### Release artifacts

Deployment is the realm with no package and no primitives. Offline-first and
self-hosting turn that from a gap into a blocker, because they imply *distinct
artifact kinds* rather than one deploy command:

- **single binary** — Bun `--compile`, app + runtime in one file, `.db` beside it
- **container** — the conventional self-host path
- **static + API** — Sierra's `static` target (implemented 2026-08-02) plus a
  Junction host
- **offline-capable PWA** — service worker, precached shell, local SQLite, sync

A Slice (`IDEAS/slices.md`) should be able to contribute to a release — migrations,
secrets, ports — which is the open question that document already raised. These
two ideas meet here.

### Provisioning from declarations, and the tension it creates

Added 2026-08-03, from the Encore comparison in `IDEAS/operational-edge.md`.

FJS apps already declare their infrastructure — databases via `schema.lite` and
`@@db(name)`, queues and cron via Caravan, egress via Conduit targets, realtime via
`channel:`, secrets via `.env.example` — and `fli project:map --json` already
collects most of it. Nothing reads that and provisions anything.

An Encore-style "provision from declarations" step would land naturally on
primitives that already exist. **But it pulls against this document's whole
direction**, and the tension should be settled rather than discovered later:

- Provisioning assumes cloud resources to create. The single-binary target assumes
  there is nothing to create.
- **Constraint:** provisioning must degrade to nothing. The SQLite-and-one-file path
  stays the shortest one. If `fli deploy` grows a provisioner and the portable path
  becomes the special case, the framework has traded its best property for a
  competitor's.
- The reconciliation is probably per-artifact-kind: a single binary needs no
  provisioner; a container needs volumes and secrets; a multi-node deployment needs
  the full set. That is another argument for artifact kinds being first-class here.

Preview environments are the strongest argument *for* provisioning — nobody
hand-configures a throwaway environment — and they are also where the offline-first
story is least relevant. That asymmetry is a useful guide to where the line falls.

### A byte budget

"Small and portable" is unfalsifiable without a number. What is the target for
Mesa runtime + Sierra router + client + css on a first paint? Pick it, measure it
in CI, and let it fail the build. A stated budget is also the strongest possible
argument against dependency creep — it makes "keep mesa a true leaf" enforceable
instead of aspirational.

### FOSS / self-hosting hygiene

- License chosen and applied consistently across all twelve packages.
- No required SaaS in any 80% path; no phone-home by default.
- `fli` command that prints an app's complete outbound surface, from Conduit's
  declared targets — a genuinely differentiating trust feature.
- Everything installable and runnable without an account.

---

## Ordering note

This does not displace `IDEAS/framework-shape.md` item 1 (schema → UI). It
sharpens it: an offline-first form must render, validate, and gate-check with no
server reachable, which is the same seam — it just cannot be built as a
round-trip-to-validate shortcut. Build schema→UI with the offline constraint in
mind and it comes out right the first time; build it server-coupled and it gets
rewritten.

## See also

- `IDEAS/framework-shape.md` — the realm-by-realm gap assessment; Release is #3 there
- `IDEAS/slices.md` — slices contributing to a release is the shared open question
- `PHILOSOPHY.md` — the axioms these constraints should be reconciled against
- `packages/jetty/` — the existing offline-shell + relay prior art
