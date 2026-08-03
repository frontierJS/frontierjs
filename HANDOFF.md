# Handoff — 2026-08-02

Session state for picking up cold. Read `CLAUDE.md` first (the map), then this.

Everything below was verified by running it, not by reading. Where I could not
verify something, it says so.

**Four sessions are recorded here**, newest first. The latest did SSR_SPEC W3
in `packages/mesa`; before it, one across mesa + sierra; before that, one
entirely in `packages/css`; before that, junction/litestone, which starts at
*Where things stand* and is unchanged and still true.

---

## Latest session — Mesa island markers (SSR_SPEC W3)

```
packages/mesa     907 pass / 0 fail / 27 skipped   (npx vitest run — 15 files)
                  typecheck clean · spec-check: all 16 VISION §4 claims verify
packages/sierra   672 pass / 0 fail                (downstream regression check)
```

One item, finished: **`ctx.islands` was populated by the compiler and consumed
by nobody.** SSR emitted an island's markup inline with nothing to identify it,
so a client loader could not tell `<button>0</button>` from the static text
beside it — and nothing outside Mesa could add a marker, because the markup is
produced inside Mesa's own renderer. Opt in with `{ islands: true }`:

```
<!--mesa-island {"component":"Counter","directive":"load","props":{"start":3}}-->
<button>3</button>
<!--/mesa-island-->
```

Full rationale in `packages/mesa/CHANGES.md` (top entry) and `SSR_SPEC.md` W3;
VISION **RULE 26** is amended, in the same style RULE 54 amended §5. The parts
worth knowing outside Mesa:

- **Markers are comments, not a `<mesa-island>` element** — reversing what the
  spec sketched. An element is foster-parented out of `<tbody>` by the HTML
  parser, losing the association before any loader runs, and it joins `>`
  selectors and flex/grid layout so a page styles differently prerendered than
  client-rendered. Checked in headless Chrome: the comment marker stays in
  `TBODY`, and a real `TreeWalker` finds every marker.
- **Two guards.** The flag switches emission — with it off, compiled output is
  byte-identical (verified: 69/69 components, once CSS scope ids are normalized).
  The environment then decides whether a marker is *written*, so client DOM is
  unchanged even with the flag on.
- **The marker carries props as rendered**, which `ctx.islands` cannot —
  `start={2 + 3}` is invisible to a compile-time pass and `{"start":5}` in the
  marker. Both views ship; `renderComponent` now returns `.islands` for the
  build-time one.
- **Mounting is `mount(openComment, Comp, { props })`, never a bare
  `Comp(anchor, props, null)`** — a direct call renders correctly and registers
  no delegation root, so the island comes back inert. Same trap as the REPL.

**Two traps for whoever writes the loader**, both found by probing:
`createTreeWalker(root, NodeFilter.SHOW_COMMENT)` is correct and works in
Chrome, but **happy-dom 14.12.3 filters it to nothing** — a loader tested only
against this repo's SSR harness silently finds zero islands. And happy-dom ends
a comment at the **first `>`**, not at `-->`, which split a marker and made
`JSON.parse` throw; the payload now escapes every `-` and `>`.

**Unrelated finding worth recording: compiler output is not deterministic.**
`genId()` is `'m' + (Date.now().toString(36) + counter).slice(-8)`, so CSS scope
ids differ between any two compilations of the same source — even in one
process. Any build-reproducibility or output-diffing work has to normalize them
first; it cost an afternoon's false alarm here.

**Not done, and still Sierra's:** the loader itself, per-island bundling, and
name→module resolution.

---

## Previous session — Mesa + Sierra

```
packages/mesa     891 pass / 0 fail / 27 skipped   (npx vitest run — 15 files)
packages/sierra   655 pass / 0 fail                (npx vitest run — 32 files)
```

Started as "review the Mesa block-teardown plan", ended up through the static
renderer, Sierra's prerenderer, the REPL, and three compiler bugs. Per-package
detail lives in `packages/mesa/MESA_PROJECT_STATE.md`; this is the short version
and the parts that affect other packages.

### ⚠ `build/` in `.gitignore` was hiding 20 source files

Root `.gitignore` had a bare `build/`, which matched `packages/*/src/build/` —
**Sierra's entire build pipeline** (`prerender.js`, `mesa-plugin.js`,
`scanner-plugin.js`, `index.js`, …) and jetty's, 20 files, none of them tracked.
A fresh clone had no Sierra build pipeline at all.

Fixed by negating the directory (`!packages/*/src/build/` — git cannot
re-include a file whose parent directory is excluded, so the directory itself
has to be un-ignored). All 20 are now visible to `git add`. **They are still
uncommitted.** Root `dist/` and `build/` stay ignored.

That is the most important fact for a new session, along with the standing
"nothing is committed" note below.

### What changed

**Block teardown** (`BLOCK_TEARDOWN_PASS.md`) — `keyBlock`, `awaitBlock`,
`$$eachBlock` and `boundaryBlock` all had one of two failure shapes: a DOM range
held by first/last node pointers that an inner block can escape, or content built
with no owner so its effects were unreachable by any disposal path. Both named
and fixed. Two claims in the plan that motivated the pass turned out to be false
under testing; the doc says which and why.

**The static renderer** (`STATIC_RENDERING.md`) — `renderToHTML`, exported as
`@frontierjs/mesa/render` and documented in the README, had been calling a
component convention the compiler stopped emitting and threw on every component.
Nothing imported it, nothing tested it. Now works, and `render-component.js`
renders through it so there is one renderer rather than two. Fixing it also
fixed a leak in the *working* path: no render disposed anything, so N pages left
N live effect sets subscribed to any module-scope store they read.

**`createRoot`** — added to the runtime for that, and now VISION **RULE 54**.
This reverses a documented decision (§5 said Mesa deliberately ships no scope
primitive); the rule was amended rather than the code reverted, because
`createEffect` is not a substitute — it subscribes to what its body reads, so a
component that reads then writes a store during setup ran **1001 times for one
page** under an effect and once under a root.

**Sierra's prerenderer** — `composeWrapper` composed layouts with the `children`
prop while on-disk layouts use `<slot />`. Different protocols, nothing bridging
them, so the layout rendered and the page inside it silently did not. It now
supplies children both ways. The `static-site` fixture gained a mixed layout
chain, because it previously had *no layout at all* and so never exercised this.

**The REPL** — was completely dead: `index.html` imported `DEFAULT_EXAMPLE`,
which `examples.js` had stopped exporting, and a missing named export is a
link-time error in ESM. Behind that, it mounted by calling the component function
directly, so no delegation root was ever registered and every example in all 59
rendered correctly and responded to nothing. Both fixed; now 66 examples, and
`repl.test.js` guards the module graph, compilation, and interactivity.

**Three compiler bugs**, all "compiles clean, does not parse":
`$: { }` assignments emitted `get(sig) = …`; `bind:` on a component emitted
`{bind:value: …}`; a multi-line interpolated attribute was truncated at the
newline. The first two are why those features had no REPL example — they could
not be made to work. See `packages/mesa/CHANGES.md` for cause and fix on each.

### Open, in rough priority order

1. **Commit the 20 unignored build files.** Nothing else depends on it, but the
   work is not durable until it lands.
2. **`uiComponents` REPL example renders empty Cards** — `ui/Card.mesa` reads the
   `children` prop while the showcase passes element children. Switching Card to
   `<slot />` fixes composition and then surfaces further latent errors in the
   `ui/` kit (`variant is not defined`), so it is a kit task, not a REPL one.
3. **`SSR_SPEC.md` W1** — `renderComponent` writes temp modules into Mesa's own
   package root, so bare specifiers in a rendered import graph resolve from
   there. Small, self-contained, verified as written. **Now the only SSR_SPEC
   item still open in Mesa.**
4. ~~**`SSR_SPEC.md` W3** — island markers in SSR output.~~ **Done 2026-08-02**
   — see the section below. What remains of it is Sierra's: the loader,
   per-island bundling, and name→module resolution. `sierraContext.islandMap`
   is still consumed nowhere; what changed is that there is now something in
   the HTML for it to point at.
5. **`mesa-vite` has no tests at all**, and its HMR id-normalisation fix has
   carried a "not confirmed in browser" warning since it was written.
6. **Nothing in this session was checked in a real browser.** happy-dom
   reproduces the link error and the delegation path faithfully, but codemirror,
   the importmap and the REPL's drawer UI are unverified. `npm run serve` and a
   click would settle it.

### Working notes

- **Compiling without errors and emitting valid JavaScript are different
  claims.** Nothing was checking the second, and it hid all three compiler bugs.
  `repl.test.js` now checks it for every example.
- **Check that a test actually fails against the real prior code.** Twice this
  session a "vacuity check" was itself wrong — once a partial revert, once
  removing guards from a rewrite that could not recreate the old algorithm. The
  honest check is `git show HEAD:file` and compiling against that.
- **A synthetic minimal repro can be too minimal.** The multi-line attribute bug
  needs a *preceding* text binding to trigger; a single-element fixture compiles
  fine on the broken compiler.
- `spec-check.mjs` had a hardcoded path from another machine and could not run.
  Fixed; all 16 documented VISION §4 claims verify.

---

## ⚠ Read this first: nothing is committed

`packages/css` has **five versions of unlanded work** in the working tree —
v0.6 through v0.10. `git status packages/css` shows **41 files** — 18 modified, 9 added-and-
modified, 14 untracked. Nothing has been staged or committed at any point.
(Repo-wide the count is 161, most of it predating these sessions.)

That is the single most important fact for a new session. Landing it is a
judgement call about granularity (one commit per version? one for the lot?)
that was deliberately left to the owner.

---

## Most recent session — `@frontierjs/css` v0.6 → v0.10

```
packages/css   202 assertions, 0 fail   (bun run test — headless Chrome)
               40 CSS files, all 39 imports resolve
               v0.10.0 · all 35 vocabulary terms ship CSS
               bun run demo → http://localhost:5173
```

Started from "where do we stand", ended with a tested package and a running
app. Four things happened, in order:

**1. A test harness, checked in.** `test/` — 202 assertions in real headless
Chrome against real computed styles, zero dependencies (the page computes its
own results, `--dump-dom` carries them back; no puppeteer, no lockfile entry).
`test/specs/meta.spec.js` tests the *harness*, because a third of the v0.6
failures had been bugs in the assertions.

**2. The two known defects, fixed** — plus three nobody knew about. Four focus
recipes collapsed into one `focus.css`; `.table.striped` no longer out-specifies
row tones. Writing the tests then found that `.btn.outlined` and `.btn.link` had
**no focus ring at all**, that **no theme's focus ring was ever its own colour**,
and that `--ink-mute` had failed WCAG AA since v0.1.

**3. The SaaS gap list, shipped** — Steps, Avatar, Facts (a `<dl>`), Kbd, Code,
Divider, vertical Tabs. Vocabulary 29 → 35 terms.

**4. A demo app, and what it cost.** `demo/` is a five-route SaaS admin and the
first thing in the repo to import the package. **It found eight shipped bugs in
an afternoon against a green suite of 165** — including every closed `<dialog>`
rendering as though open, `.btn.ghost` being a silent no-op, and the `.switch`
squashed into a checkbox inside the markup `form-core.css` itself documents.
Its `demo.css` was then reviewed line by line and four gaps promoted into core.

Rulings from all of this are in **`DECISIONS.md` → Design system**. Six of them;
check there before "fixing" any of it back.

### The one breaking change

**`.btn.icon` → `.btn.square`.** `.icon` is now the Icon vocabulary term
("this element *is* an icon"). Renamed everywhere in-repo; zero remaining. It
fails *quietly* for anyone outside the repo — a stale `.btn.icon` floors at
30x30 and looks roughly right while losing its `aspect-ratio` and padding.

### What that session did NOT do

- **Commit anything.** See above.
- **The style guide was not extended.** It `<link>`s the real `index.css` so
  what it shows cannot drift, but it has **no page for Avatar, Facts, Code
  blocks, vertical Tabs, the `.text-*` scale, or `icon.css`**, and only
  glancing coverage of Steps and Kbd. Its 45-page nav ends at the v0.7 surface.
  Six pages missing, and the Icons page needs rewriting for the rename.
  (A later session converted it from `style-guide.jsx` to plain HTML/JS at
  `packages/css/guide/` — same content, same gap.)
- **Settle the vocabulary.** A demo is not a consumer. `PROJECT_STATE.md` item
  1 — "use it in a real project" — is still the blocker, and Clean Affinity
  admin is still the obvious target.

### Two findings left deliberately open

- **Accent-as-text has no contrast guarantee.** The chip lineage caps a tone
  used as a *fill* so text on it clears AA. Nothing caps a tone used as *text
  on a surface*, and `.link`, `.tab[aria-selected]`, `.navlink[aria-current]`,
  `.tile-delta` and `.field-hint` all do that. `--color-primary` on `--surface`
  is 3.96:1. The fix changes how five shipped components look, so it wants a
  decision rather than a drive-by.
- **The drawer's edge variants are physical** (`.from-left` / `.from-right`)
  while the rest of the package is logical throughout. Folds into the
  scoped-modifier naming question, which is still open — though v0.10 resolved
  one of its four cases by renaming `.icon`.

### How to see it

```bash
cd packages/css
bun run test          # 202
bun run demo          # http://localhost:5173 — five routes, six themes
```

`demo/README.md` is the writeup of what building it found; `PROJECT_STATE.md`
carries the architecture and the full version history.

**Two harness notes worth keeping.** Computed-style tests are blind to
composition — two v0.8 bugs passed every assertion and were caught only by
screenshotting the page and looking at it. And `nohup … & disown` *does* hold a
background server in this environment, contrary to the note at the bottom of
this file; plain `&` and bare `nohup` both dropped it.

---

## Where things stand

```
junction    681 pass   0 fail     (was 196 pass / 203 running at session start)
litestone  1241 pass   0 fail     (+14)
conduit       94 · auth 7 · caravan 36 — all green
junction typecheck: 224 errors    (baseline 226, established this session)
```

`packages/junction/tsconfig.json` is new — junction is the only package with a
typecheck. `bun run typecheck` inside it. **224 is the accepted baseline**, not a
target: it was 226 when first measured and nothing has been fixed deliberately.
Use it as a ratchet — if a change pushes it up, that change added errors.

The headline at session start was that **`tests/index.test.ts` (4,433 lines, 357
tests) had not run in some time** — a stale `createLitestoneService` import made
it fail at module load, and bun reported that as one error and moved on. The
suite looked like 196/203 passing. It was really 203 of ~560 authored.

---

## What changed, by theme

### The service layer (audit point 1, Option A only)

Finished the `createLitestoneService` removal across **8 places** it was left
half-done — two test files, three examples that did not build, the README,
junction's project-state doc (since rewritten as
`packages/junction/ARCHITECTURE.md`), and the CLI's `make:model`/`make:scaffold`
templates, which were generating service files that imported a nonexistent
export. Dead tests were **migrated, not deleted**.

Collapsed **five drifted reserved-key lists** into one
(`SERVICE_OPTION_KEYS` / `SERVICE_RUNTIME_KEYS` / `isCustomMethod()` /
`customMethodNames()` in `core/service.ts`). Two of the copies omitted
`update`/`_update`, so every service was advertising `update` as a custom action
in `/manifest` and the OpenAPI spec.

**Option B (the definition/runtime split) is NOT done.** See the ledger.

### Accessor resolution (`model Post` → `db.post`)

One shared `accessorCandidates()`, used by all three resolvers. The literal
spelling wins; the singular is a fallback, so `@@external` models mirroring
plural tables still resolve to themselves. `model` is now optional and derives
from the service name, so the minimal service file is `createBaseService({})`.

### The envelope (audit point 3) — ruled

`src/core/envelope.ts` owns wrap/unwrap/inspect. **`kind: 'single' | 'list'`** is
the discriminant; `object` is the SERVICE name for both kinds. The rule
everywhere: **a list keeps its envelope, a single unwraps to the record.**
`$wrap` is tri-state on the wire.

### Query directives (found while doing the envelope)

`ctx.query` is filters only; **`ctx.directives`** is the structured form of
`$limit`/`$offset`/`$orderBy`/`$select`/`$populate`/`$search`/`$withDeleted`/
`$onlyDeleted`. The bridge is the only place that understands `$`.

### The gate seam (audit point 6) — ruled

`sessionGateLevel()` maps a Junction `SessionContext` onto Litestone's 0–7 scale.
Apps wire it once: `new GatePlugin({ getLevel: sessionGateLevel })`.
The load-bearing rule is **absence is not an objection** — `undefined` means the
app does not model that stage, `null` means it does and this user has not reached
it.

### One event origin (audit point 2) — ruled

A mutation is announced once, in `callService`, fanning out to the bus and the
channel manager. `ctx.dispatch` is one switch for both. Services declare
**`channel: 'posts'`** (a noun — `publish` is an ordinary action name and
reserving it would break `posts.publish()`). Bulk writes announce **once per
record**. Framework opt-in; `fli make:*` scaffolds opt you in with a scoping
warning attached.

---

## Bugs fixed that were not on any list

Every one was found by running the thing, and most were silent.

| | |
|---|---|
| `createService({ softDelete })` **hard-deleted rows** | option never forwarded to the base; `createBaseService` soft-deleted correctly |
| `@@gate` **failed open** under a plural model name | `posts` matched no model, which read as "no gate declared" |
| accessor probing died on the first miss | a real Litestone client is a Proxy that **throws** on an unknown accessor |
| **optional fields were mandatory** | validator's absent-value branch was unreachable for nullable fields; every `String?` model needed explicit nulls |
| every WS event name was **present tense** | `posts create` on the wire, `posts created` in every listener |
| `remove` **re-added** the deleted record | the client's `'*'` fallback upserted what named handlers should have removed |
| `resource()` **never opened its socket** | documented automatic real-time; left `connect()` to the caller |
| `$limit`/`$offset`/`$orderBy`/`$select` **all inert over HTTP** | the bridge stripped exactly the four keys `parseQuery` read |
| `?limit=1` returned **zero rows** | unprefixed, so it became a WHERE clause on a nonexistent column |
| bulk POST bodies **destroyed** | `{ ...array }` → `{0:…,1:…}`; bulk create over HTTP had never worked |
| validators **rejected arrays outright** | every bulk create 400'd before reaching the service |
| `/metrics`, `/manifest`, OpenAPI listed `update` as a custom action | drifted reserved-key copies |
| `_meta`/`_schemas` dropped on the `createService` path | `/manifest` reported defaults for every service |
| Junction warned about **its own** hooks on every boot | `gateAuth`/`autoValidate`/`publish` were anonymous |

---

## The ledger

Numbering is stable across sessions — "issue 7" means the same thing.

**Closed:** 3 (envelope) · 6 (gate seam) · 11 (internal pagination) · 13 (`publish` reserved)

### Open — verified this session

1. **Service conflates definition with runtime** — Option B/C. The index
   signature `[method: string]: unknown` poisons every `def.*` read (14 of
   `service.ts`'s 17 typecheck errors). Three-way pipeline ladder,
   `register()` monkey-patching `service.hooks`, `_compiledPipelines`
   invalidation. *The big one, and now the safest it has been.*
2. **Real-time remainder** — litestone's `onEvent` still has zero Junction
   subscribers, so an `asSystem()` write in a Caravan job announces nothing.
   Junction cannot fix this alone: `onEvent` is fixed at `createClient` and
   there is no post-construction subscribe. **Mirror `$tapQuery(fn)`'s shape in
   litestone** — that is the whole fix.
4. **Core vs batteries** — ~80 root exports, no public/internal tier, every
   battery both root- and subpath-exported, `plugins/ai` a self-described shim.
5. **Middleware vs hooks** — two pipeline systems, one vocabulary.
   `rateLimit`/`rateLimitHook`; auth re-implements a limiter because
   `ServiceContext.params.ip` ≠ `TransportContext.ip`; `apiPrefix` hand-resolved
   in 4 files with 2 different defaults.
7. **Types stop at the server** — litestone's typegen emits `Post`/`PostCreate`/
   `PostWhere`; nothing carries them to the browser. `example/fullstack/app.ts`
   has a hand-written `Seeder` type as the receipt.
8. **Sibling ownership overlaps** — scheduler/Caravan, mail/notifications,
   outbound/Conduit. Smaller than it sounds: junction's `plugins/scheduler` is
   6 lines.
9. **Dialect trap** — junction pins `"latest"` → npm **1.0.3** for its own
   internals while the workspace ships **1.0.6**. They agree today; I verified
   `generateJsonSchema` interop. That is luck, not design.
10. **`/metrics` reports `actions: []` for every service** — `health.ts:248`
    reads `svc.actions`, a key that does not exist. Manifest and OpenAPI were
    fixed; this one still needs `customMethodNames()`. *Ten-minute fix.*
12. **`Object.keys()` on a litestone client throws** — duplicate `ownKeys` in
    the proxy. Junction's call site is guarded; the proxy bug is unfixed.
14. **A sixth reserved-key list** — `cli/commands/project/_module.md:65`, a
    source-parsing heuristic that cannot import the shared set.
15. **CLI scaffolds unverified end-to-end** — templates updated twice this
    session, never run through `fli make:model`.
16. **224 typecheck errors** in junction (~76 in `src/`).
17. **No tsconfig in the other 11 packages.**

### Open — from CLAUDE.md, NOT re-verified

Flagged separately because at least one prior diagnosis proved stale.

18 sierra (no README, no example resource; `static`/`widget` unimplemented) ·
19 jetty's diverged `src/resources/` hand-copy ·
20 `mesa-vite/` invisible to the workspace glob ·
21 audit logger writes 0 rows ·
22 `frontierjs-vscode` does not build ·
23 ~~`css` is not a package~~ *(fixed — v0.10.0, tested, with a demo app)* ·
24 caravan `autoloadJobs` scoping bug ·
25 conduit a version behind its consumers' docs ·
26 notifications — **the "empty email bodies" diagnosis does not match the tree**
(the package has no `src/`); re-verify before acting ·
27 auth near-zero flow coverage

### Also open

- Partial success for bulk **patch/remove** — creates only, so far.
- If any in-flight code uses the old `publish()` hook *and* a service declares
  `channel:`, it will broadcast twice. The hook still works; grep before merging.

---

## How to see it work

```bash
cd packages/junction
bun test                      # 681
bun run typecheck             # 224 — the ratchet
bun run example/fullstack/app.ts     # http://localhost:3400
```

`example/fullstack/` is the end-to-end demo and doubles as a test that unit
tests cannot replace — it is what found most of the table above. Three files:

| file | what it establishes |
|---|---|
| `db/schema.lite` | table, `@@gate`, field rules |
| `services/posts.service.ts` | the service — `createBaseService({ channel, allowBulk })` |
| `public/index.html` | the Resource — `client.resource('posts')` |

Open it in two tabs; create in one, it appears in the other; delete it, it goes
from both.

Its README carries the running list of what walking that road surfaced.

**Backgrounding servers from a tool call is unreliable in this environment.**
`nohup`/`setsid` both dropped the process. What works: a script that
`Bun.spawn`s the app, polls until it answers, runs the assertions, and kills it.
There are examples of that shape in the session history.

---

## Conventions worth knowing before editing

- **`DECISIONS.md` is authoritative.** Four rulings were added on 2026-08-02
  (envelope, `$`-as-transport-syntax, `errors[]`/bulk partial success, one event
  origin + scaffold-opts-you-in). Check it before "fixing" any of that back.
- **Comments explain the failure, not the mechanism.** The code written this
  session says what went wrong and why the shape prevents it. That is
  deliberate — most of these bugs were invisible in review and obvious in a
  running app. Match it.
- **Fake clients hide real bugs.** The accessor fix passed every test written
  against `{ post: {…} }` plain objects and failed against every real Litestone
  client. `tests/real-litestone-client.test.ts` exists so that class of
  assumption cannot pass again — put cross-package behaviour there.
- **`ctx.result` must be `null`, not absent,** when hand-building a
  `ServiceContext` in a test. `runPipeline` reads non-null as "a before hook
  already answered" and skips the method. Cost me four confusing failures.
