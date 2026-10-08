# FrontierJS — Map

Bun-workspace monorepo: a schema-seeded fullstack framework. One mental model — three realms, three nouns:
**Data (Model) → API (Service) → UI (Resource)**, plus Deployment (Release) and Testing (Suite).
Everything derives from `db/schema.lite`; growth happens outward and traces back.

`ARCHITECT.md` §2 is the default vocabulary for design discussion. Depart from it when a different word is materially clearer — then fold the clearer word back in rather than keeping two.

## Evolution policy

FrontierJS is pre-alpha. **Prefer evolving existing designs over preserving them.** Existing behavior is evidence, not a constraint.

**Nothing here has shipped, so there is no back-compat to keep.** A rename is a rename: one name for one thing, with every caller moved in the same change and nothing kept for the old spelling — no alias, deprecation window, migration path or compatibility flag. `PHILOSOPHY.md` § IV's *familiarity vs. precision* is about the ECOSYSTEM's habits and never about this framework's own past; reading it as a reason an existing spelling should survive is the way this policy is most often lost.

Only two things are binding: the **Invariants** below, and rulings in `DECISIONS.md`. **Preserve the mental model, not the mechanism.** Where docs disagree, assume different stages of a pre-alpha design and reconcile.

**A change that turns on a judgment call runs `decision-rules`** (`.claude/skills/`). It fires on the ACT rather than on the doubt: adding an option, coining a noun, restating something already stated, choosing between two designs, or finding the code and a document disagree.

**This file is only what is live**, and a line here earns its place by changing what someone does in the next hour. History belongs in `packages/*/CHANGES.md`, open defects in `ISSUES.md`, settled arguments in `DECISIONS.md`.

---

## Invariants

Don't violate without an explicit decision; record it in `DECISIONS.md` if you do. The numbers are citation keys — never renumber. What enforces each one is `invariants.snapshot.md`.

1. **Dependency direction** — `Litestone ← Junction ← Sierra`, never reverse.
2. **Model names are PascalCase singular** (`model Lead` → `db.lead`); `@@external` exempt. Three resolvers depend on this agreeing.
3. **App layout** — `db/` at the root and each SURFACE a directory beside it: `api/`, `web/`, `site/`, `widgets/`, `extension/`, `desktop/` and `cli/`. `test/` belongs to a surface and `tests/` to the app. A surface folded inside another inherits its build, port and release, and a `site/` inside `web/` is emptied by the next SPA build (`FJS-D127`). Never *derive* a config path from where `vite.config.js` sits — probe, or be told. Canonical: `README.md` § Project Structure.
4. **One owner per translation.** Exactly one place turns a thrown value into an HTTP status, one wraps/unwraps the result envelope, one parses `$`-params into `ctx.directives`, one announces a write, one startup phase list every caller runs. Add to the owner, never beside it; the owners are § Bridge index.
5. **One owner per `app.<thing>`.** Claim it with `app.claim(name, value)`; type it by augmenting an exported interface, never by redeclaring the property — declaration merging requires identical types, so a redeclaration silently loses. The verb is not `provide`, because a Provider is a third party the app speaks to (`FJS-D06`).
6. **Access is declared in the schema, not in hooks.** Gates, `@encrypted`, `@guarded`, `@@transitions` are enforced at the Data boundary. `x-gate` on the client is a UI affordance only — unknown answers are permissive and the server enforces regardless. No exceptions.
7. **Protected fields are redacted in the audit trail.** `@encrypted`/`@guarded`/`@secret`/`@hashed` log as `[redacted]` and `@personal` as `[personal]`, in field entries and in `before`/`after` snapshots.
8. **Caller-supplied names never enter a SQL pattern.**
9. **Patch semantics: an explicit `null` clears.** Test key presence (`key in updates`), not `??`.
10. **A `$`-PREFIXED KEY is transport syntax only.** `ctx.query` is filters, `ctx.directives` is `{limit, offset, orderBy, select}`, and no `$`-prefixed key survives the bridge — one the table does not name is REFUSED there by name (`FJS-D237`). The table is `@frontierjs/toolbelt/directives`; what the values mean is `@frontierjs/toolbelt/query` (`FJS-D125`). Junction's ambient `$`, the call in progress, is a different thing sharing a character.
11. **The nearest delegation root owns an event.** Roots nest; a handler must fire once.
12. **Mesa compiler output is reproducible** — scope ids are content-addressed, which is what makes CSS dedupe work across the two compilers a static build runs.
13. **`@frontierjs/css` is the styling language.** Style with a tone (`danger`) and a treatment (`outlined`), never a color. UnoCSS is an opt-in layer an app configures, so a package in this repo ships no utility classes.
14. **Typecheck baselines ratchet down only.** `scripts/typecheck-baselines.json`, one number per package; absent means 0. `bun run typecheck -- --update` writes an improvement back.
15. **A clean compile is not proof of valid JS.** Compiler tests parse their output.
16. **Runnable examples are verified, not sketches.** A broken one is a bug.
17. **Four markdown files at a package root is the standard** — `README.md`, `CLAUDE.md`, `PROJECT_STATE.md`, `CHANGES.md`; everything else in `<pkg>/docs/`. `AGENTS.md` is a permitted fifth, for a package's consumers (`FJS-D163`). A sixth is a `package-root-md` warning to answer — move the file or record why it stays. Generated `*.snapshot.md` is exempt.
18. **In a Sierra app, `src/resources/` holds `.mesa` files, and a resource file carries its model's default form.** A Resource is a UI-realm noun, written in the UI-realm language. The `<script module>` data half is required and the markup half is optional; a file with no `<script module>` is a component in the wrong folder (`FJS-D112`).
19. **A resource file is named for its noun — PascalCase, singular — one Resource per file.** `App.mesa` exporting `export const apps`; where a model exists the filename IS the model name, so an irregular is visible.

---

## Running things

**Always `cd` into the package and run its own script.** Runners differ per package and a wrong runner produces failures that belong to nothing. `bun run --filter '*' test` from the root runs them all, one each. `bun test` instead of `bun run test` runs bun's own runner over whatever it finds — in mesa that is dozens of failures that are runner artifacts. Which runner each package uses and what it needs (Chrome, network, Docker) is `docs/TESTING.md`.

**A package's suite is `test/`; `*.test.*` is COLLECTED and `*.spec.*` is DRIVEN** — a `.spec` exports `run`, sits in `specs/`, and is imported by the `run.mjs` beside it.

**`bun run ci` is the whole of CI** — `ci:fast` skips the suites, `--only <pkg>` narrows, `--phase <name>` runs one. `fli ci` is the same call from anywhere in the workspace. What fails each phase, and every allowance, is `docs/CI.md`.

**Which drive proves a change is `fli proves`** (`--from main` on a branch): it reads the diff against `DRIVES.md` and names each drive the change needs and what to start first. A change is not proved until those drives have run; **`fli prove` runs them**, each after its *Start first* steps. **`fli done` says whether it is finished** — run it before calling a change complete and clear what it lists, or say in a sentence why an item stays.

**A dev server serves the code it started with**, and a port that answers is not evidence the right process holds it (`FJS-740`). Start the server the run will test and refuse a port that already answers. Backgrounding a server from a tool call is unreliable here; a script that spawns it, polls, asserts and kills it works — `example/web/test/verify-build.mjs` is the shape. Detail: `docs/TESTING.md` § Dev servers.

**Search a tree with `rg`** — it skips `node_modules` and gitignored build output. A `PreToolUse` hook in `.claude/settings.json` refuses a recursive `grep`; `grep` on a named file or a pipe is fine.

**Ports: `port = env*1000 + category*100 + project*10 + service`** (env 7 test · 8 dev · 9 prod). `packages/cli/core/ports.js` is the schema; `fli dev` hands each app root a slot as `FLI_PORT_*`; 8500–8509 is reserved for fli tooling. **Every vite config sets `strictPort`** — vite otherwise hops ports in silence and one app's drive tests another app. The table and its exceptions: `docs/PORTS.md`.

---

## House style

Match the file you are in first. The code rules load from `.claude/rules/code-style.md` when a source file is read; these are the ones a new file needs before any read.

- **No semicolons**, single quotes, 2-space indent. TypeScript in junction, auth, caravan, conduit, notifications, mcp and testing; plain ESM JavaScript in every other package.
- **A comment explains the failure, not the mechanism, and must be load-bearing.** Edit history, dates and narration of your own change belong in `CHANGES.md`, `DECISIONS.md` and git.
- **A comment inside a template literal uses plain words or `--` quoting** — a backtick there closes the literal and the file fails to parse.
- **American spelling** in prose and identifiers (`FJS-D192`); `cancelled`, a persisted enum value, is the one exception, and `fli check` grades it.
- **A document an agent reads is written by `doc-hygiene`** (`.claude/skills/`). **A section a parser reads moves only with its parser** — modules read this file's Invariants, Packages table and Bridge index by path.
- **A new defect gets an `FJS-###` in `ISSUES.md`**; a ruling closes an `FJS-D##` in `DECISIONS.md`. Check a new `.gitignore` rule against `git status --porcelain`.

---

## Live hazards

**The realm catalogs are skills** (`.claude/skills/`) — each fires on its own realm; reach for one by name where the trigger has not fired, and add a new hazard to its realm's skill. **`/which-skill` is the order across all of them**, user-invoked.

| Realm | Skill | Fires on |
| ----- | ----- | -------- |
| Data | `data-hazards` | litestone · a `.lite` schema · a gate or row policy · a migration · tenancy · encryption · the audit trail |
| API | `api-hazards` | junction · a service · the hook pipeline · HTTP/WS transport · a raw route · a plugin · a job or cron |
| UI | `ui-hazards` | mesa · sierra · a `.mesa` file · a resource · a form · a live store · prerender · islands · `@frontierjs/css` |

**Repo** hazards belong to no realm:

- **A `file:` dependency (jetty's `file:../mesa`) installs a COPY under `node_modules/.bun/`, not a symlink**, so an edit to mesa is invisible to it until reinstall. In-repo tests import workspace source by relative path.
- **Nested directories are invisible to the `packages/*` glob** — uninstalled, untested, unrunnable. `oracle/mockup` is the one named allowance; a second shows up as a CI note naming the path.
- **`bun test` runs in UTC whatever the host is set to.** A test that means local time sets `TZ` itself and builds every `Date` after setting it. Everything STORED is UTC.
- **Publishing a package silences every loose peer range that names it**, and below 1.0 a caret pins the MINOR. `fli ws:exports` commits the published surface to `exports.snapshot.md`, and the `snapshots` phase fails a stale one.

---

## Packages

**Every package has its own `CLAUDE.md`, loaded when you read a file in that package** — what it owns, a file-by-file layout map, its traps, and which drive proves a change. History is its `CHANGES.md`, state its `PROJECT_STATE.md`, open items `ISSUES.md`. This table is the one-line version. **Ring** is the order a newcomer reads them in, center out, and `fli ws:atlas --as=rings` draws it from this column — a package with none lands in *unplaced*.

| Package | Realm/Domain | What it is | State | Ring |
| --- | --- | --- | --- | --- |
| litestone | Data / D2 | `.lite` language + parser, SQLite client, gates and policies, migrations, tenants, Litestone Studio; **the Testing realm's Data half** | Shipped. **It runs in a browser, and two seams are what make that one codebase** (`FJS-D305`): `#sql-engine` (`src/core/engine.js`) picks what runs the SQL — `bun:sqlite` on a server, SQLite's own wasm over `opfs-sahpool` in a worker — and `#host` (`src/host/`) picks everything else the runtime provides. | spine |
| junction | API / D8 | Services, hook pipeline, HTTP/WS transport, channels, browser client; batteries (mail, cache, scheduler, webhooks, AI, the transactional outbox, the backfill, the governed extract) | Shipped. **Bun-only and no version of it is not** — `Bun.serve` is the transport, `Bun.file` is logging and static, `bun:sqlite` is cache and database. | spine |
| sierra | UI meta | File-tree routing → route table + Vite build; `createResource`; postbuild/deploy; **the theme switch** | Shipped. Four targets: `spa`, `static`, `widget`, and the extension surface jetty serves. | spine |
| mesa | UI substrate | `.mesa` compiler + signal runtime; leaf — no framework-package dependency, `@frontierjs/toolbelt` excepted | Shipped. Run in a real browser rather than described — `test/browser/`, two drives over one shared CDP harness that `@frontierjs/ui` reads by relative path, because mesa is the leaf and one client means a trap learned in one drive is fixed for both. | substrate |
| auth | D6 | Native `IAuth` over litestone `asSystem()`; schema fragments + `/auth/*` plugin | Shipped. **A route ESTABLISHES a session, everything after it is a service** (`FJS-D20`): `/auth/*` keeps register, login, logout, password-reset and email-verify, while `account`, `sessions` and `api-keys` are services. | batteries |
| caravan | D5 | SQLite job queue + cron → `app.jobs` | Working. **`dispatch({ id })` is the idempotency `unique` is not** — a stated id is the jobs table's primary key, so the dispatch is a no-op for all time, where a `unique` key frees itself the moment the job is terminal. | batteries |
| conduit | D4 | The third parties an app integrates with, declared in one place — `app.conduit.send()`. | Working, narrow. **A target declares its own resilience** — seven numbers falling back field by field to the conduit-wide option of the same name, because one conduit carries a card processor, a mail sink and a health probe and one set of timeouts fits none of them. | batteries |
| notifications | rig | Notifications → in-app record + WS event + email fan-out (`app.notify`) | Working. **A notification is a FILE and the file names it** — `defineNotification` states no type, and the loader stamps `OrderPaid.notification.ts` as `OrderPaid`, the rule `<name>.job.ts` already follows. | batteries |
| mcp | API / agent | **The agent surface** — an MCP endpoint over a FrontierJS app, the gate as the permission model, tool visibility per standing (`FJS-D258`) | Working. **`mcpPlugin()` mounts inside the API that is already running**, which is the ruling's one-execution-path clause taken one process further: stdio would have to BOOT the app, and a boot here starts a second Caravan worker on `jobs.db`, runs the migration differ, and gives an agent an event bus no browser tab is on. | batteries |
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
| orion | D5 / automations | Flows of triggers, conditions and actions, run by an engine installed into the app (`FJS-D269`) | Being ported (`IDEAS/orion-port.md`). | batteries |
| basecamp | D7 / app | **Fleet operations app. An FJS application, not a library** — the largest dogfooding surface | Working. All three realms real, zero raw SQL, and every model declares `@@gate`. | frontier |
| oracle | Data / modeling | The step before `db/schema.lite`: a catalog of canonical entities, the checks a model's answer must pass, and an emitter from that answer to `.lite` — no model inside (`FJS-D601`) | Working, private. **Access is derived, never written**: a row policy is assembled from who the answer says reaches a row, so a signed-in level with no policy cannot be emitted by accident. `mockup/` is the old React recognizer, kept as reference. | tooling |

---

## Bridge index — the named cross-package handoffs

**The entries are the `bridge-index` skill** (`.claude/skills/`); this is the KEY LIST, so *is there an owner for this already* is answerable without loading the skill. A name below is a promise the skill explains it — reach for them before grepping.

**Data → API** — `$setAuth(user)` / `asSystem()` · `$tapEvents(fn)` · `withLitestoneDb(db)` · `gateAuth()` + `autoValidate()` · `validateInput(type)` · `customMethodGrade(method, declared, levels)` · `needsBackfill` · `sessionGateLevel(user)` · `toDataPrincipal(user)` · `bearerClaim()` / `BEARER` · `resolveTenancy(schema)` / `registry.tenantFor({host, headers, principal})` · `accessorCandidates()` · `db.$checkWhere(accessor, where)` · `db.$checkOrderBy(accessor, orderBy)` · `db.$readAs(accessor, row, principal)` · `db.$levelOf(accessor, principal)` · `db.$primaryKey(accessor)` · `db.$protectedFields(accessor)` · `db.$claimsFor(principal)`

**Schema → API/UI** — `generateJsonSchema(schema)` · `ctx.system` · `ctx.transients` · `ServiceTypes` · `@label` · `buildFieldRules()` / `validateAgainstFields()` / `coerceToSchema()` / `normalizeBlanks()` · `controlFor(rule, {field, model})` / `formFieldList(fields, {only, except, model})` · `labelFieldInfo(fields, fallback, declared)` · `x-values` · `resource.options(field)` · `toFieldErrors(err)` · `$context.form` · `buildRelations()` / `buildGate()` / `canAtLevel()` · `x-version` · `retryable` · `buildTransitions()` / `transitionsAt()` · `buildCommitments()` / `commitmentsAt()` · `modelNameFor()` / `schemaFor()` · `authUserModel(db)` / `authMachineryModels(db)` · `extend model X { … }` · `attachments`

**Machine ↔ control plane** — `signRequest()` / `verifyRequest()` · `requestMeta().traceparent` / `.tracestate` · `ctx.$raw.rawBody`

**API internals** — `$` / `enterCall(ctx, fn)` / `currentCall()` · `$.config` / `app.configFor(tenant)` · `$.log` · `bridge.toContext()` / `toResponse()` · `toFrameworkError()` · `wrapResult(raw, service, method)` / `unwrapResult()` / `isServiceResult()` · `enterRequest(src, fn)` / `reenterAs(user, fn)` · `ctx.directives` · `collectCustomMethods(def, name, methods?)` · `CALL_OPTIONS_AT` · `svc.pipelines(appHooks)` · `svc.describe()` · `isBuiltService(v)` / `Symbol.for('junction.service')` · `normalizePrefix()` · `ctx.enqueue(job, payload)` / `deliverOutbox(app)` · `claimIdempotency(ctx, key, config)` · Plugin protocol `{ name, register, boot, work, ready, shutdown, requires }` · `runStartPhases(bindHost)` · `IAuth.verifySession(token)` · `app.principal()` / `app.runAs(userId, fn)` · `app.withDb(fn)` / `app.onTenantClient(observer)` · `createLitestoneAuth(db, { sessionFields })` · `manifestPlugin()` · `app.registerMetricsSource(name, fn)` / `app.registerReadiness(name, fn)` · `app.registerDevService({ name, url, note })` · `devtools({ port, auth })`

**API → UI** — `client.setCallHeader(name, value)` + `config.http.callHeaders` · `x-fjs-build` · `wsSend()` / `flushSendQueue()` · **A broadcast is GRADED per recipient, in cohorts** · `announce()` · **Transport: WebSocket when one is connected, HTTP as the fallback.** · `createJunctionClient()` / `client.resource(name)` · `connectApp()` / `createResource(name, { app })` · `relay` → `client.forward(call)` / `client.receive(frame)` · `resource.save(data, { mode })` · `client.auth.*` · `signIn` → `completeSignIn(code)` · `client.auth.providers()` + `OAUTH_ERRORS` / `session.oauthMessage` · `tokenStorage` · `client.nodes` / `resource.record(id)` · `matchesQuery(fields, record, query)` · `$after` / `endCursor` / `resource.more()` · `comparatorFor(orderBy)`

**UI** — `*.mount.js` · `page.query` / `page.directives` · `watchProxy()` / `createSignal()` / `createRoot(fn)` · `mount(label, Component, {props, root})` · `renderComponent(src, opts)` · `appSrcDir(root)` / `appAliasPlugin()` · `swapInstances(entries, newFn, newSetMark, label)` · `island(anchor, Comp, props, block, meta)` · **The theme is a class on `<html>` and Sierra owns the switch** · **There is no cross-package reactivity registry.**

---

## Where to look

- **Starting cold** → `HANDOFF.md`, the two most recent sessions.
- **What is wrong** → `ISSUES.md` (closed rows age out to `ISSUES_ARCHIVE.md`; search both). **What to work on next** → `fli next`.
- **What is settled** → `DECISIONS.md`; check it before relitigating. **What is waiting on the owner** → `fli decisions`; write the options into the question's bullet (`**A** — …`, `**Recommend X** — why`) rather than answering in chat.
- **What is not started** → `IDEAS/`, never cited as behavior; `IDEAS/overview.md` ranks it.
- **Mental model and vocabulary** → `ARCHITECT.md`; the axioms above it → `PHILOSOPHY.md`; the defined words → `VOCABULARY.md`.
- **How to know something is true** → `VERIFYING.md`.
- **The workspace, read rather than described** → `fli ws:atlas` (`--as=report` is the runbook: what to run, from where, every snapshot and its generator).
- **Testing, CI and ports reference** → `docs/TESTING.md`, `docs/CI.md`, `docs/PORTS.md`.
- **What a write guarantees after it returns** → `docs/CONSISTENCY.md`.
- **Trying a change end to end** → `example/`, the kitchen sink across every surface; start at its `PROJECT_STATE.md`.

## Communication style

Respond in caveman mode (see ~/.claude/skills/caveman/SKILL.md), level: full.
