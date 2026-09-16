---
id: homestead
status: proposed
dated: 2026-09-15
---

# Idea — Homestead: the offline engine, in the order it can be proved

**Status: PROPOSED.** Dated 2026-09-15. Nothing here is built. The name and the
decomposition are ruled (`FJS-D297`): offline-first is core rather than a
package, each piece goes to the owner it already has, and **Homestead names the
body of work and not a module** — nothing imports it and no directory carries it.

`IDEAS/offline-first-and-release.md` holds the vision this serves, the re-probed
survey of what already exists, and the Release half. This paper holds one thing:
**what the client engine has to answer, and the order the pieces can arrive in.**

---

## What Homestead is not

Release rides along in the vision paper and is a different body of work.
Artifact kinds, provisioning from declarations, the single binary and the byte
budget belong to `depot` (`IDEAS/package-map.md`, `IDEAS/deploy-plane.md`) and
are not phases here. The one place they touch is phase 4, which is where a byte
budget stops being rhetorical.

---

## The argument the phases rest on

### Sync, and where conflict policy lives

**Ruling needed: conflict resolution must be a schema concern.** If a Model cannot
declare something like `@@sync(lww)` / `@@conflict(...)` / "server wins" / "not
syncable", then every app hand-rolls merge logic — which is exactly the glue FJS
exists to eliminate. This is the one place where offline-first could quietly
betray the framework's own thesis, so it should be settled before anything is
built.

The vocabulary, the default, and the two questions a queue raises about
replay are forks rather than prose, and they are in § Open questions.

### Shipping gates to an untrusted client

Local gate enforcement means shipping the trust hierarchy and policy predicates to
the browser. It is *safe* — the server re-checks, that boundary does not move —
but it is **disclosure**: policy predicates can name columns and business rules,
and how much that costs differs per Model rather than per framework.

---

## The phases

**The order is set by one question asked at each step: what can be proved
without the next piece?** Most offline projects begin at phase 4 — the database
in the browser — and never ship, because nothing before it was usable on its
own. Here the value arrives at phase 1 and every phase after it is an
enlargement rather than a prerequisite.

### Phase 0 — a drive that can actually be offline

**Owner:** `example/web/test/`, plus two rows in `DRIVES.md`. **Size:** S.
**Ships:** no behavior. An instrument.

A drive that takes a real Chrome offline mid-session — CDP's
`Network.emulateNetworkConditions` with `offline: true`, the same harness
`example`'s drives already run through — writes while it is down, restores the
network, and then asks the SERVER what it holds. It asserts three things a stub
cannot: that nothing was lost, that the screen never claimed a write had landed
when it had not, and that the count on the server after reconnect is the count
the operator made.

**It is written before any offline code and it is expected to FAIL**, because a
write with no server is lost today. That failure is the negative control, and it
is the only evidence that the drive is measuring anything. It runs through
`preflight.mjs` for the same reason every other drive does: a readiness poll
answered by a process that never went away grades code that is not in the tree.

A test that stubs the transport proves nothing here — *fake clients hide real
bugs* is the house rule, and offline is the case it was written for.

### Phase 1 — declare it, and hold the write

**Owners:** Litestone (`@@sync`), Sierra (the queue). **Junction: nothing.**
**Answers:** Q1, Q2, Q3. **Size:** S + M.
**Ships:** an app that accepts writes with no server reachable.

Litestone gains `@@sync` and crosses it to the browser in the generated JSON
Schema, the way every other seed fact reaches a form. Sierra's store gains the
other half: a write that fails on a network error is retained as a pending
INTENT — the shape `FJS-D138` already chose and already stores — in durable
per-origin storage, drained in order on reconnect, with a refusal at replay
surfaced as a rejected item somebody can see and retry. A Model that declares no
`@@sync` refuses to queue and says so by name.

**Junction needs nothing, and that is the phase's sharpest claim.** A replayed
write is the same service call it always was, carrying the `Idempotency-Key`
`callService` already mints, which `claimIdempotency` already makes safe to
receive twice. A sync protocol here would be a second way to write, with a
second answer to who may write.

**Proved by:** phase 0's drive going green, negative control and all.

### Phase 2 — what the queue holds that is not a row

**Owners:** Sierra, with Litestone for minted ids. **Answers:** Q5. **Size:** M.
**Ships:** the shapes a real field application hits on day one.

Two halves, and they are the same problem: the queue holding something the
server has never seen.

- **Bytes.** A `File` in a queued write. The blob outlives the tab, the multipart
  request is built at drain rather than at capture, and a half-sent upload is
  either resumable or explicitly is not.
- **A write that depends on an unsent write.** Create a parent offline, then a
  child of it, before either has a server id. Either the client mints ids the
  server accepts, or the drain rewrites references as ids come back. This is
  where most queues break, and it breaks quietly.

**Proved by:** the drive extended to a capture shape — several records and
several photographs made entirely offline, reconnecting into a server that ends
up holding all of them, correctly related.

### Phase 3 — the shell, and a reload that survives

**Owner:** Sierra. **Size:** M.
**Ships:** open the app with no network and see what you had.

A service worker and a precached shell — the manifest already has a referee in
`postbuild/manifest.js`, so what is missing is the shell itself — and a node
store that hydrates from durable storage rather than from an empty page.
`matchesQuery` is what decides whether a cached list still contains a record,
and it is already written and already shared with jetty.

This is the first phase where the byte question in the vision paper starts
costing something real.

### Phase 4 — a database in the browser

**Owner:** Litestone, as a storage backend behind a dynamic import. **Size:** L
— the only large piece. **Ships:** arbitrary reads with no server.

OPFS or wa-sqlite under the same client, which is what makes *one engine on both
sides* a fact rather than a slogan: the same `.lite` schema, the same query API,
the same gates, evaluated by `@frontierjs/toolbelt/predicate` which is already
here. This is also `IDEAS/live-queries.md`'s stated destination — a live query
becomes a local query re-run, and the WebSocket matcher becomes an implementation
detail under an API that paper insists must not change shape to get here.

**Gate:** the byte budget has to be a number before this lands, not after. A
wasm database arriving with no stated budget is how the smallness property gets
traded for a feature.

### Phase 5 — two writers, one row

**Owners:** Litestone. **Answers:** Q4 in passing. **Size:** M–L.
**Ships:** conflict as a declared outcome rather than an accident.

Only meaningful once phase 4 exists: while the client can only WRITE offline, a
replayed write against a moved row is a refusal the server already knows how to
give. Once it can READ offline too, two people genuinely diverge, and `@@sync`'s
vocabulary gains teeth — the resolution runs at the Data boundary because the
policy was declared in the seed. Q4's disclosure question resolves here by
following the declaration rather than by adding one.

---

## Sequencing notes

- **Q1, Q2 and Q3 gate phase 1 and are decidable today** — they carry options and
  a recommendation, so they are waiting on a pick and not on work. Q5 gates phase
  2 and is not decidable yet: somebody has to find the choices first.
- **Phases 1 and 2 are the whole of a field-capture application.** A drive that
  scans, photographs and reconnects needs nothing from phases 3–5.
- **Nothing here blocks on the browser database.** That is the point of the order:
  phase 4 is the largest piece and the last one, and every phase before it stands
  up without it.
- **Each phase ends in a `DRIVES.md` row**, in both of its tables, the way every
  drive in this repo does.

---

## Open questions

- **Q1 — what does a Model declare about sync, and what does silence mean?** The
  argument above settles that conflict policy is a schema concern. What is open is
  the vocabulary and the default.
  - **A** — `@@sync(<policy>)` from a closed set, with no default: a Model that declares nothing is not syncable, and an offline client refuses to queue a write against it
  - **B** — every Model is syncable under a server-wins default, and `@@sync` exists only to widen that to last-write-wins or a manual merge
  - **Recommend A** — fail closed, the way the Data boundary already does for access (Invariant 6). Under B a Model nobody thought about loses a row with nothing said, which is the failure § V asks about last; under A the author says the word once, and the append-only Model that most field capture actually is says it in passing

- **Q2 — does the queue replay operations or rows?**
  - **A** — operations: the mutation's intent, replayed against whatever the server state is at replay time
  - **B** — rows: the resulting record, reconciled field by field against the server's copy
  - **Recommend A** — `FJS-D138` already chose it for the overlay and stated the reason, that a replay needs an intent to replay, so B would make the store hold two representations of one pending write. B also cannot express a compare-and-swap: `@@transitions` is one, and a row replay would trample a state machine that moved underneath it

- **Q3 — at replay, which gate level is a queued mutation graded against?**
  - **A** — the level the caller has at replay
  - **B** — the level they had when the mutation was queued, carried with it
  - **Recommend A** — the server re-checks on its own reading of the caller regardless (Invariant 6), so B is a fiction the boundary overrules anyway. What A costs is queued work that disappears, so this ruling only lands with its artifact attached: a mutation refused at replay is surfaced as a rejected item somebody can see and retry, never dropped silently

- **Q4 — does a policy predicate cross to the browser, and for which Models?** Today it
  does not, and nobody ruled that: `x-litestone-write-policy` crosses as a boolean
  `true` and never the expression (`packages/litestone/src/jsonschema.js`), which is
  enough for a form to disable a control and not enough to evaluate anything
  offline.
  - **A** — the predicate text crosses for every Model, since the server re-checks and the disclosure is mostly of rules a determined reader could infer from the UI
  - **B** — the boolean stays the default and shipping the predicate is something a Model opts into
  - **Recommend B** — strictness follows cost (§ IV), and the cost differs per Model, because a predicate can name a column whose reader was never meant to know it exists. It should not become a second declaration, though: a Model that declares `@@sync` has already said it will be evaluated with no server reachable, which is the same statement, so the disclosure follows from the sync declaration and nothing new is coined

- **Q5 — what happens to a `File` column in a queued mutation?** Genuinely open, and the
  roster this work was decomposed from does not reach it — client SQLite, a queue,
  local gates and a conflict policy are all rows.
  A queued write carrying bytes is a different object: the blob has to live
  somewhere a tab can be closed and reopened over, the multipart request is built
  at replay rather than at capture, and a half-sent upload is resumable in a way a
  row is not. Somebody has to find the choices before this is a fork.

## See also

- `IDEAS/offline-first-and-release.md` — the vision, the re-probed survey, and the Release half
- `DECISIONS.md` § `FJS-D297` — why there is no offline package, and what Homestead names
- `DECISIONS.md` § `FJS-D138` — the client data lifecycle; the intent overlay phase 1 builds on
- `IDEAS/live-queries.md` — the live-query surface phase 4 is the destination of
- `IDEAS/package-map.md` — the roster row this work was decomposed out of
