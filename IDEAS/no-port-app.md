---
id: no-port-app
status: proposed
dated: 2026-10-10
---

# Idea — the app with no port: vendor-hosted and never-deployed as release artifact kinds

**Status: PROPOSED.** Dated 2026-10-10. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`. Written from a survey of what
shipped between April and October 2026 (sources at the end); every FJS claim was
checked against the tree that day.

`IDEAS/offline-first-and-release.md` § *Release artifacts* lists the kinds a
release can be — single binary, container, static + API, offline-capable PWA.
**That list is the origin and stays it.** This paper argues two more kinds and
what each demands; the list gains two bullets that point here.

---

## What changed outside

- **The model vendor hosts the app.** OpenAI's Sites (preview 2026-06-02, under
  both the *Codex Sites* and *ChatGPT Sites* names) takes a described app and
  deploys it on OpenAI's hosting as Worker-shaped modules, with a SQLite-style
  database (D1), object storage (R2) and *Sign in with ChatGPT* as the only
  identity. Claude artifacts give a page persistent storage, live data on
  reopen and model calls with no API key. **The runtime, the identity and the
  storage are the vendor's. The author owns intent.**
- **The app is never deployed.** Personal software written with an agent that
  runs on one laptop, keeps its data in a local store, syncs over Yjs if at
  all, and is discarded after a few uses (Irving, August 2026; Turow's
  *disposable apps*). The friction that keeps it local is familiar: SQLite does
  not run on serverless hosts, env vars are missing, a service existed only on
  localhost.

Neither is a new technology. Both are a new answer to *where does the app
live* — and Deployment is the realm with no package, so both land on the
weakest realm.

## The claim

**FJS is one artifact kind away from the first and already is the second.**

The never-deployed app is what `fli new` produces: a SQLite file, one process,
`fli dev`. Nothing is owed except a sentence that says so — the framework
treats *running locally* as the stage before deploy, and the field now treats
it as a destination. That is a documentation gap, not a build.

The vendor-hosted app is harder, and the honest fact is at the top of
`CLAUDE.md`: **Junction is Bun-only and no version of it is not.** A Worker
runtime cannot run it, so an FJS app cannot be a Codex Site in the shape
OpenAI hosts. The reachable shape is **the app with no server at all**:
Sierra's `static` target plus Litestone in the browser (`FJS-D305`, one
codebase over SQLite's wasm in a worker on `opfs-sahpool`), which Homestead
phase 4 has already put there. Identity comes from the host as an OAuth
provider. There is no port, no process, and no `.db` on a machine the author
operates.

## What exists, probed 2026-10-10

- `packages/litestone` runs in a browser worker over OPFS behind the `#sql-engine`
  and `#host` seams. Shipped.
- Homestead phases 0 to 5 (`homestead.md`): held writes, a queue, a shell that
  survives reload, a database in the browser, two writers on one row.
  `example`'s `verify:offline` drives it. **Every phase assumes a Junction
  behind the sync**; none asks whether a Resource can be served with none.
- Sierra `static` builds a shell with no API. `createResource(name, { app })`
  binds a resource to a Junction client. Whether it can bind to a Litestone
  client directly is the probe this paper owes and has not run.
- Gates and policies evaluate locally (`toolbelt/src/predicate/`, per
  `offline-first-and-release.md` § re-probe), so the Data boundary exists with
  no server. The audit trail, encryption and `@@transitions` enforcement in a
  browser-only app are untested claims.
- `auth`'s `client.auth.providers()` and `completeSignIn(code)` already model
  a third-party identity. *Sign in with ChatGPT* or Anthropic as the only
  provider is a configuration, not a feature.

## What it would be

1. **Two bullets in the artifact-kinds list**: *browser-only* (static shell +
   Litestone over OPFS + host identity, no Junction) and *local-only* (the
   default app, declared a destination). Done in this change.
2. **The probe**: a resource over a Litestone client with no Junction. If it
   needs a shim, the shim is a Junction-shaped client whose transport is the
   local database — the relay seam again (`client.forward(call)` with the call
   answered in-process) rather than a second resource implementation.
3. **A `fli build --kind browser-only`** only if the probe passes and only if
   the static target does not already produce it with Homestead's shell. This
   is the one option this paper may add and it is not added until then.
4. **What a browser-only app may NOT claim**: the audit trail is on the
   person's own disk, `@encrypted` keys live in the same origin as the data,
   and a gate is a UI affordance when there is no server behind it. The
   framework's promise narrows, and the artifact kind says how.

## The nine, answered before any edit

1. **Origin** — the artifact-kinds list is the one origin and it is extended,
   not copied. This paper holds argument, not the list.
2. **Concept** — two artifact kinds, which is the noun the list already uses.
   No new package, no new surface.
3. **Complexity** — the browser-only kind removes a process rather than adding
   one. The complexity is in the promise narrowing (item 4), which is stated.
4. **Predictability** — the same resource file, the same schema, a narrower
   guarantee. The one surprise — gates are advisory with no server — is the
   surprise Invariant 6 already names for `x-gate`.
5. **Derived** — the build is the static target's; the database is the schema's;
   identity is a provider entry. Nothing hand-maintained.
6. **Owner** — Release owns artifact kinds (`offline-first-and-release.md`);
   Litestone owns the browser engine; the relay seam owns a client whose
   transport is not HTTP. No second implementation proposed.
7. **Boundary** — the author chooses a kind and the rest follows. The host
   vendor sees a static bundle and an OAuth redirect and knows nothing else.
8. **Failure** — a schema that declares `@@trail` or `@encrypted` in a
   browser-only build should WARN at build, naming the narrowed promise, not
   refuse: the author may know the data is theirs alone. A refusal is owed
   only where the schema declares tenancy, because a tenant boundary with no
   server is not a boundary.
9. **Silence** — *what must stay true*: a browser-only build never ships a
   Junction import. *What fails*: a build-output test that greps the bundle for
   `@frontierjs/junction` (the shape `verify-build.mjs` already has). Until it
   exists, `none`, recorded as unenforced.

**Adjudications in tension (§ IV):** *paved road vs. the workaround* — the
local-only app is the road's first step declared a destination, and no `--kind`
flag is added until the probe says the road does not already produce it.
*Ergonomics vs. strictness* — question 8 resolves per declaration by what a
mistake destroys: a warning for a trail or a key on the person's own disk, a
refusal for tenancy with no server.

**Tier:** Assessment. The one ruling it approaches — *is a gate with no server
behind it still Invariant 6* — is the question Homestead § *Shipping gates to
an untrusted client* already argued, and this paper defers to it.

## Open questions

- **Is Junction's Bun-only stance also a stance about Workers?** A yes closes
  the vendor-hosted kind for good and this paper says so plainly. A *not yet*
  reopens `runtime-targets.md`, which this paper does not re-argue.
  - **A** — yes: the vendor-hosted Worker kind is closed, this paper states it
    beside the two kinds it adds, and `runtime-targets.md` stays the only place
    a non-Bun runtime is argued (`CLAUDE.md` Packages: *Bun-only and no version
    of it is not* — `Bun.serve`, `Bun.file`, `bun:sqlite`)
  - **B** — not yet: the paper names Workers as deferred, and `runtime-targets.md`
    gains a Workers section as a second target beside the native one, still
    parked until core leaves alpha (`FJS-D14`, `runtime-targets.md:9`)
  - **Recommend A** — the tree already says it plainly and the browser-only kind
    is the reachable shape without it; `runtime-targets.md` can still reopen it
    after alpha, so a *yes* closes nothing a later ruling cannot.
- **Who owns the sync server for a browser-only app** when the author later
  wants two devices? Homestead says Junction. That is the moment the kind
  changes, and the migration from browser-only to static + API is the path
  worth making cheap.
  - **A** — Junction: browser-only → static + API is adding an `api/` surface over
    the same `db/schema.lite`, and Homestead's sync (`homestead.md`, every phase
    assumes a Junction behind it) is the one sync; the migration owed is moving
    the OPFS rows up on first connect
  - **B** — the host: the vendor's storage is a Provider declared in conduit
    (`FJS-D177`), and the browser Litestone syncs to it with no Junction — a
    second sync protocol beside Homestead's
  - **Recommend A** — one sync owner (Invariant 4's shape), and the kind change
    is then a surface added rather than a protocol swapped; B duplicates
    Homestead's held writes and conflict rules against a store with no gates.
- **Lifetime as a declaration.** A disposable app has one. Nothing in the
  schema says *this is gone in a month*, and `forgetting.md` is the nearest
  paper.
  - **A** — no word: lifetime stays outside the schema, as `FJS-D657` ruled
    for retention (*Retention stays a job the app schedules, and Caravan owns
    the clock* — `FJS-D36`); a disposable app is deleted by whoever hosts it
  - **B** — a Release declaration: the artifact kind carries an expiry (the
    deploy says *gone after 30d*, the way a preview already dies with its
    branch, `FJS-D1252`), and the schema stays silent
  - **C** — a schema word (`@@lifetime(30d)` at the schema level), read by the
    build and the host — a sibling of row-level `@@expires`
    (`packages/litestone/src/core/schema-maps.js:1558`)
  - **Recommend A** — no second product asks for it, `FJS-D657` already refused
    a declared clock, and a whole-app lifetime is the host's to enforce; B is
    the place if one ever does, never the schema.

## Sources

- OpenAI Sites: developers.openai.com/codex/sites,
  help.openai.com/en/articles/10128477
- Personal apps: flourish.org/2026/08/personal-apps
- Disposable apps: jonturow.substack.com/p/vibecoding-when-everyone-can-build
- Deploy friction: lowcloud.io/en/blog/vibe-coding-deployment-problems

## See also

`IDEAS/offline-first-and-release.md` (the list) · `IDEAS/homestead.md` (the
engine) · `IDEAS/prompt-to-app.md` (the builders that own the loop) ·
`IDEAS/runtime-targets.md` (a non-Bun runtime, deferred) · `IDEAS/agent-client-ui.md`
(the same survey's other finding).
