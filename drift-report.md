# Drift Report

Working document — not permanent. Findings from the 12-package audit
(2026-07-31/08-01): twelve parallel explorers, each given `ARCHITECT.md`
verbatim, each returning the §6 template; synthesized per §7. Line-number
citations reflect the 2026-07-31 working tree — verify before relying on them.

Verdict legend (per ARCHITECT.md §6):
**code-wrong** — the model is right, the code drifted ·
**model-wrong** — the code found something the vocabulary can't name ·
**intentional** — the gap is a boundary ·
**✔ FIXED** — resolved since the audit (see Resolution log).

---

## Resolution log (fixed 2026-08-01, all suites green after)

- **Litestone migrations executor** — rebuild copied added columns from the old
  table (silent data loss/corruption via SQLite's DQS fallback); `splitStatements`
  fused whole files at the transaction `BEGIN`; no ROLLBACK on failure. All
  fixed; blocked-rebuild policy added; 8 regression tests.
- **Litestone gates fail-open** — `@@gate` now enforced by default when declared
  (see `DECISIONS.md`).
- **Litestone query/write semantics** — where-field warn/error, `take/skip`
  rejection, data-key stripping, required-field pre-flight (see `DECISIONS.md`).
- **Litestone docs/examples** — named gates canonical in `access-control.md`;
  all examples PascalCase-singular, modern `createClient`+`autoMigrate` boot;
  stale `example/example/` deleted; gate-example level-label off-by-one fixed.
- **Junction `createService({model})` dropped derived hooks** — gates/validation
  silently absent on the direct path → fixed (forwards hooks; `'*'` pipeline
  fallback for hook-less actions).
- **Junction `X-Service-Method` lowercasing** — camelCase actions were guaranteed
  404s → case preserved.
- **Junction error mapping** — litestone `AccessDeniedError`/`ValidationError`
  crossed the boundary as 500s → 403/400.
- **Junction health probe** — assumed raw `bun:sqlite` shape; litestone proxy
  throws on unknown props → healthy app reported degraded → shape-guarded.
- **`packages/junction/example/elegant.ts`** added — the verified 80%-path demo.

---

## Cross-package synthesis (the coherence review, condensed)

Ranked by cost of being wrong.

**1 · `Hook` is one word for five mechanisms** — phase chain (junction
before/after/around/error; sierra resource hooks), boundary checkpoint (sierra
`beforeNavigate`; gate enforcement), transport Request→Response wrappers
(junction "middleware" — the forced `rateLimit` vs `rateLimitHook` rename is
the receipt), fire-and-forget observers (`ConduitHooks`), required single-slot
delegates (auth's `onPasswordResetRequested`). Litestone alone has three
(transform hooks / plugin veto interceptors / post-commit notifications).
Proposed split, by "can it change the outcome?" and "is it required?":
**Hook** (mutate/halt) / **Guard** (allow-deny only) / **Observer**
(fire-and-forget) / **Delegate** (required performer). Junction's four-field
context split (`auth` frozen+propagates, `client` read-only+propagates,
`route` router-only, `locals` fresh-per-call) is the done convergence work for
§5's "hook context shape" item — promote it.

**2 · Real-time has three origins and two dead ends** — litestone `onEvent`:
zero listeners; junction emits each lifecycle moment twice (`svc:created` on
`app.events` vs `svc created` on channels; the browser parses only the space
form); jetty hardcodes Feathers-style names nothing declares; auth emits
nothing; caravan emits telemetry only. Concrete failure: an `asSystem()` write
in a job emits an event nobody hears. Fix shape: Data realm is the single
origin (junction subscribes to litestone `onEvent` and derives), event names
declared not assumed, colon/space collapsed, **Event** vs **Trace** (telemetry)
split in vocabulary.

**3 · `Resource` is the weakest core noun** — sierra files its own primary noun
under `src/junction/` as an integration detail; jetty hand-copied the
implementation (already diverged); junction's client has a third, thinner
`resource()` contract; three reactivity idioms coexist. Proposals: UI realm
gets a second noun **Component** (what the UI *is* — Mesa) beside Resource
(what the UI *gets* — Sierra); **Binding** names the reactive seam
(`watchProxy`); extract a shared `resources-core` to end the jetty/sierra copy.

**4 · One missing concept, invented independently four times** — a swappable
implementation of a contract: auth "provider" (`IAuth`), notifications
"driver", junction mail "adapters", conduit transports. One vocabulary entry
(**Provider**: "a Plugin adds; a Provider replaces"). Related nameless
load-bearers: **Envelope** (junction's result shape — its namelessness caused
the `protect()` password leak), **Transport** (notifications' "channel"),
**Target** (conduit), **Job** (caravan).

**5 · `Plugin` does double duty** — small composable extension vs whole domain
facility attaching via the protocol (caravan/conduit/auth). "One plugin, one
job" is meaningful for the first and meaningless for the second. Also: the
plugin protocol itself violates principle 2 (every `register()` mutates the
host app; `_metricsProviders` reach-through) — bless named attachment points
(`app.registerMetricsProvider(...)`) or write the exception down.

**6 · Remaining word collisions** — `Channel` broadcast-set vs delivery-medium
(both load-bearing in one notifications file); `Boundary` realm↔realm vs
app↔world (**Edge** proposed); `Manifest` claimed by Deployment noun, MV3
`manifest.json`, and sierra's route table (cede to MV3: Deployment noun →
**Release**, sierra's → **Route Table**); `Gate` = ordinal check vs SQL policy
(litestone's own docs call them orthogonal: **Gate** vs **Policy**);
`Trust Hierarchy` appears zero times in code (code says `LEVELS`).

**7 · The domain map lacks an axis** — realm and domain are orthogonal
coordinates forced into one field; nearly every package is a cross-cut
(junction hosts seams of D3/4/5/6/7; the CLI owns the Deployment realm).
auth and notifications are a *shape* the map can't express: vertical
**Slices** (schema fragment + service + plugin + resource as one unit) —
add as a second axis, which also predicts what `fli add <slice>` scaffolds.
Domain 8 is a junk drawer; jetty/css/mesa-vite/vscode are unmapped; Orion and
Basecamp are mapped but absent.

**8 · The dependency graph is prose** — the stated direction is real but wired
by peer-deps, dynamic imports, duck-typing, and copies. Sierra: three
undeclared workspace deps + two hand-rolled exports-map resolvers guarded by
11 tests. No tsconfig outside vscode, so declared-type bridges are never
checked. Every convention-wired bridge found was broken somewhere; every
named/typed one had survived.

**Principle revisions the code argues for** — P1's "and nothing more" is
falsified by shipped Litestone (topology, retention, FTS, state machines);
real content is "no UI behavior, no business logic" + a named exemption for
framework-owned storage (jobs table, `conduit_targets`, sessions), and the
seed's canonical path should be owned by litestone, not asserted by sierra.
P3 needs stated carve-outs (transport directives `ctx.dispatch`/`statusCode`;
sierra `provideSlot`; LSP pushes; build pipelines). §5's query-param entry was
wrong (`$skip` exists nowhere; the gap is only the `$` prefix).

---

## Per-package findings

### litestone — Data realm · shipped v1.0.6

State: the strongest package; ~0.85:1 test:source, 1 TODO in 18K LOC, 44 docs.
- ✔ FIXED: gates fail-open; migration executor chain; query-input swallowing;
  NOT-NULL raw errors; two-gate-syntax docs; example naming drift.
- `Gate` = two mechanisms (`@@gate` ordinal pre-check vs `@@allow/@@deny`
  compiled to SQL WHERE) — **model-wrong**; propose Gate vs Policy.
- "Trust Hierarchy" unused in code (`LEVELS`) — **code-wrong**, cheap rename.
- `Hook` = three mechanisms in one package (transform / plugin veto /
  post-commit notify) — **model-wrong**.
- `onEvent` post-commit emitter has zero workspace listeners while junction
  emits independently — **code-wrong** (accidental gap); single-origin fix in
  synthesis §2. Related: `@@log(audit)` logger-driver demo writes 0 rows in
  the examples (pre-existing; async flush suspected — unresolved).
- `src/transform/` (~2K LOC data-transformation DSL, "CLI-only, not ORM") is
  exported from the main entry — **model-wrong**; D5 work in a D2 package.
- Multi-tenancy is db-per-tenant only; the one word hides the isolation model
  — propose Tenant DB vs Tenant Scope.
- Seed path `db/schema.lite` is defined by a consumer (sierra defaults), and
  the `.lite` language itself has no noun — the seed is unnamed.
- Second-tier migrations polish (open): rollback-stance docs / `--backup`;
  post-rebuild row-count assertion; second-granular timestamp collisions;
  `verify` phrasing for unexpected live columns.

### junction — API realm · working ("pre-alpha")

- ✔ FIXED: derived-hooks drop on `createService({model})`; empty pipeline for
  hook-less actions; header-dispatch lowercasing; litestone error mapping;
  health probe.
- **Structural refactor list (proposed, sequenced, awaiting go):**
  1. Service conflates definition and runtime (`hooks()` recompiles in place;
     `_hookMap`/`_pipelines`/`_compiledPipelines`; `[method: string]` index
     signature; two public factories with a lossy handoff and duplicate
     reserved-key lists — the same bug class shipped twice). Target: one
     `createService`, inert `ServiceDefinition` → `CompiledService` built once,
     `describe()` for manifest/openapi.
  2. Two real-time emitters → single origin, channels subscribe; per-service
     `publish:` declaration kills the hand-wired triple.
  3. Envelope gets one module (currently wrapped/unwrapped in five places;
     caused the `protect()` password leak).
  4. Core vs batteries export tiering (~140 root exports); ownership treaty
     with siblings (scheduler vs caravan, mail shape vs notifications,
     adapters vs conduit).
  5. Transport middleware vs hook pipeline: name both layers, one
     registration story, uniform `apiPrefix` for plugin routes.
- Live bugs: `/metrics` reads nonexistent `svc.actions` (always empty);
  `app.db` declared public then nailed shut at runtime; 7 test-drift failures
  + 1 module error (tests import `createLitestoneService`, which no longer
  exists).
- Ships raw TS (`main: index.ts`), Bun-only, unpublishable as-is; auth imports
  it by relative path despite declaring the dep.
- DX polish list (open): partial `IAuth` acceptance; `publish('name')`
  shorthand + write-phase alias; typed `createSchema` inference; `ctx.locals.db`
  typing; channels plugin declaration-merge so `app.channel` isn't optional.
- What fits perfectly: Hook/Chain/Plugin shapes; the four-field context split.

### sierra — UI meta-framework · working (SPA)

- Three undeclared workspace deps (mesa/junction/litestone) + two hand-rolled
  exports-map resolvers + 11 tests protecting them — **code-wrong**; declaring
  `workspace:*` deletes ~150 lines and a documented failure class. Highest
  leverage fix in the package.
- `target: 'static'` and `'widget'` accepted and unimplemented
  (`getStaticPaths` validated, never called) — build or delete.
- `prefetch` bypasses `sierraFetch` → silent 401s on protected loads —
  one-line fix.
- Two Hook species in one package (navigation checkpoints vs resource phase
  chain) — the sharpest term-doing-two-jobs case; see synthesis §1.
- Route artifact named "manifest" (collides with Deployment noun) — rename
  Route Table. Postbuild/devtools/analytics halves aren't UI realm; the
  seven-plugin `sierraContext` chain is an unnamed Build realm where the
  schema→UI bridge actually lives.
- Downstream already broken against its surface: notifications example imports
  `resource, derived, get` (don't exist); cli scaffold imports `connected`
  (now `status.connected`).
- No README — the only core package missing one.

### mesa — UI substrate · working→shipped core

- True leaf (zero workspace deps) — protect this property.
- `externalSignals`: hand-maintained cross-package registry that fails
  silently static — **code-wrong**, authors already diagnosed
  (`PLAIN_OBJECT_STATE.md`); retiring it also deletes sierra's list.
- `mesa-vite/` nested inside the package → invisible to workspace glob →
  HMR algorithm copied 3× (sierra ×2, jetty) — promote to `packages/mesa-vite`.
- Emitted runtime specifier hardcoded → sierra and jetty each carry resolveId
  shims — make it a compiler option.
- No public/internal export split (~50 compiler internals + ~180 runtime names
  through the main doors); three disagreeing version numbers; `spec-check.mjs`
  imports a path from another machine; documented siblings mesa-email/mesa-ui
  don't exist in-repo (email-kit tests can't pass).
- `config.plugins` are actually compile-stage Hooks — rename.
- Vocabulary: mesa's `boundary`/`gate` (async suspense) collide with the
  brief's Boundary/Gate — platform words the brief can't own.

### auth — Domain 6 slice · working, deployed, undertested

- One test file covering schema accessors only; zero coverage of login/
  sessions/reset/API keys.
- Four factory names in circulation, three nonexistent
  (`createLitestoneAuthPlugin`, `createFjsAuth`…) — **code-wrong**.
- **Two seeds for one schema**: `fli auth:install` hand-transcribes divergent
  fragments (old scalar names, unreachable `@@gate("9.9.4.9")`) instead of
  calling `authSchemaFragments()` — the sharpest P1 violation found. Fix: one
  seed, imported.
- `cookieAuth` writes a cookie junction's `extractToken` never reads —
  **code-wrong** (junction-side fix).
- API keys minted but never accepted: `verifySession` doesn't sniff `fjs_`
  and delegate to `verifyApiKey` (the better-auth adapter does — the escape
  hatch outperforms the default, inverting principle 9).
- Emits zero events (registration/login/reset) — notifications
  reverse-engineers "user registered" from an `authMethod` string.
- `_sessionTtl` back-channel field smuggles config from provider to plugin;
  re-implemented rate limiter due to ctx-shape mismatch (the Hook-context
  issue in the wild); README documents `@@gate("9")` where code says `"8"`.

### caravan — Domain 5 · working, unshipped edges

- `autoloadJobs`: `dir` declared inside try, referenced outside → every file
  hits the catch — the flagship declarative path cannot load a single job;
  untested — **code-wrong, blocking**.
- Admin guard reads `ctx.params.headers` (real shape: top-level `headers`) →
  with a secret set, every request 401s — **code-wrong**; should be a declared
  Gate/trust level, not a bespoke bearer secret.
- `cancel()` on a running job silently reverted by `markDone` — README, code
  comment, and behavior disagree.
- Emits telemetry only, never domain events → admin UI must poll.
- Doc drift ×4 (`unschedule` doesn't exist; three different default db paths;
  `dead` status documented+tested but absent from the union; fli detects
  `app.caravan` but the plugin mounts `app.jobs`).
- Own SQLite `jobs` table outside the seed — **intentional**; needs the named
  framework-storage exemption in P1.

### conduit — Domain 4 · shipped narrow

- Version skew: `JunctionCaravanConfig`-style promises (`defineTarget`,
  `autoloadTargets`, `registerFactory`, `conduit.dir` config) documented by
  consumers but absent from the package — ship or delete the promise.
- Management service returns `TargetDescriptor.auth` verbatim — plaintext
  provider secrets over an authenticated endpoint — redact at the boundary.
- `ConduitHooks` are observers that can't mutate — rename (synthesis §1).
- `app._metricsProviders` `instanceof` probe — needs a named attachment point.
- Transports untested (all transport tests run through StubTransport);
  `stream()` is a no-op on http/unix while the API implies otherwise;
  conflicting `app.conduit` type vs junction's `unknown` (invisible without a
  tsconfig).

### notifications — vertical slice · working, zero tests

- Email transport passes `MailLine[]` to mailers that read only `html`/`text`
  → **every notification email sends with an empty body** — the two-owners-of-
  one-shape bug; one `MailMessage` owner + a lines→html renderer.
- Model accessor spelled three ways across README/driver/example.
- UI example imports sierra APIs that don't exist; `channels.email.mailer`
  config accepted and ignored; formatters invoked twice per delivery; `sms`
  escapes the fail-fast taxonomy.
- `Channel` means transport here and broadcast-set in junction — in one file —
  rename to Transport (cheapest now, zero importers).
- Right by design: `db.asSystem()` write around its own gated service
  (C=9 closes the service path deliberately); silent real-time degradation
  (durability ≠ liveness).

### cli (`fli`) — Domain 1 · working

- `--layer` flag where the brief mandates realm (`validate`, `project:map`) —
  the most developer-visible vocabulary drift; `realm:` key in project-map
  means "host package" — rename `host`.
- `POST /api/env` uses unimported `writeFileSync` → ReferenceError; duplicate
  `dev` alias resolves by readdir order; advertised commands don't exist
  (`fli create`, `fli dev`, `fli add notifications`).
- `context` = ambient capability bag vs the framework's request Context —
  **model-wrong**; needs its own name.
- Two config files (`.fli.json` + `frontier.config.js`), and `.fli.json`
  doubles as the project-root marker — fold and separate concerns.
- `auth:install` scaffold: see auth §2 (the two-seeds bug lives here).
- Where the brief is strongest: `make:scaffold`/`make:service --auto` literally
  implement "the schema is the seed"; deploy steps map cleanly onto
  Manifest/Release.

### jetty — UI container · working, pre-production

- Hand-copy of sierra's resource layer, already diverged — extract
  `resources-core` (its own `docs/future-refactors.md` trigger condition is
  met).
- Event channel names hardcoded to an assumed convention — breaks seed
  traceback exactly at the real-time boundary.
- `src/junction/` contains a placeholder wire protocol that is not Junction's
  — rename `service-adapter/`.
- Escape hatch wired to throw: custom `main.js` is discovered, then
  `vite-config.js` throws "not yet supported in Phase 0".
- Private noun set (Harbor/Dock/Pier/Island/Surface) — **model-wrong**: four
  execution contexts where the brief assumes one; "Surface" proposal (a place
  a Resource can bind) collides with css's "Surface" (presentation) — needs
  one adjudication.
- Correct by design: no client-side gates; call-down/value-up held cleanly.

### frontierjs-vscode — Domain 1 · stub

- Does not build: `build-parser.js` resolves the parser's pre-move path;
  icons referenced but absent (vsce would fail); Mesa support fully written
  but commented out AND unloadable (no `allowJs`).
- Hand-copied forks of litestone's attribute table, level names, and gate
  docs — three copies that drift; proposal: litestone exports a **Lexicon**
  (machine-readable description of its own language) and the extension
  renders it.
- Types `parse()`'s result non-nullable; crashes on the normal mid-keystroke
  syntax-error state.
- Mesa bridge searches `@mesa/compiler` — pre-rename name.
- Architecture split (LSP for litestone, in-process JS for mesa) — decide one
  before shipping.

### css — UI · stub (not a package)

- No `package.json` → not a workspace member; `index.css` imports 22 paths
  that don't exist (flattened layout); source of truth lives outside the repo
  (chat-handoff doc); built for a Svelte stack this repo doesn't use; zero
  references from anywhere.
- One real bridge candidate: mesa's `renderComponent({ unocss })` accepts
  exactly the shape of `uno.config.ts` — one import turns dead CSS into the
  UI realm's style layer. Also: `presetIcons` missing for the documented icon
  convention; `.link` documented but not defined.
- Its 29-term markup vocabulary and six principles are good work with no home
  — keep behind a namespaced boundary (M1–M6), don't merge into the brief.
- The brief's gap it exposes: UI realm has one noun for two concerns; the
  presentation concern (Theme/Surface) is unbudgeted.

---

## Appendix — concrete bug list (one line each)

Fixed 2026-08-01: litestone migration rebuild data loss/corruption ✔ ·
splitStatements BEGIN fusion ✔ · no-ROLLBACK apply ✔ · gates fail-open ✔ ·
where/take-skip/data/required semantics ✔ · junction derived-hooks drop ✔ ·
action-header case ✔ · litestone-error 500s ✔ · health false-degraded ✔ ·
stale `example/example/` ✔ · gate-example SYSTEM/LOCKED label off-by-one ✔.

Open: caravan `autoloadJobs` scoping · caravan admin guard ctx shape (always
401) · caravan `cancel()` revert race · auth 4-factory naming · CLI divergent
auth schema copy · `cookieAuth` inert · API keys never accepted · auth emits
no events · notifications empty email body · notifications accessor ×3 ·
notifications broken sierra example · conduit secrets unredacted · conduit
doc/version skew · junction `svc.actions` metrics · junction colon/space dual
events · junction test-drift (7 fails + missing `createLitestoneService`) ·
sierra undeclared deps · sierra prefetch auth bypass · sierra dead
static/widget targets · mesa `externalSignals` · mesa-vite nesting/HMR copies ·
mesa runtime-specifier shims · vscode build paths + null-schema crash · cli
`/api/env` ReferenceError · cli duplicate `dev` alias · css not-a-package ·
litestone audit-logger 0 rows (cause unknown) · litestone `onEvent` unheard.
