# FrontierJS — Map

Bun-workspace monorepo: a schema-seeded fullstack framework. One mental model — three realms, three nouns:
**Data (Model) → API (Service) → UI (Resource)**, plus Deployment (Release) and Testing (Suite).
Everything derives from `db/schema.lite`. `ARCHITECT.md` §2 is the vocabulary for design discussion.

## Evolution policy

Pre-alpha and nothing has shipped: **prefer evolving existing designs over preserving them**. Existing behavior is evidence, not a constraint. A rename moves every caller in the same change and keeps no alias, deprecation window or compatibility flag; `PHILOSOPHY.md` § IV's *familiarity vs. precision* is about the ecosystem's habits, never this framework's own past. Only the **Invariants** below and rulings in `DECISIONS.md` are binding. **Preserve the mental model, not the mechanism**; where docs disagree, reconcile.

**A change that turns on a judgment call runs `decision-rules`** (`.claude/skills/`): adding an option, coining a noun, choosing between two designs, or finding the code and a document disagree. **This file is only what is live.** History is git, open defects `ISSUES.md`, settled arguments `DECISIONS.md`.

---

## Invariants

Don't violate without an explicit decision; record it in `DECISIONS.md` if you do. The numbers are citation keys — never renumber. What enforces each one is `invariants.snapshot.md`.

1. **Dependency direction** — `Litestone ← Junction ← Sierra`, never reverse.
2. **Model names are PascalCase singular** (`model Lead` → `db.lead`); `@@external` exempt. Three resolvers depend on this agreeing.
3. **App layout** — `db/` at the root and each SURFACE a directory beside it: `api/`, `web/`, `site/`, `widgets/`, `extension/`, `desktop/`, `mobile/` and `cli/`; `test/` belongs to a surface and `tests/` to the app. `shared/` is a root that is not a surface: it holds pure code two surfaces import as `#shared/*`, and it imports neither of them (`FJS-D1320`). A surface folded inside another inherits its build, port and release (`FJS-D127`, `FJS-D985`). Never *derive* a config path from where `vite.config.js` sits — probe, or be told. Canonical: `README.md` § Project Structure.
4. **One owner per translation.** Exactly one place turns a thrown value into an HTTP status, one wraps/unwraps the result envelope, one parses `$`-params into `ctx.directives`, one announces a write, one startup phase list every caller runs. Add to the owner, never beside it; the owners are § Bridge index.
5. **One owner per `app.<thing>`.** Take it with `app.own(name, value)` (`FJS-D06`, `FJS-D1255`); type it by augmenting an exported interface, never by redeclaring the property — declaration merging requires identical types, so a redeclaration silently loses.
6. **Access is declared in the schema, not in hooks.** Gates, `@encrypted`, `@guarded`, `@@transitions` are enforced at the Data boundary. `x-gate` on the client is a UI affordance only — unknown answers are permissive and the server enforces regardless. No exceptions.
7. **Protected fields are redacted in the audit trail.** `@encrypted`/`@guarded`/`@secret`/`@hashed` log as `[redacted]`, `@personal` as `[personal]` and `@opaque` as `[opaque:<digest>]`, in field entries and in `before`/`after` images.
8. **Caller-supplied names never enter a SQL pattern.**
9. **Patch semantics: an explicit `null` clears.** Test key presence (`key in updates`), not `??`.
10. **A `$`-PREFIXED KEY is transport syntax only.** `ctx.query` is filters, `ctx.directives` is `{limit, offset, orderBy, select}`, and no `$`-prefixed key survives the bridge but the combinators `$or`/`$and`/`$not` (`FJS-D910`); one the table (`@frontierjs/toolbelt/directives`) does not name is REFUSED by name (`FJS-D237`, `FJS-D125`). Junction's ambient `$` is a different thing (`VOCABULARY.md` § The sign `$`).
11. **The nearest delegation root owns an event.** Roots nest; a handler must fire once.
12. **Mesa compiler output is reproducible** — scope ids are content-addressed, which is what makes CSS dedupe work across the two compilers a static build runs.
13. **`@frontierjs/css` is the styling language.** Style with a tone (`danger`) and a treatment (`outlined`), never a color. UnoCSS is an opt-in layer an app configures, so a package in this repo ships no utility classes.
14. **Typecheck baselines ratchet down only.** `scripts/typecheck-baselines.json`, one number per package; absent means 0. `bun run typecheck -- --update` writes an improvement back.
15. **A clean compile is not proof of valid JS.** Compiler tests parse their output.
16. **Runnable examples are verified, not sketches.** A broken one is a bug.
17. **Three markdown files at a package root is the standard** — `README.md`, `CLAUDE.md`, `PROJECT_STATE.md`; everything else in `<pkg>/docs/`. `AGENTS.md` is a permitted fourth (`FJS-D163`). A fifth is a `package-root-md` warning to answer. Generated `*.snapshot.md` is exempt.
18. **In a Sierra app, `src/resources/` holds `.mesa` files, and a resource file carries its model's default form.** The `<script module>` data half is required and the markup half is optional; a file with no `<script module>` is a component in the wrong folder (`FJS-D112`).
19. **A resource file is named for its noun — PascalCase, singular — one Resource per file.** `App.mesa` exporting `export const apps`; where a model exists the filename IS the model name, so an irregular is visible.

---

## Running things

- **Always `cd` into the package and run its own script.** Runners differ per package and a wrong runner produces failures that belong to nothing; `bun test` in place of `bun run test` is one. `bun run --filter '*' test` from the root runs them all. Which runner each package uses and what it needs: `docs/TESTING.md`.
- **`bun run ci` is the whole of CI**, `fli ci` from anywhere in the workspace. What fails each phase, and every allowance: `docs/CI.md`.
- **`fli proves --from main` names the drives a change needs, `fli prove` runs them, and `fli done` says whether it is finished.** Run `fli done` before calling a change complete and clear what it lists, or say in a sentence why an item stays.
- **A dev server serves the code it started with** (`FJS-740`): start the one the run will test and refuse a port that already answers — `docs/TESTING.md` § Dev servers. Every vite config sets `strictPort`; the port table is `docs/PORTS.md`.
- **Search a tree with `rg`** — a `PreToolUse` hook refuses a recursive `grep`; `grep` on a named file or a pipe is fine.

---

## House style

Match the file you are in first. The code rules load from `.claude/rules/code-style.md` when a source file is read; these are the ones a new file needs before any read.

- **No semicolons**, single quotes, 2-space indent. TypeScript in junction, auth, caravan, conduit and every `conduit-*` connector (`FJS-D890`), notifications, mcp and testing; plain ESM JavaScript in every other package.
- **A comment explains the failure, not the mechanism, and must be load-bearing.** Edit history and narration of your own change belong in `DECISIONS.md` and git (`FJS-D675`). Inside a template literal a comment uses plain words or `--` quoting — a backtick there closes the literal.
- **American spelling** in prose and identifiers (`FJS-D192`); `cancelled`, a persisted enum value, is the one exception.
- **A document an agent reads is written by `doc-hygiene`** (`.claude/skills/`), and **a plan is Phases of Steps** in that skill's § A plan's shape (`FJS-D927`). A section a parser reads moves only with its parser — modules read this file's Invariants and Bridge index by path.
- **A new defect gets an `FJS-###` in `ISSUES.md`**; a ruling closes an `FJS-D##` in `DECISIONS.md`.

---

## Live hazards

**The realm catalogs are skills** (`.claude/skills/`) — each fires on its own realm; reach for one by name where the trigger has not fired, and add a new hazard to its realm's skill. **`/which-skill` is the order across all of them**, user-invoked. Hazards belonging to no realm are `docs/CI.md` § Repo hazards.

| Realm | Skill | Fires on |
| ----- | ----- | -------- |
| Data | `data-hazards` | litestone · a `.lite` schema · a gate or row policy · a migration · tenancy · encryption · the audit trail |
| API | `api-hazards` | junction · a service · the hook pipeline · HTTP/WS transport · a raw route · a plugin · a job or cron |
| UI | `ui-hazards` | mesa · sierra · a `.mesa` file · a resource · a form · a tether · prerender · islands · `@frontierjs/css` |

---

## Packages

**Every package has its own `CLAUDE.md`, loaded when you read a file in that package** — what it owns, its traps, and which drive proves a change. `fli ws:atlas --as=rings` draws every package with its realm, state and ring.

<!-- Packages table. repo-map.js and repo-rings.js parse it by path, so it moves only with them; a block comment costs no context. No separator row: a comment holds no double dash.
| Package | Realm/Domain | What it is | State | Ring |
| litestone | Data / D2 | `.lite` language + parser, SQLite client, gates and policies, migrations, tenants, Litestone Studio; **the Testing realm's Data half** | Shipped. **It runs in a browser, and two seams are what make that one codebase** (`FJS-D305`): `#sql-engine` (`src/core/engine.js`) picks what runs the SQL — `bun:sqlite` on a server, SQLite's own wasm over `opfs-sahpool` in a worker — and `#host` (`src/host/`) picks everything else the runtime provides. | spine |
| junction | API / D8 | Services, hook pipeline, HTTP/WS transport, channels, browser client; batteries (mail, cache, scheduler, webhooks, AI, the transactional outbox, the backfill, the governed extract) | Shipped. **Bun-only and no version of it is not** — `Bun.serve` is the transport, `Bun.file` is logging and static, `bun:sqlite` is cache and database. | spine |
| sierra | UI meta | File-tree routing → route table + Vite build; `createResource`; postbuild/deploy; **the theme switch** | Shipped. Four targets: `spa`, `static`, `widget`, and the extension surface jetty serves. | spine |
| mesa | UI substrate | `.mesa` compiler + signal runtime; leaf — no framework-package dependency, `@frontierjs/toolbelt` excepted | Shipped. Run in a real browser rather than described — `test/browser/`, two drives over one shared CDP harness that `@frontierjs/ui` reads by relative path, because mesa is the leaf and one client means a trap learned in one drive is fixed for both. | substrate |
| auth | D6 | Native `IAuth` over litestone `asSystem()`; schema fragments + `/auth/*` plugin | Shipped. **A route ESTABLISHES a session, everything after it is a service** (`FJS-D20`): `/auth/*` keeps register, login, logout, password-reset and email-verify, while `account`, `sessions` and `api-keys` are services. | batteries |
| caravan | D5 | SQLite job queue + cron → `app.jobs` | Working. **`dispatch({ id })` is the idempotency `unique` is not** — a stated id is the jobs table's primary key, so the dispatch is a no-op until `cleanupAfter` sweeps the finished job, where a `unique` key frees itself the moment the job is terminal. | batteries |
| conduit | D4 | The third parties an app integrates with, declared in one place — both ends of the relationship (`FJS-D177`); `app.conduit.send()` is how a call leaves, `app.conduit.receive()` is how a Provider's delivery arrives (`FJS-D899`). | Working, narrow. **A target declares its own resilience** — seven numbers falling back field by field to the conduit-wide option of the same name, because one conduit carries a card processor, a mail sink and a health probe and one set of timeouts fits none of them. | batteries |
| notifications | rig | Notifications → in-app record + WS event + email fan-out (`app.notify`) | Working. **A notification is a FILE and the file names it** — `defineNotification` states no type, and the loader stamps `OrderPaid.notification.ts` as `OrderPaid`, the rule `<name>.job.ts` already follows. | batteries |
| mcp | API / agent | **The agent surface** — an MCP endpoint over a FrontierJS app, the gate as the permission model, tool visibility per standing (`FJS-D258`) | Working. **`mcp()` mounts inside the API that is already running**, which is the ruling's one-execution-path clause taken one process further: stdio would have to BOOT the app, and a boot here starts a second Caravan worker on `jobs.db`, runs the migration differ, and gives an agent an event bus no browser tab is on. | batteries |
| outpost | D7 / fleet | **The process a fleet server runs** — Basecamp's hands on a machine. | Working. **Two listeners and the second one is the point** (`FJS-D345`): the signed command port, and a static origin on 8181 serving an `inline` app's files — a pasted page is a stranger's script and a port is an origin, so sharing one would put the fleet protocol inside every prototype. | frontier |
| cli (`fli`) | D1 | Markdown-native command runtime; scaffolds, deploy, workspace/release, port broker | Working. **`fli check` is the arch-test surface, and where the live-hazard catalog executes** (`FJS-D133`) — rules over an app and over this workspace, each silent when broken, grading only a claim with an AUTHORITY in the tree. | tooling |
| jetty | UI container | Browser-extension app container (Mesa UI + SW relay to Junction) | Working. **An app gets it as the `extension/` surface** — a peer of `api/`/`web/`, `fli make:extension` + `fli extension:{dev,build,audit}`. | batteries |
| frontierjs-vscode | D1 | Litestone language server + Mesa editor support | Working, unpublished — it needs a marketplace publisher account. | tooling |
| create-frontier | D1 | `npm create frontier@latest my-app` — the front door | Working. An entry point and nothing else: it resolves `@frontierjs/cli` and runs `fli new`, so there is one implementation of what an app looks like. | tooling |
| config | cross-cutting | The tooling opinion an app extends in one line — `tsconfig`, `biome`, `editorconfig`. | Working. **The config is a dependency, never a copy** (`FJS-D33`) — a copy is frozen at the moment it was written. | tooling |
| toolbelt | cross-cutting | Pure-function kits, zero deps — **substrate below the dependency graph, not a member of it** (`FJS-D26`), so any package may import it, litestone and mesa included. | Shipped. It holds the facts that have many possible answers and must have one, which is what the import license buys. | substrate |
| css | UI | Semantics-first design system, plain CSS, no build step | Shipped. **`vocabulary.js` is the source** — read by the guide AND by the spec, which checks both directions against the real CSSOM, so shipping a class it does not name fails the suite. | substrate |
| ui | UI | Mesa component kit over `@frontierjs/css` | Shipped. **Every component forwards its caller's attributes**, and a form control puts them on the CONTROL rather than the `.field-group` wrapper, because that is what a `<label for>` and an `aria-describedby` must reach. | batteries |
| testing | Testing / Suite | `createTestEnv`'s API tier — a real Junction app over the env's own Litestone client | Working. Sits **above Junction** and is imported by nothing, which is the whole reason it exists: Litestone's `createTestEnv` cannot mount an app without importing Junction (Invariant 1). | batteries |
| email-kit | UI / email | Table-based email components + `target: 'email'` wrapper — an MJML replacement | Working. Never opened in a real mail client; Outlook conditional-comment handling is fragile — see its `docs/` | batteries |
| print-kit | UI / print | One headless-Chromium render worker behind one seam — a document to a PDF, an element to a PNG, over `@frontierjs/mesa/drive` | Working. **The print page runs offline with scripts off**, because a document is built from landed data that is somebody else's; one tab serves 25 jobs then is replaced, so a node id a tagged table names counts up across jobs. Moved in from the Transit prototype (`FJS-D816`); `example` sends no PDF yet. | batteries |
| site-kit | UI / site | The engine a markdown-authored static site takes as a dependency — shell, build, blocks, check; the site is its `content/` folder | Working, private until its first release. **A client's own look and blocks come from the Preset it names in `content/settings/site.js`** (`FJS-D648`), so a site writes no engine file. | batteries |
| orion | D5 / automations | Flows of triggers, conditions and actions, run by an engine installed into the app (`FJS-D269`) | Ported (`IDEAS/orion-port.md` phases 1–6); publishable, never released (`FJS-1369`). | batteries |
| basecamp | D7 / app | **Fleet operations app. An FJS application, not a library** — the largest dogfooding surface | Working. All three realms real, zero raw SQL, and every model declares `@@gate`. | frontier |
| haven | D7 / app | **A place in the terminal** — `fli haven` walks into a hosted FJS app; the first one with strangers on it (`FJS-D976`–`FJS-D979`) | Schema only (`IDEAS/haven.md` 1.1). **A ban is a row policy, so a banned member reads an empty room** rather than a 403 — a refusal would tell a spammer when to mint a new key. | frontier |
| oracle | Data / modeling | The step before `db/schema.lite`: a catalog of canonical entities, the checks a model's answer must pass, and an emitter from that answer to `.lite` — no model inside (`FJS-D601`) | Working, private. **Access is derived, never written**: a row policy is assembled from who the answer says reaches a row, so a signed-in level with no policy cannot be emitted by accident. `mockup/` is the old React recognizer, kept as reference. | tooling |
-->

---

## Bridge index — the named cross-package handoffs

**Before adding a cross-package handoff, or grepping for one, load `bridge-index`** (`.claude/skills/`) — it names the owner of each seam: a gate copy, an error mapper, the result envelope, a directive, a schema keyword, a broadcast, a tether.

<!-- Bridge index key list. seams.js, register-check.js (seam:) and checks/repo.js (seam-listed) parse it by path; every seam the skill explains is named here.
**Data → API** — `$setAuth(user)` / `asSystem()` · `$tapEvents(fn)` · `withLitestoneDb(db)` · `gateAuth()` + `autoValidate()` · `validateInput(type)` · `customMethodGrade(method, declared, levels)` · `needsBackfill` · `sessionGateLevel(user)` · `toDataPrincipal(user)` · `bearerClaim()` / `BEARER` / `bearerOf()` · `bearerClaim(...).mint()` / `.redeem()` · `resolveTenancy(schema)` / `registry.tenantFor({host, headers, principal})` · `accessorCandidates()` · `db.$checkWhere(accessor, where)` · `db.$checkOrderBy(accessor, orderBy)` · `db.$readAs(accessor, row, principal)` · `db.$checkWrite(accessor, op, row, changes?)` · `db.$levelOf(accessor, principal)` · `db.$primaryKey(accessor)` · `db.$mirrorKey(accessor)` · `db.$protectedFields(accessor)` · `db.$claimsFor(principal)`

**Schema → API/UI** — `generateJsonSchema(schema)` · `ctx.system` · `ctx.transients` · `ServiceTypes` · `@label` · `buildFieldRules()` / `validateAgainstFields()` / `coerceToSchema()` / `normalizeBlanks()` · `controlFor(rule, {field, model})` / `formFieldList(fields, {only, except, model})` · `labelFieldInfo(fields, fallback, declared)` · `x-values` · `resource.options(field)` · `toFieldErrors(err)` · `$context.form` · `buildRelations()` / `buildGate()` / `canAtLevel()` · `x-version` · `x-rank` · `retryable` · `buildTransitions()` / `transitionsAt()` · `buildCommitments()` / `commitmentsAt()` · `modelNameFor()` / `schemaFor()` · `authUserModel(db)` / `authMachineryModels(db)` · `extend model X { … }` · `attachments`

**Machine ↔ control plane** — `app.conduit.receive(receiver)` / `Dialect` · `app.conduit.mirror(claim)` / `mirrored(accessor)` · `signRequest()` / `verifyRequest()` · `requestMeta().traceparent` / `.tracestate` · `ctx.raw.rawBody`

**API internals** — `$` / `enterCall(ctx, fn)` / `currentCall()` · `$.config` / `app.configFor(tenant)` · `$.log` · `bridge.toContext()` / `toResponse()` · `toFrameworkError()` · `wrapResult(raw, service, method)` / `unwrapResult()` / `isServiceResult()` · `enterRequest(src, fn)` / `reenterAs(user, fn)` · `ctx.directives` · `collectCustomMethods(def, name, methods?)` · `CALL_OPTIONS_AT` · `svc.pipelines(appHooks)` · `svc.describe()` · `isBuiltService(v)` / `Symbol.for('junction.service')` · `normalizePrefix()` · `ctx.enqueue(job, payload)` / `deliverOutbox(app)` · `claimIdempotency(ctx, key, config)` · Plugin protocol `{ name, register, boot, work, ready, shutdown, requires }` · `runStartPhases(bindHost)` · `IAuth.verifySession(token)` · `app.principal()` / `app.runAs(userId, fn)` · `app.withDb(fn)` / `app.onTenantClient(observer)` · `createLitestoneAuth(db, { sessionFields })` · `manifest()` · `app.registerMetricsSource(name, fn)` / `app.registerReadiness(name, fn)` · `app.registerDevService(name, { url, note })` · `devtools({ port, auth })`

**API → UI** — `client.setCallHeader(name, value)` + `config.http.callHeaders` · `x-fjs-build` · `wsSend()` / `flushSendQueue()` · **A broadcast is GRADED per recipient, in cohorts** · `announce()` · **Transport: WebSocket when one is connected, HTTP as the fallback.** · `createJunctionClient()` / `client.resource(name)` · `connectApp()` / `createResource(name, { app })` · `relay` → `client.forward(call)` / `client.receive(frame)` · `resource.save(data, { mode })` · `resource.move(id, { after, before, into })` · `client.auth.*` · `signIn` → `completeSignIn(code)` · `client.auth.providers()` + `OAUTH_ERRORS` / `session.oauthMessage` · `tokenStorage` · `client.entries` / `resource.record(id)` · `matchesQuery(fields, record, query)` · `$after` / `endCursor` / `tethered().more()` · `comparatorFor(orderBy)`

**UI** — `*.mount.js` · `page.query` / `page.directives` · `watchProxy()` / `createSignal()` / `createRoot(fn)` · `mount(label, Component, {props, root})` · `renderComponent(src, opts)` · `appSrcDir(root)` / `appAliasPlugin()` · `swapInstances(entries, newFn, newSetMark, label)` · `island(anchor, Comp, props, block, meta)` · `deploySite({ root, config, preview, alias, dry })` · **The theme is a class on `<html>` and Sierra owns the switch** · **There is no cross-package reactivity registry.**
-->

---

## Where to look

- **Starting cold** → `HANDOFF.md`. **Beside the owner, not on their branch** → `ALONGSIDE.md`.
- **What is wrong** → `ISSUES.md` (closed rows age out to `ISSUES_ARCHIVE.md`). **What to work on next** → `fli next`.
- **What is settled** → `DECISIONS.md`; check it before relitigating. **What waits on the owner** → `fli decisions`; write the options into the question's bullet (`**A** — …`, `**Recommend X** — why`) rather than answering in chat.
- **What is not started** → `IDEAS/`, never cited as behavior; `IDEAS/overview.md` ranks it.
- **Mental model, axioms, defined words** → `ARCHITECT.md`, `PHILOSOPHY.md`, `VOCABULARY.md`. **How to know something is true** → `VERIFYING.md`.
- **Testing, CI, ports, consistency, threats** → `docs/TESTING.md`, `docs/CI.md`, `docs/PORTS.md`, `docs/CONSISTENCY.md`, `THREATS.md`. **The workspace, read rather than described** → `fli ws:atlas` (`--as=report` is the runbook).
- **Trying a change end to end** → `example/`, the kitchen sink across every surface; start at its `PROJECT_STATE.md`.

## Communication style

Respond in caveman mode (see ~/.claude/skills/caveman/SKILL.md), level: full.
