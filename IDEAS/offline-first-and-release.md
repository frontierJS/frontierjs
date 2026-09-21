---
id: offline-first-and-release
status: proposed
dated: 2026-08-02
---

# Idea — Offline-first, portable, self-hostable: what it demands of Release

**Status: IDEA / VISION CONSTRAINTS. Nothing here is built.** Dated 2026-08-02.
Stated as project direction by the maintainer; the assessment of *current* state
below was probed against the tree (`VERIFYING.md`), and it is uniformly "absent."

---

## The vision, stated

FJS should be **offline-first**, **small and portable**, **FOSS**, and
**self-hostable**. These are not features to add later — they are constraints that
shape Deployment (Release) and bundling from the start.

## Where this stands today: re-probed, and it has moved

**Re-probed 2026-09-15, and the 2026-08-02 answer no longer holds.** Three of the
four parts `IDEAS/map-packages.md` listed as one offline engine have moved, and
**none of them moved for offline** — each was built to settle a different problem and landed
here as a side effect. A survey written in prose has no generator, so this one
goes stale the way the last one did; every claim below names the file it was read
from, so the next reader re-probes instead of trusting.

**Local gate and policy evaluation — shipped.** `packages/toolbelt/src/predicate/`
is the `.lite` expression language whole: tokenizer, parser, and an evaluator
answering a declared expression against one record in JavaScript, in SQLite's
three-valued logic and with SQLite's comparison rules. Beside it
`packages/toolbelt/src/gate/` is the access ladder and its grader. Both sit below
the dependency graph (`FJS-D26`), which is what makes them reachable from a
browser at all. **The safety argument is already paid for**, and it is the part
that would otherwise have had to be invented here: it is a MOVE rather than a
second implementation, and the two compilations of a row policy — into SQL and
into JavaScript — are held together by an oracle (`verifyRowPolicies`, and
`test/policy-interpreters.test.ts` asking both halves the same predicate over the
same rows). Drift between a server rule and its client copy is the failure mode
offline-first normally owns, and it now has an owner that is not this document.

**The mutation queue — half of it, and the half that was hard.** `FJS-D138` built
the client data lifecycle: a node per row keyed by Model, a list as a view over
it, and **optimism as an overlay of INTENT rather than of the resulting value**.
The ruling states the reason in its own words — a replay needs an intent to
replay — and names the boundary it declined to cross: re-executing a mutation in
the browser means the gate, the row policies and the validators in the browser,
*"which is the Homestead work … and not this ruling."* **That sentence has gone out of date in
one direction only.** The substrate it named as absent arrived six weeks later;
the ruling's own refusal still stands, because storing an intent is not replaying
one. `packages/toolbelt/src/match/` is the third piece, already written and
already shared with jetty: does this record still belong in this query's results,
with `null` meaning ask the server.

**The installable shell — refereed, not written.**
`packages/sierra/src/postbuild/manifest.js` grades whether a browser will install
a build, case for case against Chrome's own installability error ids. The app owns
`public/manifest.webmanifest`; Sierra owns the verdict. There is still no service
worker and no precache anywhere in `packages/sierra/src`, so the shell itself is
unwritten — but the floor under it has a referee rather than silence.

**Client-side SQLite, a conflict declaration, and the standalone binary — still
nothing.** No OPFS and no wa-sqlite; no sync or conflict attribute in
`packages/litestone/src/core/parser.js`; no `bun build --compile` path in `fli`.
`navigator.onLine` appears nowhere in `packages/junction/src/client/` or
`packages/sierra/src/junction/`, and `localStorage` still holds the auth token and
nothing else.

So: **less greenfield than it was, and greenfield where the work is.** What
arrived is the part that is hard to get right and cheap to get subtly wrong; what
remains is mostly labor. The status in the frontmatter stays `proposed` because
nothing in this document was built — the substrate came to meet it.

**And the shape of the remaining work changed with it.** Ruled 2026-09-15
(`FJS-D297`): there is no offline package. Offline is heading for the default and
nothing that is the default is severable, so it is core, and each piece goes to
the owner it already has — policy evaluation to `@frontierjs/toolbelt` where it
is, `@@sync` and a browser storage backend to Litestone, the queue and its replay
to Sierra beside `FJS-D138`'s intent overlay, and the carrying to Junction. The
body of work has a name, **Homestead**, and the name is a milestone rather than a
module: nothing imports it, no directory carries it, and it stops being said once
the pieces have landed.

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

### The engine's own questions have moved

Everything the client engine has to answer — the conflict vocabulary, what a
queue replays, which gate level grades a replayed write, whether a predicate
crosses to the browser, and what happens to a `File` in a queued write — is
`IDEAS/homestead.md`, together with the build order. What stays here is the
vision those answers serve, and the Release half, which is a different realm and
a different lifecycle.

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

This does not displace the framework-shape assessment (since deleted) item 1 (schema → UI). It
sharpens it: an offline-first form must render, validate, and gate-check with no
server reachable, which is the same seam — it just cannot be built as a
round-trip-to-validate shortcut. Build schema→UI with the offline constraint in
mind and it comes out right the first time; build it server-coupled and it gets
rewritten.

## See also

- `IDEAS/homestead.md` — **the engine and its build order**, lifted out of this paper
- `IDEAS/slices.md` — slices contributing to a release is the shared open question
- `PHILOSOPHY.md` — the axioms these constraints should be reconciled against
- `packages/jetty/` — the existing offline-shell + relay prior art
