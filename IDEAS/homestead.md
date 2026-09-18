---
id: homestead
status: partial
dated: 2026-09-16
---

# Idea — Homestead: the offline engine, in the order it can be proved

**Status: PHASES 0 TO 3 BUILT; 4 PART-BUILT (the budget, the seams, the browser client, the `@@sync` vocabulary, the schema a device gets, the declared read, and the local database); 5 PROPOSED.** Dated 2026-09-16. The name and the
decomposition are ruled (`FJS-D297`): offline-first is core rather than a
package, each piece goes to the owner it already has, and **Homestead names the
body of work and not a module** — nothing imports it and no directory carries it.

`IDEAS/offline-first-and-release.md` holds the vision this serves, the re-probed
survey of what already exists, and the Release half. This paper holds three:
**what the client engine has to answer, the order the pieces can arrive in, and
the feature in `example/` that proves each one.**

---

## What Homestead is not

Release rides along in the vision paper and is a different body of work.
Artifact kinds, provisioning from declarations, the single binary and the byte
budget belong to `depot` (`IDEAS/package-map.md`, `IDEAS/deploy-plane.md`) and
are not phases here. The one place they touch is phase 4, which is where a byte
budget stops being rhetorical.

---

## Where it gets built: the shop's stocktake

**No second example application.** Every phase below is proved in `example/`,
against a feature the shop was missing anyway: **a stocktake**. Somebody walks
the stockroom with a phone, scans a shelf label, records what is actually on the
shelf, photographs anything damaged, and the session reconciles into the ledger
that is already there.

It is not a contrivance chosen to suit offline. A stockroom is the canonical
place with no signal, which is why every retail stocktake application is
offline-first, and the shop already carries the half that is genuinely hard:
`ProductVariant.stock` is ON HAND, availability is on-hand less unexpired
`StockReservation`s, and every write to `stock` is paired with an
`InventoryMovement` in one transaction — all of it already driven by
`verify:stock`. What a counted number MEANS is therefore already modeled and
already proved. What is missing is the counting.

**Two models, and deliberately not a third.**

- `StockCount` — one session. `@@transitions(status, open -> counted -> applied)`, so a count that was never applied cannot pretend it was.
- `StockCountLine` — a variant, a counted quantity, an optional `File` for damage, and a `countedAt` the SERVER stamps.

**No bin or location model.** The set a counter is working through derives from
the variants that hold stock, so *what have I not counted yet* costs nothing to
answer and no new noun to ask. A location model is a real enlargement for a shop
with one SKU in two places, and it is deferred rather than forgotten — the reason
it is written here is so nobody completes the set on the way past.

### Why the stocktake exercises all five phases and not just the first two

This is what a bespoke capture app would not have done.

- **Phase 1** — a count line is append-only, so it needs no conflict policy at all. That is exactly the shape Q1's recommendation produces: a Model that declares `@@sync` and never has to merge.
- **Phase 2** — both halves arise on their own rather than being staged. The damage photograph is a `File` in a queued write, and the session is created offline with its lines attaching to a parent the server has never seen, which is the dependent-write case exactly.
- **Phase 3** — the counter's phone sleeps, or the tab is closed in the stockroom. Reopening offline has to show the session still in progress, or the feature is a toy.
- **Phase 4** — *which variants have I not counted* is a QUERY. Against a local database it is the checklist re-running itself, which is what `IDEAS/live-queries.md` says the destination looks like.
- **Phase 5** — two staff counting one stockroom is an ordinary Tuesday, and two counts of one variant in one session is a real conflict with a real policy choice behind it. Approach it as a question rather than a plan: ElectricSQL built bidirectional CRDT sync and abandoned it (`IDEAS/prior-art.md` § 4).

### What proves it

`verify:offline`, a drive of its own rather than an enlargement of
`verify:stock` — the same shelf, a different question. Named for the engine
rather than for the feature, because the feature is what it drives and the
engine is what it proves. It has a row in both of `DRIVES.md`'s tables and it
grows one assertion per phase rather than arriving whole. **Phase 0 of it is
built** (11 assertions, green).

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

### Phase 0 — the harness learns to go offline

**Owner:** `example/web/test/lib/`. **Size:** S. **BUILT.**
**Ships:** no behavior. An instrument, and the reading it takes today.

The shared CDP harness gains one capability: put a real Chrome offline for the
duration of a block and put it back. Beside it, a negative control: write while
the network is down, restore it, ask the SERVER what it holds, and assert the
write is **gone**.

**Built. 21 assertions, green — and it corrected this plan twice, the first
time wrongly.**

**A write made offline is lost.** There is no retry anywhere in the client, and
the queue phase 1 adds is the first thing that will hold one.

Getting to that took two wrong conclusions from one flawed instrument.
`Network.emulateNetworkConditions` refuses new connections and carries frames on
a socket that is already open, so the first reading showed the write arriving by
itself when the network returned — which was written up here as *the client
retries, so phase 1 extends it*. It was the client's WebSocket, same-origin in
dev because the dev server proxies `/api` and `/ws`; the harness severed sockets
by ORIGIN to spare vite's HMR channel, and so skipped the only socket that
mattered and reported nothing to cut. Vite's socket is told apart by its
subprotocol, `vite-hmr`, and never by where it points.

**What survives is the third reading, and it is a requirement.** With the socket
left open the outage is MASKED: the call goes out, arrives when the network
returns, and the screen is never told anything was wrong. So a queue entry
clears on an **acknowledgement** and never on a send — Replicache's
`lastMutationID` is the same mechanism under a different name
(`IDEAS/prior-art.md` § 4). A write that left on a socket nobody has confirmed
is not delivered.

**What phase 1 still inherits.** Severing is harsher than a real outage, which
is exactly the masked reading above; both are asserted rather than chosen
between. *What counts as a write that failed* is a question the queue answers
for both transports.

**The loss assertion passes today, and it is supposed to.** It is the only
evidence the instrument measures anything at all, and phase 1 is the commit that
inverts it. It is paired with the same submit made with the network UP, because
*lost* and *never attempted* are one reading otherwise — a selector that stopped
matching would leave the ledger unchanged and the control would pass while
proving nothing. Getting that pairing right cost more than the capability did:
the first version took one off the same shelf every run until the service
refused it with `has 0 on hand`, which reads exactly like a lost write. It runs behind `preflight.mjs` for the reason every drive here does: a
readiness poll answered by a process that never went away grades code that is
not in the tree.

A test that stubs the transport proves nothing here — *fake clients hide real
bugs* is the house rule, and offline is the case it was written for — and the
WebSocket finding above is what it caught on its first run, which a stubbed
transport could not have.

### Phase 1 — declare it, and hold the write

**Owners:** Litestone (`@@sync`), Sierra (the queue), Junction (one call option). **BUILT.**
**Implements:** `FJS-D298` (declare it), `FJS-D299` (replay intent), `FJS-D300` (grade at replay, and surface the refusal). **Size:** S + M.
**Ships:** an app that accepts writes with no server reachable.

Litestone gains `@@sync` and crosses it to the browser in the generated JSON
Schema, the way every other seed fact reaches a form. Sierra's store gains the
other half, and phase 0 narrowed what that half is: **nothing holds a write that
could not be sent, so this is the first thing that will.** A write that fails is
retained as a pending INTENT — the shape
`FJS-D138` already chose and already stores — in durable per-origin storage, so
it survives the document; drained in order on reconnect; with a refusal at
replay surfaced as a rejected item somebody can see and retry. A Model that
declares no `@@sync` refuses to queue and says so by name.

**Queue-first, and there is nothing to graft onto.** `verify:offline` measured
that a write made offline is simply lost, so this is not a retry being extended.
Prior art says build it as one path (`IDEAS/prior-art.md` § 4): PowerSync records
the write and its queue entry in one transaction, and sending is that queue
draining, so there is no second route where a write goes twice or not at all.
The FJS version of *one transaction* is the optimistic overlay `FJS-D138`
already keeps — the intent is recorded where the screen reads it, or the screen
and the queue can disagree about what is pending.

**And the entry clears on an acknowledgement, never on a send.** That is phase
0's third reading made into a rule: a call can leave on a socket that has not
noticed the network is gone, and treating *sent* as *done* loses exactly the
writes an outage produces.

**No sync protocol, and that is the phase's sharpest claim.** A replayed write
is the same service call it always was, made safe to receive twice by the
`Idempotency-Key` `claimIdempotency` already reads. A sync protocol here would
be a second way to write, with a second answer to who may write.

**What junction owed was one call option, and the plan had said it owed
nothing.** The key was minted per REQUEST on the server, so two sends of one
held write were two keys and the protection did not reach the case it exists
for. The browser client had no way to state a key at all. It now takes one as a
third argument — `create(data, params?, { idempotencyKey })`, the same on
`patch`, `remove`, `restore`, `invoke` and `call`, both transports — rather than
ambiently, because an ambient key in a page with several writes in flight is a
key landing on the wrong one. **No application passes it.** The resource layer
mints it off `x-sync` and the queue entry's own primary key, which is why the
declaration stays in the schema and the call sites stay as they were.

**Proved, and phase 0's two `LOST` lines inverted in the same commit** — which
is the evidence that the phase did the thing rather than that the assertion
moved. A correction made with the socket severed now arrives once the network
returns; one made in a page that then navigated away with the network still down
arrives too, and that second one is the assertion an in-memory queue cannot
pass. `example`'s `InventoryMovement` declares `@@sync(server)` and is the first
model in the repo to.

**One thing the build found that the plan had not asked.** The queue lives in
the resource layer, so `getClient().service(x)` — the raw client, which
`example`'s own inventory screen was using — gets none of it, and the drive kept
reporting a loss with the feature already built. That is a capability line
rather than a preference: a replay has to send the POST-HOOK payload, and the
raw client has no hooks, no field rules and no version knowledge to produce one.
Worth a `fli check` rule later, because today it is silent: a screen calling the
raw client on a model that declares `@@sync` has opted out of the queue without
saying so.

### Phase 2 — what the queue holds that is not a row

**Owners:** Sierra, Litestone, Toolbelt. **Answers:** Q5 (`FJS-D301`). **Size:** M.
**Ships:** the shapes a real field application hits on day one.
**BUILT, both halves.**

Two halves, and they are the same problem: the queue holding something the
server has never seen.

- **Bytes.** A `File` in a queued write. The field has converged here and FJS is
  already shaped for it (`IDEAS/prior-art.md` § 4): metadata goes through the
  ordinary queue, the bytes go to object storage, and attachments get a queue of
  their OWN — its own local table, its own retry interval, immutable objects
  named by an id the client minted. A `File` column already stores a reference
  and `FileStorage` already owns the bytes, so what is added is the second queue
  and not a new idea about what a file is.
- **A write that depends on an unsent write.** Create a parent offline, then a
  child of it, before either has a server id. Either the client mints ids the
  server accepts, or the drain rewrites references as ids come back. This is
  where most queues break, and it breaks quietly.

**Proved by:** `verify:offline` extended — a sheet and its counts all made with
the network down and none of them known to the server, reconnecting into a
server that ends up holding every one of them, correctly related. The bytes half
adds the damage photograph, with its bytes decoded in an `<img>`, which is the
assertion `verify:catalog` already proves is the only honest one.

**Built, and the shape is `/stocktake/` in `example`.** `StocktakeSheet` and
`StocktakeCount` both declare `String @id @default(uuid())` beside
`@@sync(server)`; litestone crosses `x-mint` as `{ field, kind }`; sierra states
the key on the create; the generators moved to `@frontierjs/toolbelt/ids`
because a browser cannot import litestone and three fillers cannot each own the
answer. `verify:offline` is 38 assertions and the new ones are about the
REFERENCE rather than about arrival: the id on screen with no server reachable
is the id the server ends up holding, and every count names it.

**The ruling that made it small.** Only ONE declaration widens the create
surface, and it is one already made: `@@sync` says the rows may be written with
no server reachable, and being able to NAME such a row is the same statement.
So there is no second attribute, the id stays optional, and a create made on the
network omits it exactly as before.

**Two things the build found that the plan had not asked.**

The first is that minting has to happen on EVERY create rather than on one that
turns out to be held. A screen cannot know whether its parent reached the server
before it needs the parent's id, so an id whose origin depends on the network is
an id that is sometimes there and sometimes not.

The second is that a held write has to CARRY what was held. The thrown error
said *queued* and named the queue entry's key; for a create on a minting model
the row itself is the only copy anywhere, and a screen whose next act references
it had nowhere to read the key from. `err.data` is now the row.

**The bytes are built too, as `FJS-D301` ruled: two queues.**
`sierra/junction/attachments.js` has its own IndexedDB database — a blob store
is what fills a device's quota, and a quota failure must not take the writes
down with it — its own retry, and objects immutable once named. A held write is
split: the row replays without its bytes, each file replays after it as a patch
naming the row. **Nothing new crosses the wire**: that patch is the multipart
call the client already made and `FileStorage` already consumes, so there is no
upload endpoint and no pending-file value in the column, which is the same
argument phase 1 made for having no sync protocol. **On a working network it is
still one call** — the entry is written before the send and settled by the same
acknowledgement.

The reference the ruling asked for turned out to be the ROW's key rather than a
new noun, which is why this half needed phase 2's first half first: an
attachment names a row that has to exist, so a model whose key only the server
assigns cannot hold one, and `sync-file-with-no-key-to-attach-to` says so at
schema time. Its sibling `sync-required-file` says the other half — the row
replays WITHOUT its bytes, so a required `File` arrives empty and is refused.

**And a third thing the build found.** A `@@sync` model carrying a `File` needs
`patch` on its SERVICE, because that is the verb the bytes arrive on.
`stocktake-counts` was declared append-only, which is right about counts and
wrong about their photographs: every second half came back 405 and the file sat
in the device's queue with nothing saying why. That is `fli check`'s question
rather than the advisor's — it is the layer that can see a service and a schema
at once — and it joins the raw-client rule phase 1 owed.

### Phase 3 — the shell, and a reload that survives

**Owner:** Sierra. **Size:** M. **BUILT.**
**Ships:** open the app with no network and see what you had.

A service worker and a precached shell — the manifest already has a referee in
`postbuild/manifest.js`, so what is missing is the shell itself — and a node
store that hydrates from durable storage rather than from an empty page.
`matchesQuery` is what decides whether a cached list still contains a record,
and it is already written and already shared with jetty.

This is the first phase where the byte question in the vision paper starts
costing something real.

**Built, and it is three pieces rather than the two the plan named.**
`postbuild/offline-shell.js` writes `sw.js` from what the build emitted —
opt-in with `offline: true`, and Sierra writes it where the app writes its
manifest because a manifest is a DECLARATION and a precache list is a
DERIVATION. It answers for a precached file and for a navigation and touches
nothing else, so `/api` and `/ws` are not in its path; `junction/list-cache.js`
answers a load that could not arrive with the last list that question got, only
for a model that declared `@@sync`, only on SILENCE and never on a refusal. The
byte question is now a number the build prints: `example` is **89 files, 980
kB**.

**The third piece the plan had not asked for, and it is the one without which
neither of the others is visible: the SESSION.** `refresh()` asks the server who
the token is, and with no server it answered *nobody* — so an app that opened
offline opened signed OUT, every gated screen said "administrators only", and
the drive read an empty inventory page with a full cache behind it. The last
resolved session is now kept and restored when the question could not be asked,
which is safe for exactly the reason `x-gate` is an affordance (Invariant 6).

**And a design the drive overturned.** The generated worker did not call
`skipWaiting`, on the reasoning that a running page holds module references into
the cache activating would sweep. Without it a new worker waits for every tab it
would replace to CLOSE — a navigation in the same tab does not release control —
so a phone with the app open for a week never sees a release, which for an app
whose promise is *works offline* is the wrong failure. The hazard it was
guarding against is not new: a page asking for a chunk the deploy removed fails
with or without a worker, and `x-fjs-build` is already the mechanism for it.

**Proved by:** `verify:shell`, 23 assertions, a new drive — separate from
`verify:offline` because a service worker exists only in a build and registering
one against the dev server would fight vite's HMR. Its sharpest assertion is the
negative one: with the network down, a request under `/api` must FAIL.

### Phase 4 — a database in the browser

**Owner:** Litestone, as a storage backend behind a dynamic import. **Size:** L
— the only large piece. **Ships:** arbitrary reads with no server.

OPFS or wa-sqlite under the same client, which is what makes *one engine on both
sides* a fact rather than a slogan: the same `.lite` schema, the same query API,
the same gates, evaluated by `@frontierjs/toolbelt/predicate` which is already
here. This is also `IDEAS/live-queries.md`'s stated destination — a live query
becomes a local query re-run, and the WebSocket matcher becomes an implementation
detail under an API that paper insists must not change shape to get here.

**Gate, and it is now a ruling rather than an intention** (`FJS-D302`): the
budget is a ceiling with a baseline that ratchets down only, the way
`scripts/typecheck-baselines.json` already works. **Built**: sierra's postbuild
weighs the shell as a server would send it, grades it against
`offline-baseline.json` in the surface root, and FAILS a build that grew.
`FJS_OFFLINE_BASELINE=update` is the deliberate act.

#### What it actually weighs — measured 2026-09-16, `wa-sqlite@1.0.0`

Per file and summed, the way a CDN compresses each response. A concatenation
compresses better than the thing it stands for, by the exact amount nobody would
notice.

| | raw | gzip | **brotli** |
| --- | ---: | ---: | ---: |
| `example`'s shell today | 982 kB | 317 kB | **276 kB** |
| sync build + `AccessHandlePoolVFS` (OPFS) | 643 kB | 294 kB | **254 kB** |
| async build + `OriginPrivateFileSystemVFS` | 1216 kB | 434 kB | **349 kB** |
| async build + `IDBBatchAtomicVFS` | 1238 kB | 439 kB | **353 kB** |

**Three things this changes.**

**The number quoted when Q7 was ruled was wrong by a factor of four.** *~1.2MB
of wasm* is the RAW size of the asyncify build, which is the one the OPFS path
does not need. The engine an app would actually ship is **254 kB over the
wire** — smaller than the shell `example` already serves.

**The VFS costs more than a third of the engine.** `AccessHandlePoolVFS` uses
OPFS's SYNCHRONOUS access handles and runs on the plain build; the async VFSs
need asyncify, which is 100 kB brotli of stack-switching machinery. So the VFS
is a byte decision and not only a correctness one, and the sync pool is the
default to reach for.

**The engine does not stay out of the shell.** A dynamic import keeps it off the
first visit, but an app that reads offline must have it cached BEFORE the
network goes — so it joins the precache list, and `example`'s baseline would go
from 276 kB to about 530 kB. That is the budget doing its job: the doubling is
visible, deliberate and recorded in a file, rather than discovered by somebody
on a train.

**And the engine is ruled** (`FJS-D305`), though not the package the ruling
names — see below. The work the plan did not name is the seam: `bun:sqlite` was
imported in **ten files** under `packages/litestone/src/`, so there was nothing
to swap into. `src/drivers/` is a per-MODEL storage driver (jsonl) and not an
engine abstraction.

#### The seam — BUILT

`src/core/engine.js` is the one owner of *what a SQL engine is*.
`openDatabase(path, opts)` is the only way to get a connection,
`src/engines/bun-sqlite.js` is the only file that names `bun:sqlite`, and
`test/engine-seam.test.ts` asserts that the count is one rather than asking a
reader to keep a convention. Which engine is present resolves by CONDITION —
`#sql-engine`, a subpath import in litestone's own `package.json` — so no entry
point has to remember a registration line.

**The contract is synchronous, and that decided the engine.** `.get()` and
`.all()` are called from roughly 270 sites inside `core/client.js` alone, none
of which await. `wa-sqlite`'s API is `async` on every path in BOTH builds —
`sqlite3.step` is declared `async function` — so it would hand back a pending
Promise where a row belongs: truthy, object-shaped, thrown by nothing, and a
filter that stops filtering. SQLite's own build exposes a SYNCHRONOUS `oo1` API
over the `opfs-sahpool` VFS and is the one the seam is built for. It costs
more — **489 kB brotli as published, against wa-sqlite's 254 kB** — and that
difference is the price of an engine litestone can drive at all, which the
measurement above could not see because it weighed bytes and not API shape.

**What the seam turned out to be worth is larger than the swap.** Spawned under
`node --conditions=browser`, with no `Bun` global and no `bun:sqlite`, a real
client registered `node:sqlite` from the outside and ran relations, includes,
`groupBy`, aggregates, a transaction, a soft delete, an ordered limit and a gate
refusal — unchanged, all nine passing. So *one engine on both sides* is now a
thing a test does rather than a sentence, and the remaining distance to a
browser is the VFS and the wasm, not the query engine.

#### The browser — BUILT

`src/browser/worker.js` runs the whole client in a dedicated worker;
`src/browser/client.js` is the page's proxy over it. The round trip hides inside
the `await` the model API has always required, so `core/client.js` did not
change to get here.

**The sync/async problem is not solved, it is MOVED** — to the one boundary that
was already asynchronous. Three places it could have lived: inside the query
internals (~270 un-awaited sites, where a missed one answers a pending Promise
that reads as a row and throws nothing); at the model API, which is already
`async` and therefore free; and at a worker's `postMessage`, which is async by
construction. The last two are the same boundary, and that is the whole design.
A worker was not optional anyway — SQLite's own package states that *only the
worker versions allow you to use the origin private file system*, so a
main-thread build persists nothing. The synchronous `oo1` API is what makes the
worker cheap rather than a rewrite.

**`#host` was the seam the engine seam revealed.** Ten modules in the client's
graph imported nine node builtins; a browser has none of them. They go through
`#host` now, resolved by condition like `#sql-engine`: paths implemented, the
filesystem refused by name, and `@encrypted` refused on purpose, because
decrypting on a device means the key is on the device.

**One call at a time, and it is load-bearing.** The browser's
`AsyncLocalStorage` is a single slot, so two overlapping calls would restore
each other's store — a table answering as the wrong principal, silently, with
rows. The worker serializes, which is the shim's proof obligation rather than
throughput caution.

**`$transaction` is refused on a browser client.** The callback runs on the
page, so the lock would be held across main-thread turns. Phase 4 ships READS
with no server; an offline write is the pending queue's job (`FJS-D301`), and a
local write that needs atomicity is phase 5's question.

`bun run test:browser` is the drive: relations, a where clause, `groupBy`, an
ordered limit, a gate refusal that keeps its `code` across `structuredClone`,
and a SECOND page load reading the rows the first one wrote. Fourteen
assertions, in a real Chrome over real OPFS.

#### What it weighs, measured after building it

Brotli, per file, the way a CDN sends each response.

| | raw | **brotli** |
| --- | ---: | ---: |
| litestone's client, bundled for a browser and minified | 1047 kB | **236 kB** |
| `sqlite3.wasm` | 869 kB | **349 kB** |
| `index.mjs`, SQLite's JS API | 643 kB | **141 kB** |
| **total** | **2559 kB** | **726 kB** |

**This corrects the estimate made when the seam was built.** *The baseline goes
from 276 kB to about 530 kB* counted the engine and forgot that litestone's own
client has to go to the device with it — 236 kB of parser, query builder, gates
and policies. `example`'s shell would go from 276 kB to roughly **1002 kB**,
which is not a doubling but three and a half times, and it is exactly the number
`FJS-D302`'s ratchet exists to put in front of somebody before it ships.

**The obvious saving is the 141 kB of glue and it is not free to take.**
`index.mjs` carries the Worker1 API, the Promiser, `kvvfs` and the OPFS async
proxy, none of which this path uses — but it arrives through a runtime
`import(url)` so no bundler tree-shakes it, and a custom build is a build step
this package does not have. Worth doing before an app pays for it; not worth
guessing at now.

#### The prerequisite hydration has, measured 2026-09-16

Timed in Chrome against the drive's own build, 200 rows each way.

| | per row |
| --- | ---: |
| `bun:sqlite`, on a server | 0.05 ms |
| OPFS, 200 inserts inside ONE `BEGIN`/`COMMIT` | **0.056 ms** |
| OPFS, one insert per call | **9.23 ms** |
| a bare worker round trip, doing nothing | 0.18 ms |

**Two things everybody guesses wrong about this, including the first draft of
this paragraph.**

**The engine is not slow.** Inside a transaction, SQLite over OPFS writes at the
same speed as `bun:sqlite` on a server — 0.056 against 0.05 ms. There is no wasm
tax on the write path worth naming.

**And the worker boundary is not the cost either.** A round trip is 0.18 ms, 2%
of an unbatched create. Batching to save messages would buy almost nothing.

What costs 165× is **one durable commit per row**: an autocommit INSERT is an
OPFS sync, and 200 of them is 200 syncs. So hydrating 5,000 rows is **46 seconds
row-at-a-time and 0.3 seconds inside one transaction**, and that difference is
not an optimization — it is whether the feature exists.

**Which makes a worker-side transaction the prerequisite for every option in
`FJS-D307`, and litestone has had the verb all along.** `$transaction` is
refused here — it takes a callback, the callback runs on the page, and the lock
cannot be held across main-thread turns. But `createMany` and `upsertMany` carry
their rows in ONE call, and they already cross the worker boundary through the
ordinary proxy with nothing written: **2,000 rows in 67 ms, 0.033 ms each**, and
`upsertMany` moves 500 existing rows in 45 ms without adding one. Batched, the
browser matches `bun:sqlite` on a server.

This was written down as an owed prerequisite and it was not owed at all. What it
needed was measuring, and the measurement is now two rows of the drive — with a
budget 45× the observed time, so it fails if the batching stops rather than if
the machine is slow.

#### The schema a device gets — the next real decision

`createClient({ parsed })` has always accepted a parse result instead of `.lite`
text, and the browser client takes one now: it crosses as JSON, which is strictly
weaker than the structuredClone the worker uses, and drives the same client
(asserted in the drive).

That matters because **shipping the app's `.lite` source is not an option**. It
would undo the prose stripping `FJS-D204` measured at 23 kB, and hand a device
every model in the app. So what a device gets is a FILTER over the parsed tree —
the `@@sync` models plus what they reference — which cannot accidentally carry a
comment or a model, because both are decided by what it copies rather than by
what it remembers to leave out.

**Built, as `litestone/src/device-schema.js`.** It was written down here as
sierra's and it is not: knowing what a parsed tree holds — which node kinds
exist, which references a field can make, which attribute names a database — is
litestone's, and sierra reads `models[].name` and nothing deeper on purpose.
Sierra CALLS it, through the dynamic import its schema plugin already makes.
Over `example`, 53 models become 3 and 224 kB become 4.5.

Three things it settled that were written here as open. **The opt-in `FJS-D303`
requires IS the `@@sync` declaration**, so a kept model's policies cross with it
and there is no second attribute to coin — the ruling says so and this is the
reading it forces. **A relation to a model the device does not get comes out and
its foreign key stays**, because `ddl.js` writes a `FOREIGN KEY … REFERENCES` out
of a relation and SQLite accepts a CREATE TABLE naming a missing table, then
fails every INSERT against it. And **the `database` blocks come out**: `db:`
overrides a declared `main` and nothing else, so `database audit { driver
logger }` would send a device at `./db/audit/`, a fleet-wide file on a server.

Every cut is graded `lost` / `changed` / `noted` — `litestone import`'s
vocabulary for the other direction — and the proof is that the result BOOTS:
27 unit tests through a JSON round trip, and in Chrome over OPFS the same
filtered schema opens, a stocktake is counted and read back through `include`,
and the dropped relation is refused by name.

#### The declared read — built

`FJS-D307`'s second half, and it is one option rather than a mechanism:

    export const movements = createResource('inventory', {
      model:        'InventoryMovement',
      offlineQuery: { directives: { limit: 40, orderBy: '-id' } },
    })

Warmed at boot and on every reconnect, armed exactly as the pending queue arms
its drain. **Not called `prefetch`** — sierra already has one and it means a
speculative preload on a link hover, so the word was rejected rather than given
a second meaning. It joins `detailQuery` / `optionsQuery` / `listQuery`, the
same `{ query, directives }` shape declared beside the model.

Two things about it are worth carrying into phase 5. **A warm may not touch a
store**: `load()` writes the rows the screen is rendering, so warming through it
would swap a visible list — it goes through `find` and `remember`, which is
`load()`'s other half. And **it is keyed by the QUESTION**, which is the honest
bound: the declared question is answerable offline and a different one is not.
That is the line the litestone client erases, and the reason the storage swap
below is worth doing rather than optional.

**`FJS-1178` is the half that remains**: a declaration exists only once its
module does, and a route's modules are code-split, so the screen nobody opened
declares nothing until somebody opens it. `example` answers it with one import
in `web/src/main.js` — which is a real answer and not a workaround, since which
resources are worth the entry chunk is a bundling decision the app owns.

#### The storage swap — built, and off

Sierra knows the client exists now. `offline: { db: true }` copies the engine out
of the app's own `@sqlite.org/sqlite-wasm`, emits the device schema beside it,
writes rows through on a successful `load()` and answers the catch from SQL
before the list cache — which is what erases the keyed-by-question bound above.
**It is not turned on in `example`**: with the engine live `verify:shell` hangs
after the *screen is not empty* block, which is `FJS-1179`.

**A cache does not re-grade what it was given** (`FJS-D309`). The rows are the
server's own answers to this caller, so the local read goes through `asSystem()`
and the tables go when the identity does. The alternative was worse than it
looks: a local client auto-installs `FrontierGateGetLevel` and an app's resolver
is a different function — 3 against 4 on one `example` account, with `Order` at
`@@gate("0.4.4.5")` — so re-grading would make the offline list differ from the
online one with nothing raised.

**The budget answered a question this paper had guessed at.** The predicted
doubling was 254→530; the measured cost is **278→880 kB over the wire** — 138 kB
engine, 341 kB wasm, 123 kB litestone client. And the number that mattered more
was the one nobody predicted: a bundler emits a worker chunk wherever it sees
`new Worker(new URL(…))`, reachable or not, and the shell precaches every `.js` a
build emits — so an app with the database OFF was paying 277→401 for a feature it
had not asked for. That is what `local-db-open.js` and the build's stub exist for,
and with them the seam costs 1 kB.

#### Hydration — built, and it is the warm

The last thing phase 4 owed, and it turned out not to need a mechanism. The
device was only as full as what a screen HAPPENED to read, so somebody who
signed in and walked into a basement without opening the right screen had an
empty database — and `@@sync`'s read direction was a claim with nothing behind
it. `warmOffline()` already fetches exactly the rows a device must hold; it now
writes them into the tables as well as remembering them in the cache.

**No new option, no new noun and no new artifact.** The design this replaced
would have emitted a model→service map at build time and taken a `hydrate:`
bound in config — a second reader of `src/resources/` beside `checks.js`'s, and
a second declaration beside the one that already says what to hold. The rows and
the model are both in scope at the call site, so hydration is derived rather than
declared.

**The declaration still means the SCREEN's question**, because matching it
exactly is what makes the cache slot the one `load()` reads. So the device is as
full as the declared window and no fuller — a device-sized window and a
screen-sized one are two grains, and one option cannot be both while the cache is
still underneath. That is the open question below rather than a gap here.

**Nothing re-warms on sign-in, and the gap that looks like is not one.**
Everything declared was last fetched as the previous caller, and a gate refused
most of it — but `setToken` cycles the socket, since the identity is established
at the upgrade and cannot be restated per frame, so `connect` fires and the warm
armed on it runs as the person who just signed in. A second call in the token
handler was written, measured to be redundant by removing it, and deleted. What
it was papering over was real and moved to where it belongs: an identity change
clears the tables, which CLOSES the worker holding the OPFS pool, and the
reconnect's warm would open a second one over the same files — so `localDb()`
now waits on a clear in flight. Two workers over one pool kill the renderer
(`FJS-1179`).

**Proved by a screen the device has never opened.** Every other assertion about
this passes with the database empty, because the warm fills the cache under the
same question the screen asks — so `verify:shell` empties the cache with the
network already down and opens `/inventory` for the first time in that browser.
Removing the write-through turns it red, and so does the unit pairing beside it;
the fake device had to be taught to KEEP what it is given first, because a fake
that answers reads regardless cannot tell a hydrated device from an empty one.

It costs 1 kB: `example`'s shell is 880 → 881.

**Two NUL bytes came out of the tree on the way.** `litestone/src/testdb.js` and
`cli/core/proofs.js` each held a literal NUL as a separator, which makes a file
binary to grep and ripgrep — they answered no repo-wide search, which is why the
first survey counted nine importers and not ten. CI's `hygiene` phase now grades
every tracked source file for it.

### The `@@sync` vocabulary, and the axis it must not swallow

Recorded here so phase 5 does not re-derive it. `FJS-D298` ruled the FORM —
`@@sync(<policy>)` from a closed set, with no default — and left the set open.

**The argument is the collision policy and nothing else.** Whether a Model
leaves the device, and in which direction, is a SECOND question this attribute
has not been asked: a `TaxRate` wants to be readable with no network and to
refuse an offline write, which is a statement about direction with no opinion
about collisions. If `server` is allowed to quietly also mean *and it syncs both
ways*, that second question can only be answered later by overloading it or by
coining a second attribute. Neither is free, and saying this now is.

**Phase 1 ships `server` alone** — at phase 1 there is no local database, so
nothing is read offline, and there is no second writer offline, so every other
value would parse and resolve nothing. A value that parses and does nothing
reads exactly like one that works.

The candidates, ranked by what this framework already owns:

| Value | Means | What it would cost here |
| --- | --- | --- |
| `server` | replay the operation; the server's state decides | nothing — a replayed operation already runs against whatever the server holds |
| `refuse` | the write carries the revision it was made against and is refused if the row moved | almost nothing — `@version` crosses as `x-version`, `FJS-D138` already stores the revision a write was against, and `@@transitions` is already a compare-and-swap |
| `append` | there is no collision, by construction — a scan, a count line, a ledger row | nothing to build: the declaration IS the implementation. It is also the principled answer rather than the cheap one — Weidner's first rule is that an operation which ADDS a unique new thing wants a set of unique things, and concurrent additions then cannot conflict at all |
| `lww` | last write wins, for the whole row | a ruling on whose clock, which has one defensible answer — server receipt, never the device. **And it is the one candidate with an argument against it**: Weidner's *independent operations should act on independent state* (`IDEAS/prior-art.md` § 4) says a row-wide winner discards an edit to a column nobody contested |
| `field` | last write wins per COLUMN, so two people editing different fields both win | per-field metadata. **Not a refinement of `lww` but the correction of it** — if this framework does timestamps at all, this is the shape. Triplit resolves per property and Figma does the same |
| `manual` | both versions are kept until something resolves them | the most: conflict storage, a screen, a resolution path. CouchDB keeps conflicting revisions on the document — lead |
| `crdt` | values merge by type | out of scope. ElectricSQL built it and abandoned it |

**`append` and `refuse` are BUILT** (`FJS-D304`), and what each does is only ever
about a HELD write — all three are identical on a reachable network.

| | what it does to a held write |
| --- | --- |
| `server` | DROPS the revision the device read, so the replay applies to whatever the row holds by then. This is a fix: the resource stamps `@version` onto every patch, which is right for a write somebody is standing over and turns `server` into its own opposite for a held one |
| `append` | refuses to hold a `patch`, `remove` or `restore` by name (`code: 'APPEND_ONLY'`). A CUSTOM method is not refused — `example` writes its ledger through `adjust()`, which appends, and sierra cannot read a custom verb |
| `refuse` | keeps the revision, and the Data boundary refuses the replay if the row moved. Needs `@version`, refused at parse without it |

`example` declares `append` on `InventoryMovement` and `StocktakeCount`, whose
comments were already describing it in prose. The shell went 276 → 277 kB and the
budget stopped the build, which is `FJS-D302` doing its job on a kilobyte.

They were the two to reach for first — one is the shape the stocktake actually
is, and the other is already enforced at the Data boundary and merely unnamed.
Both also share a property the timestamp policies do not: the semantics are
stated by the schema's author and readable in the schema, rather than supplied
by a library. Weidner's warning is aimed at CRDT libraries and it generalizes —
*if a user asks you to change some behavior that comes from a library you do not
understand inside and out, it will be a hard fix.*

### Phase 5 — two writers, one row

**Owners:** Litestone. **Answers:** Q4, which follows from `FJS-D298`. **Size:** M–L.
**Ships:** conflict as a declared outcome rather than an accident.

**One footgun to carry in from the start**: a concurrent delete beside a
property update produces a row that is neither — Weidner's example is an item
left holding `{"done": true}` with no title. FJS's `@@softDelete` is the
*archive* answer to that family, which resolves the anomaly and never frees the
row, and which of those two costs more is a per-model question rather than a
framework-wide one.

Only meaningful once phase 4 exists: while the client can only WRITE offline, a
replayed write against a moved row is a refusal the server already knows how to
give. Once it can READ offline too, two people genuinely diverge, and `@@sync`'s
vocabulary gains teeth — the resolution runs at the Data boundary because the
policy was declared in the seed. Q4's disclosure question resolves here by
following the declaration rather than by adding one.

---

## Sequencing notes

- **Phase 1 is unblocked.** Q1, Q2 and Q3 were the picks it waited on and were
  ruled 2026-09-16 as `FJS-D298`, `FJS-D299` and `FJS-D300`. Q4 gates phase 5 and
  follows from `FJS-D298` rather than standing alone. Q5 gates phase 2 and is not
  a pick at all: somebody has to find the choices first, which is phase 2's own
  opening move.
- **Phases 1 and 2 are the whole of a field-capture application.** A counter who
  scans, photographs and reconnects needs nothing from phases 3–5, which is why
  `verify:offline` is worth having at phase 1 rather than at the end.
- **Nothing here blocks on the browser database.** That is the point of the order:
  phase 4 is the largest piece and the last one, and every phase before it stands
  up without it.
- **One drive, grown a phase at a time.** `verify:offline` gets its `DRIVES.md`
  rows at phase 1 and gains assertions after that, rather than five drives each
  proving a layer nobody uses alone.

---

## Open questions

- ~~**Q1 — what does a Model declare about sync, and what does silence mean?**~~ **Answered 2026-09-16 (`FJS-D298`): A — `@@sync(<policy>)` from a closed set, with no default: a Model that declares nothing is not syncable, and an offline client refuses to queue a write against it.** The
  argument above settles that conflict policy is a schema concern. What is open is
  the vocabulary and the default.
  - **A** — `@@sync(<policy>)` from a closed set, with no default: a Model that declares nothing is not syncable, and an offline client refuses to queue a write against it
  - **B** — every Model is syncable under a server-wins default, and `@@sync` exists only to widen that to last-write-wins or a manual merge
  - **Recommend A** — fail closed, the way the Data boundary already does for access (Invariant 6). Under B a Model nobody thought about loses a row with nothing said, which is the failure § V asks about last; under A the author says the word once, and the append-only Model that most field capture actually is says it in passing

- ~~**Q2 — does the queue replay operations or rows?**~~ **Answered 2026-09-16 (`FJS-D299`): A — operations: the mutation's intent, replayed against whatever the server state is at replay time.**
  - **A** — operations: the mutation's intent, replayed against whatever the server state is at replay time
  - **B** — rows: the resulting record, reconciled field by field against the server's copy
  - **Recommend A** — `FJS-D138` already chose it for the overlay and stated the reason, that a replay needs an intent to replay, so B would make the store hold two representations of one pending write. B also cannot express a compare-and-swap: `@@transitions` is one, and a row replay would trample a state machine that moved underneath it

- ~~**Q3 — at replay, which gate level is a queued mutation graded against?**~~ **Answered 2026-09-16 (`FJS-D300`): A — the level the caller has at replay.**
  - **A** — the level the caller has at replay
  - **B** — the level they had when the mutation was queued, carried with it
  - **Recommend A** — the server re-checks on its own reading of the caller regardless (Invariant 6), so B is a fiction the boundary overrules anyway. What A costs is queued work that disappears, so this ruling only lands with its artifact attached: a mutation refused at replay is surfaced as a rejected item somebody can see and retry, never dropped silently

- ~~**Q4 — does a policy predicate cross to the browser, and for which Models?**~~ **Answered 2026-09-16 (`FJS-D303`): B — the boolean stays the default and shipping the predicate is something a Model opts into.** Today it
  does not, and nobody ruled that: `x-litestone-write-policy` crosses as a boolean
  `true` and never the expression (`packages/litestone/src/jsonschema.js`), which is
  enough for a form to disable a control and not enough to evaluate anything
  offline.
  - **A** — the predicate text crosses for every Model, since the server re-checks and the disclosure is mostly of rules a determined reader could infer from the UI
  - **B** — the boolean stays the default and shipping the predicate is something a Model opts into
  - **Recommend B** — strictness follows cost (§ IV), and the cost differs per Model, because a predicate can name a column whose reader was never meant to know it exists. It should not become a second declaration, though: a Model that declares `@@sync` has already said it will be evaluated with no server reachable, which is the same statement, so the disclosure follows from the sync declaration and nothing new is coined

- ~~**Q5 — what happens to a `File` column in a queued mutation?**~~ **Answered 2026-09-16 (`FJS-D301`): B — two queues. The mutation carries a reference the CLIENT minted and drains through the ordinary path; a second queue owns the upload, with its own local table, its own retry and objects that are immutable once named.** It was filed
  with no options; `IDEAS/prior-art.md` § 4 found them, and the field has
  converged on one shape.
  - **A** — one queue. The bytes ride with the mutation, and a write with a photograph on it is a write like any other
  - **B** — two queues. The mutation carries a reference the CLIENT minted and drains through the ordinary path; a second queue owns the upload, with its own local table, its own retry and objects that are immutable once named
  - **Recommend B** — it is what PowerSync, and every SDK that has had to do this, arrived at, and FJS is already built that way on the server: a `File` column stores a reference and `FileStorage` owns the bytes. Under A a 4MB photograph blocks a 200-byte correction behind it in a FIFO, and a half-sent upload has to be resumable inside a queue whose other entries are rows

- ~~**Q6 — what is the byte budget, and what does a build do when it exceeds it?**~~ **Answered 2026-09-16 (`FJS-D302`): C — a ceiling with a baseline that ratchets down only, the way `scripts/typecheck-baselines.json` already works (Invariant 14) — an app adopts whatever it costs today and cannot get worse.**
  Phase 4 states a GATE — *the budget has to be a number before this lands, not
  after* — and there is no number. Phase 3 made the question answerable rather
  than rhetorical: `sierra`'s postbuild prints what a shell costs, and
  `example`'s is **89 files, 980 kB**, which is already most of a phone's first
  visit before a wasm database is added to it.
  - **A** — a stated ceiling in `sierra.config.js`, and a build that exceeds it FAILS. One number, enforced where the number is knowable
  - **B** — the build REPORTS the total and grades nothing; the budget lives in the vision paper as an intention
  - **C** — a ceiling with a baseline that ratchets down only, the way `scripts/typecheck-baselines.json` already works (Invariant 14) — an app adopts whatever it costs today and cannot get worse
  - **Recommend C** — B is what exists now and it is why there has never been a budget: a number nothing enforces is a number nobody reads. A is the right shape and the wrong default, because a ceiling a framework picks is wrong for every app and the first thing anybody does is raise it. C is the mechanism this repo already trusts for exactly this failure — it makes *worse* the thing that fails, which is the only claim a framework can make about an app's bytes without knowing the app

- ~~**Q7 — what is the database in the browser?**~~ **Answered 2026-09-16 (`FJS-D305`): A — wa-sqlite over OPFS: the same SQL Litestone already writes, the same DDL, the same gates compiled the same way. ~1.2MB of wasm, loaded behind a dynamic import so only an app that reads offline pays.** Phase 4 names *OPFS or wa-sqlite*
  as though they were alternatives; they are not — OPFS is where bytes live and
  wa-sqlite is what reads them. The real choice is whether the local engine is
  SQLite at all, and Q6 is its gate rather than its rival.
  - **A** — wa-sqlite over OPFS: the same SQL Litestone already writes, the same DDL, the same gates compiled the same way. ~1.2MB of wasm, loaded behind a dynamic import so only an app that reads offline pays *(measured after the ruling and the figure was wrong by four: the OPFS path is the SYNC build, 254 kB brotli — see phase 4)*
  - **B** — IndexedDB plus `@frontierjs/toolbelt/predicate`, which is already here and already evaluates a `.lite` expression against a record on screen. No wasm and no new bytes; every query is a scan this framework writes by hand, and `@@index`, `groupBy` and `@@fts` mean nothing locally
  - **C** — both, chosen per app: B as the floor, A as an opt-in for an app whose offline reads are real queries
  - **Recommend A** — B is the one that looks cheap and is not: *one engine on both sides* is the claim phase 4 exists to make, and a second query implementation is a second set of answers to *what does this filter mean*, which is the failure `/query` and `/predicate` were both extracted to stop. C is B plus A plus the seam between them. What A costs is bytes, which is Q6's question and is why that one is ruled first — and the dynamic import means an app that never declares `@@sync` on a read path loads none of it

- ~~**Q8 — which `@@sync` values ship next, and in which order?**~~ **Answered 2026-09-16 (`FJS-D304`): A — `append` and `refuse` next, and nothing else until an app asks. `append` is the shape the stocktake already is and its declaration IS its implementation; `refuse` is already enforced at the Data boundary through `@version` and merely unnamed.** `FJS-D298` ruled
  the FORM and left the set open; phase 1 shipped `server` alone because nothing
  else could resolve without a second writer. Phase 4 gives it one. The
  candidates and what each costs are the vocabulary table above.
  - **A** — `append` and `refuse` next, and nothing else until an app asks. `append` is the shape the stocktake already is and its declaration IS its implementation; `refuse` is already enforced at the Data boundary through `@version` and merely unnamed
  - **B** — `field` next, because if this framework does timestamps at all that is the correct shape, and shipping `lww` first would ship the one candidate with a written argument against it
  - **C** — the whole set at once, so the vocabulary stops being a table in a paper
  - **Recommend A** — both of A's values are stated by the schema's author and READABLE in the schema, where every timestamp policy is supplied by a library and has to be trusted; Weidner's warning about behavior that comes from a library you do not understand is the argument, and it generalizes past CRDTs. C would ship values that parse and resolve nothing, which phase 1 already refused once. B is right that `field` beats `lww` and that is a reason to skip `lww`, not a reason to do `field` before the two that cost nothing

- ~~**Q9 — what fills the local database, and which source answers a read?**~~ **Answered 2026-09-16 (`FJS-D307`): C — B's read path, plus a declared PREFETCH: a screen or a resource says which queries it must have before it needs them, and warming them is an ordinary read through B's own mechanism - **All three need the same thing first**, measured above: a set of writes run in ONE worker message inside a single transaction. Row-at-a-time is 165× slower, which is 46 seconds against 0.3 for a 5,000-row hydration. This is not a tiebreak between the options — it is owed before any of them.** Phase
  4 built the database and nothing puts a row in it. This is the gate on the rest
  of the phase: hydration and the read path are one question, because *where the
  rows come from* and *who answers a query* cannot be decided apart.
  - **A** — a replica. A declared subset of the server's rows is kept current by a
    change feed over the existing WebSocket, and every read goes local, always,
    reachable or not
  - **B** — a cache that fills itself. A read goes to the server when it answers
    and the rows are written locally as they pass; with no server the same query
    runs against what is there. Nothing new is declared
  - **C** — B's read path, plus a declared PREFETCH: a screen or a resource says
    which queries it must have before it needs them, and warming them is an
    ordinary read through B's own mechanism
  - **All three need the same thing first**, measured above: a set of writes run
    in ONE worker message inside a single transaction. Row-at-a-time is 165×
    slower, which is 46 seconds against 0.3 for a 5,000-row hydration. This is
    not a tiebreak between the options — it is owed before any of them.
  - **Recommend C** — **B alone does not ship the promise.** A stocktake in a
    basement can only query rows somebody happened to open earlier, and *which
    screens did I visit before I lost signal* is not a thing a person can predict
    or a developer can test. **A is a distributed-systems project**: a change
    feed, a subset language, an invalidation story — and it re-opens the axis
    `FJS-D298` deliberately closed, because *this Model is replicated to the
    device* is a statement about DIRECTION, which `@@sync`'s argument is not
    allowed to also mean. C is B's mechanism with one declaration that names
    exactly the thing a reader can predict — *this screen works offline* — and it
    composes with what phase 3 already built, since sierra's list cache
    (`FJS-D300`) is B with the wrong storage engine underneath it. The upgrade
    path to A stays open: a prefetch that runs on a schedule is a poor replica,
    and the day an app needs a real one, C's declaration is the subset language A
    would have had to invent.

- **Q10 — when a device has a database, is the declared window the SCREEN's question or the DEVICE's?** Open, and phase 4 shipped the conservative reading. `offlineQuery`'s directives must match the screen's exactly or the warm fills a cache slot nothing reads — but the same warm now fills the device's tables, where a query engine does not care which question put a row there. So the one declaration is serving two grains: a screen shows 40 rows and a device should hold rather more.
  - **A** — one declaration, meaning the screen's question. What ships today: the device is as full as the declared window, and an app that wants more must accept a cache slot nothing reads
  - **B** — a second key beside it (`offlineQuery: { directives, hydrate: { limit: 500 } }`) — two grains, named, with the cache keeping its exact-match rule
  - **C** — when `offline: { db: true }` and the model is in the device schema, the declaration means the DEVICE's window and the keyed cache warm is skipped for that model, since SQL answers the screen's question anyway
  - **Recommend C, once the database is not allowed to fail** — it is the only one that removes a grain rather than naming one, and the cache is genuinely redundant for a model the device holds. What stops it today is that `localDb()` answers null on any failure by design, and under C a device that could not open leaves the screen with a cache keyed to a window it never asks for. B is the safe middle and costs an option; A is honest and costs fullness. The decision is really *may the local database be load-bearing*, which is the same question phase 5 has to answer for writes

## See also

- `IDEAS/offline-first-and-release.md` — the vision, the re-probed survey, and the Release half
- `DECISIONS.md` § `FJS-D297` — why there is no offline package, and what Homestead names
- `DECISIONS.md` § `FJS-D138` — the client data lifecycle; the intent overlay phase 1 builds on
- `IDEAS/live-queries.md` — the live-query surface phase 4 is the destination of
- `IDEAS/package-map.md` — the roster row this work was decomposed out of
