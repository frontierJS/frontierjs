# FrontierJS — Map

Bun-workspace monorepo: a schema-seeded fullstack framework. One mental model — three realms, three nouns:
**Data (Model) → API (Service) → UI (Resource)**, plus Deployment (Release) and Testing (Suite).
Everything derives from `db/schema.lite`; growth happens outward and traces back.

`ARCHITECT.md` §2 is the default vocabulary for design discussion. Depart from it when a different word is materially clearer — then fold the clearer word back in rather than keeping two.

## Evolution policy

FrontierJS is pre-alpha. **Prefer evolving existing designs over preserving them.** Existing behaviour is evidence, not a constraint.

Only two things are binding: the **Invariants** below, and rulings in `DECISIONS.md`. Everything else may change — prefer simplifying, removing duplication, and improving consistency over reproducing what is there. **Preserve the mental model, not the mechanism.**

Where docs disagree, assume different stages of a pre-alpha design and reconcile, rather than treating either as wrong.

**This file is only what is live.** History belongs in `packages/*/CHANGES.md`, open defects in `ISSUES.md`, settled arguments in `DECISIONS.md`. A line here earns its place by changing what someone does in the next hour.

---

## Invariants

Don't violate without an explicit decision; record it in `DECISIONS.md` if you do.

1. **Dependency direction** — `Litestone ← Junction ← Sierra`, never reverse. Mesa is a leaf with zero workspace deps.
2. **Model names are PascalCase singular** (`model Lead` → `db.lead`); `@@external` exempt. Three resolvers depend on this agreeing.
3. **App layout** — `db/` + `api/` + `web/` at the root; most sub-projects carry `config/ src/ public/ test/ dist/ deploy/` (db/ doesn't). Configuration lives in `config/`, `vite.config.js` included. Canonical: root `README.md` §Project Structure. Never *derive* a config path from where `vite.config.js` sits — probe, or be told.
4. **One owner per translation.** Exactly one place turns a thrown value into an HTTP status, one wraps/unwraps the result envelope, one parses `$`-params into `ctx.directives`, one announces a mutation, one startup phase list every caller runs. Implementations are in §Bridge index. Add to the owner, never beside it.
5. **One owner per `app.<thing>`.** Claim it with `app.provide(name, value)`; type it by augmenting an exported interface, never by redeclaring the property — declaration merging requires identical types, so a redeclaration silently loses.
6. **Access is declared in the schema, not in hooks.** Gates, `@encrypted`, `@guarded`, `@@transitions` are enforced at the Data boundary. `x-gate` on the client is a UI affordance only — unknown answers are permissive and the server enforces regardless. No exceptions.
7. **Protected fields are redacted in the audit trail.** `@encrypted`/`@guarded`/`@secret` log as `[redacted]` in field entries and in `before`/`after` snapshots.
8. **Caller-supplied names never enter a SQL pattern.**
9. **Patch semantics: an explicit `null` clears.** Test key presence (`key in updates`), not `??`.
10. **`$` is transport syntax only.** `ctx.query` is filters, `ctx.directives` is `{limit, offset, orderBy, select}`; nothing past the bridge sees a `$`.
11. **The nearest delegation root owns an event.** Roots nest; a handler must fire once.
12. **Mesa compiler output is reproducible** — scope ids are content-addressed, which is what makes CSS dedupe work across the two compilers a static build runs.
13. **`@frontierjs/css` is the styling language.** Style with a tone (`danger`) and a treatment (`outlined`), never a colour. UnoCSS is supported *alongside* it as an opt-in layer a consuming app configures (`packages/css/README.md` §Using it with UnoCSS). A package in this repo ships no utility classes — a component needing Uno to look right is unusable by an app that does not run it.
14. **Typecheck baselines ratchet down only.** `scripts/typecheck-baselines.json`, one number per package; absent means 0. `bun run typecheck -- --update` writes an improvement back.
15. **A clean compile is not proof of valid JS.** Compiler tests parse their output.
16. **Runnable examples are verified, not sketches.** A broken one is a bug.
17. **At most four markdown files at a package root** — `README.md`, `CLAUDE.md`, `PROJECT_STATE.md`, `CHANGES.md`. Everything else in `<pkg>/docs/`.
18. **In a Sierra app, `src/resources/` holds `.mesa` files.** A Resource is a UI-realm noun, written in the UI-realm language. A resource file has no markup; its code goes in `<script module>` (Mesa VISION §11, rule 30).
19. **A resource file is named for its noun — PascalCase, singular — one Resource per file.** `App.mesa` exporting `export const apps`; the same split the Data realm makes between `model App` and `db.app`. Where a model exists the filename IS the model name, so an irregular is visible (`AlertRule.mesa` exporting `alerts` says `model:` must be stated). A resource over no model takes its service noun, singularised.

---

## Running things

**Always `cd` into the package and run its own script.** Runners differ per package and a wrong runner produces failures that belong to nothing. `bun run --filter '*' test` from the root runs them all, one each. `bun test` instead of `bun run test` runs bun's own runner over whatever it finds — in mesa that is ~35 failures that are runner artifacts.

| Where                                                     | Test                                         | Runner                                                | Needs                                               |
| --------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------- |
| litestone                                                 | `bun run test` (`test:smoke` = CLI only)     | bun                                                   | —                                                   |
| junction                                                  | `bun run test` (`test:all` adds the example) | bun                                                   | —                                                   |
| mesa · sierra · email-kit                                 | `bun run test`                               | **vitest**                                            | —                                                   |
| sierra                                                    | also `bun run test:safety`                   | bun, standalone                                       | a real litestone client                             |
| auth · caravan · conduit · notifications · cli · basecamp · testing | `bun run test`                               | bun                                                   | —                                                   |
| utils                                                     | `bun run test`                               | own harness, no deps (node or bun)                    | —                                                   |
| ui                                                        | `bun run test`                               | node — compile-all, render, form                      | —                                                   |
| jetty                                                     | `bun run test`                               | **plain node**, 10 phase files in order               | —                                                   |
| css                                                       | `bun run test`                               | node driving headless Chrome                          | Chrome on PATH or `$FJS_CHROME`                     |
| frontierjs-vscode                                         | **`npm test`** — the package uses npm        | plain node — the server over LSP/stdio, then Mesa's providers against a stubbed editor | builds first; a stale `out/` tests the previous fix |
| everywhere                                                | `bun run typecheck`                          | `scripts/typecheck.mjs`                               | ratchet, see Invariant 14                           |
| everywhere                                                | `bun run ci` (`ci:fast` skips the suites)    | `scripts/ci.mjs`, plain node                          | Chrome, for css                                     |

**`bun run ci` is the whole of CI and it is not a GitHub feature.** One node script runs six phases — hygiene, structure, access, coverage, typecheck, tests — and `.github/workflows/ci.yml` does nothing but call it, so it runs identically on a laptop. It fails a package with no `test` script, a source file `.gitignore` hides, a *raised* typecheck baseline, a committed `access.snapshot.md` that no longer matches its schema, and an **architecture rule broken in this repo's own apps** — `structure` runs `packages/cli/core/checks.js`, the same engine `fli check` gives a client app, because two implementations of one rule is how a framework ends up breaking rules it publishes. A suite known to fail is named so a NEW failure is loud. Every allowance is a named entry with a reason in `scripts/ci-allowances.json`. `bun run hooks:install` points `core.hooksPath` at `scripts/hooks`, whose `pre-push` runs the fast tier (~40s); the suites (~3 min) belong in the workflow, because a pre-push costing minutes teaches everyone `--no-verify`. `--only <pkg>` narrows typecheck and tests.

**The browser drives need their servers started by hand, first.** They exit 1 naming the missing process. All need Chrome.

| Drive                        | Start first                                            | Covers                                                                        |
| ---------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `example`: `verify`          | `bun run api` + `bun run web`                          | schema → API → UI                                                             |
| `example`: `verify:build`    | `bun run api`                                          | the same assertions against the production build; starts/stops its own preview |
| `example`: `verify:ui`       | `bun run api` + `bun run web`                          | `@frontierjs/ui`'s behavioural components — tablist, dialog, combobox, ⌘K     |
| `example`: `verify:live`     | `bun run api` + `bun run web`                          | did a change reach a SECOND tab — WS frame *and* rerender, separately         |
| `example`: `verify:jobs`     | `bun run api`                                          | caravan: deferred work, written back through the service. No browser          |
| `example`: `verify:notify`   | `bun run api`                                          | conduit + notifications, mail at a real server. No browser                    |
| `example`: `verify:public`   | `bun run api` + `bun run build:public`                 | the PRERENDERED build — islands, lazy chunks, nothing gated in the file       |
| `basecamp`: `bun run verify` | nothing — starts and stops both itself                 | an empty database, incl. a11y and the gate ladder                             |
| `basecamp`: `verify:build`   | nothing — builds, then starts and stops both itself    | the PRODUCTION output: tags survive comment-stripping, the page comes up      |

**Which drive proves a change.** Run the package's own suite, then:

| Changed                                | Run                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------- |
| mesa compiler/runtime                  | `example`: `verify` **and** `verify:public` — SSR and hydration fail apart  |
| sierra router/resource/build           | `example`: `verify` + `verify:build`                                        |
| sierra prerender/islands/static-safety | `example`: `verify:public`                                                  |
| junction service/hooks/transport       | `example`: `verify` + `verify:jobs`; `basecamp`: `verify`                   |
| junction channels/publish              | `example`: `verify:live` — nothing else can see a broadcast                 |
| litestone client/policy/gate           | `example`: `verify` + `basecamp`: `verify`, plus `sierra`: `test:safety`    |
| auth                                   | `example`: `verify` (sign-in) + `basecamp`: `verify` (setup + guard)        |
| caravan                                | `example`: `verify:jobs`                                                    |
| conduit · notifications · email-kit    | `example`: `verify:notify`                                                  |
| ui · css                               | `example`: `verify:ui`                                                      |
| utils (`glow`)                         | `css`: `bun run test code` — the theme is asserted against real glow output |

`example` signs in on every browser drive and **login is rate-limited to 10 per 15 minutes across all of them** — a burst of drives fails as "broken app". Run `verify` before `verify:ui` if you run both.

**A dev server serves the code it started with.** A `.mesa` module is transformed once and cached for the life of the process, so editing the compiler invalidates nothing and the app fails exactly as it did before the fix. Start the server the run will test, and refuse a port that already answers. Backgrounding a server from a tool call is unreliable here (`nohup`/`setsid` both drop it); what works is a script that spawns it, polls until it answers, asserts, and kills it — `example/web/test/verify-build.mjs` is the shape.

**Ports.** `port = env*1000 + category*100 + project*10 + service`. `packages/cli/core/ports.js` is the schema — the formula, the category map, and the `PROJECTS` registry. env: 7 test · 8 dev · 9 prod. category: 0 fe · 1 be · 2 widgetDev · 3 widgetServe · 4 ext · 5 tooling. `packages/jetty/src/dev/fjs-ports.js` owns the extension slice (8400–8499 dev, 7400–7499 test).

| Project | id | Frontend | Backend |
| ------- | -- | -------- | ------- |
| whatever `fli new` scaffolds | 0 | 8000 | 8100 |
| `example`                    | 1 | 8010 web · 8011 preview (`verify:build`) | 8110 API · 8111 dev mail sink |
| `basecamp`                   | 2 | 8020 | 8120 |
| `packages/sierra/example`    | 3 | 8030 | 8130 |
| `packages/css` demo/guide    | 4 | 8040 (`$PORT` overrides) | — |
| `packages/oracle/mockup`     | 7 | 8070 (`$PORT` overrides) · 8071 preview | — |
| global fli tooling           | —  | 8500 gui · 8501 project:view · 8502 db studio | — |

The numbers are derived, not chosen: a new app takes the next project id. Ids 0–7 are assigned and `DYNAMIC_PROJECT_FLOOR` starts the allocator at 8, so a dynamic claim cannot land on an assigned app. **Every vite config sets `strictPort`** — vite otherwise hops to the next free port in silence, and the second app's drive tests the first app's app. A scaffolded app reads `FLI_PORT_FE`/`FLI_PORT_BE` when the broker set them; the literal is only the static default.

---

## House style

Match the file you are in first; this is what the repo does when there is no local precedent.

- **Comments explain the failure, not the mechanism.** `// increment the counter` is noise; `// vite hops ports silently, so the drive would talk to the other app` is the house voice.
- **A comment must be load-bearing. Delete it otherwise.** Test: if it vanished, could someone editing this file make a mistake it would have prevented?
  - **No edit history in code** ("used to be", "this replaced X", "merged 2026-08-08"). That is `CHANGES.md`, `DECISIONS.md` and git. Narrow exception: a past bug stated because the shape still invites it (`--ring` in `tokens.css`), where the history IS the warning.
  - **No dates in code comments.** If the comment needs one, it belongs in a decision record the code points at.
  - **No persuasion** — "the whole point", "deliberately", "which is exactly why", italics for emphasis. State the constraint flatly; if it needs selling, it needs a ruling.
  - **Never narrate your own edit.** The reader does not know a change happened.
- **Every non-trivial file opens with a header block** — what it is, and what it is for. Test harnesses document their own traps at the top (`example/web/test/verify.mjs`).
- **Section dividers inside a file**: `// ─── name ──────` (box-drawing, padded to a consistent width). Not `// ---`, not banner boxes.
- **Aligned columns** where a run of lines is parallel — imports, object literals, `const` blocks. See `example/api/app.ts`.
- **Prose in the docs is sentence-shaped, not bullet-shrapnel.** Bold the claim, then say what it cost. Numbers earn their place by being measured.
- **British spelling** in prose (`behaviour`, `serialise`). Identifiers stay US (`color`, `serialize`) where a web API or CSS property already chose.
- **No semicolons**, single quotes, 2-space indent, in TS and JS alike (`packages/css`'s own build/test scripts are the one holdout). TypeScript in junction, auth, caravan, conduit, notifications; plain ESM JavaScript in litestone, mesa, sierra, ui, css, jetty. Do not introduce TS into a JS package.
- **Fake clients hide real bugs.** Cross-package behaviour is tested against the real dependency — `{ post: {…} }` passed every test and failed every real Litestone client.
- **A new defect gets an `FJS-###` in `ISSUES.md`**, not a paragraph in a package file. A ruling closes an `FJS-D##` and moves to `DECISIONS.md`. Check a new `.gitignore` rule against `git status --porcelain` — an ignore glob hid 20 source files once.

---

## Live hazards

**Correct behaviour you have to know about.** Things that are *wrong* live in `ISSUES.md`, one id each; things that are *fixed* live in `CHANGES.md`. If a rule here is pinned by a test that cannot be deleted quietly, it does not need to be here.

**Data**

- **A `@@gate` refuses, a `@@allow` filters — so a wrong policy is an empty screen, not an error.** A gate throws naming the model and the level; a policy compiles silently into the WHERE. Every read that legitimately crosses a policy's scope must be `asSystem()`, or it returns nothing with a 200. Declare one model at a time and run the app's drive between them. **`fli test:access` writes the whole declared surface to a committed `db/access.snapshot.md`** — gates, policy predicates, protected fields, transition gates — and the `access` CI phase fails a stale one, so a gate that moved is a diff rather than a production refusal.
- **You cannot run without gates.** A schema declaring any `@@gate` auto-installs `GatePlugin({ getLevel: FrontierGateGetLevel })` — a declared-but-unenforced gate is fail-open. Installing your own replaces it; installing none does not disable it. Contract: **absent = the app does not model this stage; only `null` grades down**, and standing (`isSystemAdmin`/`isOwner`/`isAdmin`) is checked before the lifecycle.
- **`$setAuth(user)` RETURNS a scoped client, it does not mutate.** `db.$setAuth(u)` then `db.thing.create(…)` grades as anonymous, with no warning. It is `const userDb = db.$setAuth(u)`.
- **A Litestone client THROWS on an unknown property** — never `undefined`, so a typo'd accessor is loud. The cost: feature-detection is itself a throwing expression. `typeof db.$maybe === 'function'` explodes; use `'$maybe' in db` or a `try`. A capability that depends only on the schema belongs on **every** flavour of client — root, `$setAuth`, `asSystem`, `$scopedBy`.
- **Raw SQL requires `asSystem()` once a schema declares access rules.** `db.sql` and `db.$setAuth(u).sql` throw; `db.asSystem().sql` is the bypass, and it can write. Raw statements enforce no `@@gate`/`@@allow`/`@guarded`/`@scoped`/`@@softDelete`. Coarse per schema on purpose — deciding per statement means parsing it, and a wrong validator grants a *false* guarantee. `where: { $raw: sql\`…\` }` keeps every policy and is the hatch to reach for. A JS migration is exempt: the runner hands it the system client.
- **`@guarded` is not a level** — a system-context lock taking only `(all)`; `@guarded(5)` does not parse. Per-role column access is field-level `@allow('read', auth().role == 'admin')`.
- **`encryptionKey` is parsed as hex**, so 64 *characters* is not necessarily 32 bytes. Non-hex padding decodes short and is rejected with `must be 32 bytes (got 1)`.
- **`createClient({ db })` names MAIN's path and nothing else.** It overrides a declared `database main`, so `db: ':memory:'` is the in-memory test client; a SECOND declared database keeps its declared path regardless. `databases: ':memory:'` is the shorthand that moves them all, jsonl and logger included. Precedence: `databases: ':memory:'` > `databases: { main: { path } }` > `db` > the declaration.
- **Litestone emits columns verbatim camelCase and `DateTime` as ISO-8601 TEXT.** Hand-written SQL assuming snake_case or epoch-ms will not match.
- **The audit logger defers one event-loop tick**, so a read in the same tick sees 0 rows. `fireLog()` schedules with `setImmediate` and the jsonl driver appends synchronously — anything after an `await` sees the row. Yield once; do not wait.
- **A `where` typo below the boundary warns to stderr and returns no rows.** Over HTTP an unknown key is a 400 naming it (`autoFilter`), but a service building its own filter gets silence. `client.service('x').find({ limit: 100 })` is the trap: the FIRST argument is the filter, `limit` belongs in the second. `find()` answers the list envelope; `findData()` is the rows.

**API**

- **A SERVICE context has no `ctx.params` at all.** It splits into `auth` (the principal) / `client` (`ip`, `userAgent`, `headers`) / `route` (path captures) / `locals` (per-call scratch, where `withLitestoneDb` puts `db`). **A raw-route `TransportContext` DOES have `params`** — that asymmetry is the trap, and stale Feathers idioms survive in Junction's own docs; reading `ctx.params.user` yields `undefined`, so a role check silently passes for everyone. Also: `before: { all: [...] }` applies to *every* method, machine-facing endpoints included.
- **Raw routes (`app.get`/`app.post`) take `{id}`, not `:id`** — `:id` registers as a literal segment and 404s silently forever. Their `ctx` is a `TransportContext`: `params` is path params only, headers are on `ctx.headers`.
- **`apiPrefix` moves EVERY route the app registers**, auth's `/auth/login` and caravan's `/jobs` included, because the `app.get`/`app.post` shortcuts are its one owner. A path that must not move is registered on `app.http.router` directly. An app that sets a prefix proxies one path, not one per plugin.
- **An `Idempotency-Key` on a mutating request now executes once and replays the first answer** — claimed in `callService`, so it holds over HTTP and the socket alike. The replay runs **no hooks**, so an app effect living in one does not happen twice *and does not happen on the replay at all*. Keyed by `(service, method, principal, key)`; a failed call releases the key, an in-flight duplicate is a retryable 409.
- **`hasRoute()` is a matching question, not an existence one** — every app registers `GET /{service}`, which matches almost anything. Use `hasExactRoute(method, path)` for "is this mounted", `routePaths(method)` for what landed where.
- **A wire-only field must be captured in a BEFORE hook, not in the method body.** `autoValidate` deletes every key the model does not declare, and user hooks run *before* the derived ones — so a non-column field is gone by the time a method body reads `ctx.data`. Silent.
- **The METHOD decides list vs single.** `find` must answer a list or it throws `ResultShapeError`; an array is a list; the bulk `{data,errors}` protocol is a list on any method; everything else is a single and travels whole. A service answering one thing names it and calls it as an action; a summary alongside rows is its own action.
- **Never call `ws.send()` directly.** Bun answers `-1` for buffered and **`0` for discarded** past ~16.9MB of unacknowledged data on one socket (`maxBackpressureLimit` is accepted and ignored). `transport/outbox.ts` is the one owner of a send: it holds a dropped frame, flushes on `drain`, preserves order, and past `http.wsMaxQueued` (8MB) closes with 1013 so the client reconnects.
- **A background job has no principal, and no principal is STRANGER(0).** `app.service('x').patch(…)` from a Caravan job defaults to `auth: { user: null }` and is refused by the model's own `@@gate`. Pass `{ auth: { user: SYSTEM } }`, graded in the app's own `getLevel` — `example/api/gate.ts` is the pattern. The alternative, `db.asSystem()`, writes at the Data boundary where nothing announces and every open tab keeps the stale row.
- **Junction resolves every Bearer token through `IAuth.verifySession()` and calls `verifyApiKey` nowhere** (`transport/http.ts`). One door: a key is only verified if the *provider* falls through to its own `verifyApiKey`. A third provider inherits that job.
- **Caravan's `unique` is a lock on work IN FLIGHT, not an idempotency key.** Once a job is terminal the key is free. A key built from a row id is not one either — SQLite reuses ids.

**UI**

- **`createResource` coerces, blank-strips and validates by default.** A bad create throws `ResourceValidationError` in the browser with the request never made, and an untouched text box writes NULL rather than `''`. A resource whose service accepts a shape the model does not describe needs `{ validate: false }` — the symptom otherwise is "the button does nothing" unless something renders the throw. `<Form>` renders it.
- **A required column only the server can fill cannot be created from the browser** — validation refuses before the request, naming fields the caller was never meant to send. The only escape today is `{ validate: false }`; nothing in the schema can say *the system writes this* (`FJS-095`).
- **A Mesa instance `<script>` exports exactly two things.** `export let` is a prop, `export function` is a method on the component's instance API; every other export form is refused by name. **`bind:this` means two things** — on a COMPONENT it gives that instance API (props read through the child's own signals, so `ref.count` is live and writable), on an ELEMENT it gives the node.
- **Mesa's scoped styles do not reach into child components.** Use `:global(...)`; the selector subject carries the hash (`button` → `button.mHASH`). A dynamic `class` MERGES, never replaces — all dynamic classes route through `bindClassPassthrough`.
- **An overlay that is present is not an overlay that is visible.** Kit overlays fade in with `el.animate(…, { fill: 'forwards' })`; an assertion that only asks `querySelector` passes against a fully invisible full-screen backdrop. Assert computed opacity and hit-testing.
- **Headless Chrome delivers almost no rendering lifecycle after load.** Anything behind `IntersectionObserver` must be set up before it; `requestAnimationFrame` hangs. Working pattern: `packages/sierra/tests/fixtures/island-site/verify.mjs`. **`getComputedStyle` goes stale after a class change** — `el.matches()` and `document.styleSheets` report the new state while computed styles stay frozen, and forcing layout does not help. To check a post-click style change, read the rules that match the element.
- **Vite injects the built `<script>` at the first textual match for the body tag and does not skip comments.** Mention it inside a comment in a hand-written `index.html` and the build succeeds, `dist/index.html` looks right, and the page loads no JavaScript. Never write the body tag in a comment.
- **A code sample highlighted with `prefix: true` loses its first character.** `glow()` strips a leading `+`, `-` or `>` as a diff/callout marker, and all three are legal first characters in CSS (`> .child`, `+ .sibling`). `--` is disambiguated; the combinators cannot be, so **a CSS caller passes `prefix: false`**.

**Repo**

- **`bun install` resolves `workspace:*` to a COPY under `node_modules/.bun/`, not a symlink.** An edit to `packages/mesa/src/compiler.js` is invisible to importers until reinstall, so a suite can go green against a stale snapshot. In-repo tests import workspace source by relative path. `packages/ui`'s hand-made symlink will not survive a reinstall.
- **Nested directories are invisible to the `packages/*` glob** — uninstalled, untested, unrunnable. `mesa-bench/` and `orion/mockup/api-engine` are the remaining cases, both named in `scripts/ci-allowances.json`.
- **Publishing a package silences every loose peer range that names it.** While a sibling is unpublished a peer of `"*"` fails at install with the name in the error; the moment it exists, the same range resolves from the registry without a word. **Below 1.0 a caret pins the MINOR** — `^0.1.0` is `>=0.1.0 <0.2.0` — which is both the behaviour wanted for a pre-alpha peer and the trap in the other direction, where a stale caret excludes the only published copies. Nothing catches either shape from inside the workspace: a `workspace:*` devDep answers first and the range is never consulted.

---

## Packages

**Every package has its own `CLAUDE.md`** — what it owns, a file-by-file layout map, its traps, and which drive proves a change. Read that before grepping the package. Per-package history is in `CHANGES.md`, state in `PROJECT_STATE.md`, and open items in `ISSUES.md`; this table is the one-line version.

| Package | Realm/Domain | What it is | State |
| --- | --- | --- | --- |
| litestone | Data / D2 | `.lite` language + parser, SQLite client, gates+policies, migrations, tenants, studio; **the Testing realm's Data half** | v1.1.0, published · green. `createTestEnv` is the environment (template-clone db, factories, `actingAs`/`atLevel`, `setup`/`phases`). Four executed checks — `verifyGateLadder` (every gated model × level × op), `verifyConstraints`, `verifyFieldProtection`, `verifyRowPolicies` (the compiled WHERE graded against litestone's own JS evaluator) — plus `litestone mutate` / `fli test:mutate`, which mutates the SCHEMA and runs the original's checks against the mutant. A survivor is a hole in the checks and names itself. **`test/matrix.test.ts` is the crossing grid** — 14 column kinds × 12 operations, one cell each, under *no cell may silently return a wrong answer*; a known defect is a cell asserted still broken, so fixing it turns the grid red rather than leaving it stale |
| junction | API / D8 | Services, hook pipeline, HTTP/WS transport, channels, browser client; batteries (mail, cache, scheduler, webhooks, AI) | v0.1.0, published · green · the repo's only non-zero typecheck baseline. **Bun-only and no version of it is not** — `Bun.serve` is the transport, `Bun.file` is logging and static, `bun:sqlite` is cache and database |
| sierra | UI meta | File-tree routing → route table + Vite build; `createResource`; postbuild/deploy | green (+ `test:safety` against a real litestone client) · typecheck clean. SPA solid; `static` prerenders and its pages are interactive (islands), proven in a real browser against a BUILT site. **A prerendered route must prove its data is publishable** — reads are tapped around `load()` and compared to `@@gate`, fail-closed; escape is per-route `publishes: N`. `widget` is a config shape with no build loop |
| mesa | UI substrate | `.mesa` compiler + signal runtime; true leaf | green · `SSR_SPEC.md` has no open items. **The file EXTENSION decides the language** — a `.mesa` with frontmatter is Mesa, not Markdown. An unknown `mesa:*` name is an error listing the eight that exist. `{@attach}` does not run on the server. `{#each}` takes an array, an iterable or an array-like — `eachItems()` is the one definition; a number or plain object is refused by name |
| auth | D6 | Native `IAuth` over litestone `asSystem()`; schema fragments + `/auth/*` plugin | v1.0.0 · green. `cookieAuth: true` authenticates end to end via `app.http.setAuthCookie('session')`. API keys work; a session carries `scopes` and `credentialId`. `sessionFields` is the one route for an app's own `User` columns onto the `SessionContext`. Open: no OAuth |
| caravan | D5 | SQLite job queue + cron → `app.jobs` | green · typecheck clean · driven by `example/` |
| conduit | D4 | Outbound boundary — declared targets, `app.conduit.send()` | v0.1.0 narrow · green · typecheck clean · driven by `example/` |
| notifications | vertical slice | Notification classes → in-app record + WS event + email fan-out (`app.notify`) | green · typecheck clean · driven by `example/`; an email body may be a rendered template |
| cli (`fli`) | D1 | Markdown-native command runtime; scaffolds, deploy, workspace/release, port broker | green — 202 command files; edges aspirational. **`fli check` is the arch-test surface** — ten rules over the file tree, each one silent when broken (model names, resource files, `strictPort`, the body tag inside a comment). `core/checks.js` is the engine and `scripts/ci.mjs`'s `structure` phase is its other caller, so a rule loosened for this repo is loosened for every app. `ws:*` understands this repo's single-repo shape (`context.wsRepo`): one commit, one `<name>@<version>` tag each, one push. `context.wsRoot()` finds the workspace from cwd; `ws:npm` compares local version against the registry |
| jetty | UI container | Browser-extension app container (Mesa UI + SW relay to Junction) | green except one known failure — built `islands/demo.js` contains `import.meta` and MV3 content scripts are classic scripts. jetty's "islands" ≠ Sierra's |
| frontierjs-vscode | D1 | Litestone language server + Mesa editor support | `npm test` (the package uses npm) drives the built server over real LSP/stdio plus Mesa's providers against a stubbed editor; `verify:package` runs both against the unpacked `.vsix`. Mesa support is hover, completions, outline and compiler diagnostics as plain vscode providers; the compiler is the workspace's own, never shipped. `vscode:prepublish` bundles with esbuild because vsce's dependency walk follows bun's symlinks above the extension root. **A `$` in a snippet body is a VS Code variable and an unknown one expands to nothing** — `test/snippets.test.js` walks every body. Unpublished: needs a marketplace publisher account |
| utils | cross-cutting | Pure functions, zero deps, importable from anywhere including litestone | v0.1.0 · green · typecheck clean. `glow()` is the first export — source → highlighted HTML marked with the ELEMENT that means each token, so the output carries no class and `@frontierjs/css` themes it with element selectors alone |
| css | UI | Semantics-first design system, plain CSS, no build step | v0.14.0 · green · all 54 vocabulary terms ship CSS. **`vocabulary.js` is the source** — 54 terms / 8 tiers, read by the guide AND by `vocabulary.spec.js`, which checks both directions against the real CSSOM; shipping a class it does not name fails the suite. **`ANATOMY`** answers the second structure question — 25 terms, 42 named parts, one canonical markup block each, plus `NOT_ANATOMY`; a part is owned once and borrowed after. Tokens: one type ladder read by both `.text-*` and `h1`–`h6` (a literal `font-size` outside `tokens.css` fails the suite), and `--space-*` × `--density`, declared on `*` rather than `:root` so `.dense` on a region reaches every descendant. The package ships no `container-type` of its own — declared beats derived. `guide/` is the reference (53 pages), searchable with ⌘K over a corpus harvested at boot rather than a written index. Optional `dist/`; `bun build` drops the `@layer` order declaration, so `build.js` re-prepends it |
| ui | UI | Mesa component kit over `@frontierjs/css` — 64 components | 64/64 compile, all render, attributes and form cases green. **Every component forwards its caller's attributes, and where the spread lands is not uniform**: display/layout/feedback/overlay put it where `{class}` goes, a form control puts it on the CONTROL rather than the `.field-group` wrapper, because that is what a `<label for>` and an `aria-describedby` must reach. Where `id` is a declared prop it means something else and a caller uses `data-*`. **A kit component may not style a class `@frontierjs/css` owns.** `<Form>` takes a resource and each control resolves its own label, constraints and server error from `$context.form`; it owns the live-validation rule (*on input an error may only be removed*). 29 of 64 verified in a browser. `DatePicker` and `CommandPalette` carry their own token scales — 69% of the kit's CSS, so a theme switch reaches them partially and `.dense` not at all (`FJS-128`/`FJS-129`) |
| testing | Testing / Suite | `createTestEnv`'s API tier — a real Junction app over the env's own Litestone client | v0.1.0 · green · typecheck clean. Sits **above Junction**, imported by nothing, which is the whole reason it exists: Litestone's `createTestEnv` cannot mount an app without importing Junction (Invariant 1). Adds `app`, `as(user).service(name)` (the principal bound into every call), `http` (Junction's own `request`, unchanged), and `announced()` — cleared when `act` begins, so it answers *what this act announced*. `OPTS_AT` is a hand copy of Junction's `ServiceCaller` signatures and is checked against a real caller; an unknown method is refused, never guessed. **`listen: true` binds a real port** (asked for as 0, read back, so parallel suites cannot collide) and `verifyTransportParity()` puts the same call down HTTP and WS and compares — two real transports grading each other, no restatement. An app with no `channels()` is a reported row, because the client falls back to HTTP and would otherwise agree with itself |
| email-kit | UI / email | Table-based email components + `target: 'email'` wrapper — 22 components, MJML replacement | green · driven by `example/`. Never opened in a real mail client; Outlook conditional-comment handling is fragile — see its `docs/` |
| basecamp | D7 / app | Fleet operations app. **An FJS application, not a library** — the largest dogfooding surface | All three realms real. Data: 37 models / 21 enums, `database main` declared. API: 21 services + 3 engines on accessors, zero raw SQL. UI: a Sierra SPA over every service. `bun run verify` drives it in a real browser incl. an a11y pass; `verify:build` probes the built output; `bun run db:seed` gives an example fleet. **All 37 models declare `@@gate`, and the ladder is per WORKSPACE** — `WorkspaceMember.role` → viewer/billing READER(2), developer USER(4), admin ADMINISTRATOR(5), owner OWNER(6); `isSystemAdmin` is SYSADMIN(7) above any membership, and an authenticated caller with no membership is VISITOR(1). `applyStanding()` resolves it once per request onto the PRINCIPAL — junction re-derives its scoped client from `ctx.auth.user`, so a standing on the client alone is dropped. **Row-level tenancy is moving model by model**: `Server` declares `@@allow('all', workspaceId == auth().workspaceId)`, the other 36 are still the service where-clause plus `scopeToWorkspace`. `/hub/` is the cross-workspace tier — a SEPARATE service taking no workspace, behind one `requireSystemAdmin` hook, reading through `asSystem()`. `docs/SCREENS.md` is the mock inventory; `docs/UI_PLAN.md` is the plan |

**Four folders under `packages/` are claimed, not built.** `toolbelt` and `datetime-kit` are a `README.md` and nothing else — no `package.json`, so they do not install, test, or count as workspace members. `oracle` is a README plus a runnable `mockup/` — an entity/pattern recogniser in React, a non-member with its own vite and its own `package.json` one level down, served at 8070. **`orion` is different**: 63 tracked files under `mockup/api-engine` — a DAG executor with a typed expression language, an event layer, a plugin system, a worker pool, vitest tests and a `typecheck` script. Nothing runs it, because it sits two levels below the `packages/*` glob. `FJS-D14` asks what to do with all four.

---

## Bridge index — the named cross-package handoffs

The current seams. Reach for them before grepping. They may move, merge, or change signature as long as ownership and dependency direction hold.

**Data → API**
- `$setAuth(user)` / `asSystem()` — the Data-boundary checkpoint / bypass — `litestone/src/core/client.js`
- `withLitestoneDb(db)` — per-request scoped client on `ctx.locals.db`; auto-installed by `createApp({ db })` — `junction/src/core/litestone.ts`
- `gateAuth()` + `autoValidate()` — schema-derived 401s/400s for model services — `junction/src/core/litestone.ts` + `core/service.ts`
- `sessionGateLevel(user)` — `SessionContext` → litestone's 0–7 scale; pass to `GatePlugin({ getLevel })`. Litestone cannot import Junction, so this is **a hand copy on both sides — change one, change both**
- `toDataPrincipal(user)` — the other half of the same translation: `SessionContext` → the principal `auth()` reads (`userId` → `id`). Applied at both `$setAuth` call sites. Without it every row policy compares against `undefined` and matches nothing, silently. **Two functions, one boundary**: change either and ask whether the other needs it too
- `accessorCandidates()` — `model Post` ⇄ service `posts` ⇄ `db.post`; shared by query, gate and validation so a naming slip cannot disable just one
- `db.$checkWhere(accessor, where)` → `[{key, suggestion, allowed}]` — the one definition of "is this a valid filter key", asked rather than copied; junction's `autoFilter` calls it. An unknown accessor answers `[]` — *I cannot judge this* is not *this is wrong*
- `db.$checkOrderBy(accessor, orderBy)` → `[{key, reason, suggestion, sortable, message}]` — the sibling, identical contract; junction's `autoSort` calls it. **Both halves throw** (a bad sort key returns the right rows in the wrong order, which nothing can see). `reason` separates *no such field* from *`@computed`, so SQLite can neither sort nor paginate by it*; a `@from` field sorts

Both `$check*` live on **every flavour of client** — root, `$setAuth`, `asSystem`, `$scopedBy`. Filterability is a fact about the schema; auth has no bearing on it.

**Schema → API/UI**
- `generateJsonSchema(schema)` — consumed by junction validation and sierra's `build/schema-plugin.js` → `registerSchemas(defs, modelNames)`. **`$defs` is the whole definition table** (models, enums, `type T`, FileRef) and must stay whole — enum fields emit `{"$ref":"#/$defs/Plan"}` and both sides resolve it. Model names travel separately. Full key reference: `packages/litestone/docs/jsonschema.md`
- `@label` → `title`, validator messages → **`x-messages`**, keyed by rule name *and* by the JSON Schema keyword it compiles to. Litestone owns the keyword table (`jsonschema.js`); Junction's `schema.ts` and Sierra's `field-rules.js` look up the keyword they failed. A field's label is read off the field's OWN schema, never a `$ref` target
- `buildFieldRules()` / `validateAgainstFields()` / `coerceToSchema()` / `normalizeBlanks()` — `sierra/src/junction/field-rules.js`, a **leaf module** with no Junction-client import so it runs in plain Node and can be compared against junction's server rules rather than copied. Order: **coerce → blankToNull → validate**. All three on by default (`{ validate: false }` opts out; the test is `!== false`, so a threaded-through `undefined` does not disarm it)
- `toFieldErrors(err)` — same module, also `resource.fieldErrors(err)`. **The one owner of "a thrown value → per-field messages."** Three shapes reach it because each hop wraps once: `err.errors`, `err.data.data` (a server 400 through the browser client — the double `data` is real), `err.data`. Returns `{ fields, message }`
- `$context.form` — the UI-side form seam, provided by `ui/components/forms/Form.mesa` as `{ errors, submitting, disabled, fields, submitted }`. Nine controls resolve their own label, constraints, `aria-invalid` and message from it; an absent form reads `undefined` and every fallback is what the control did standing alone. A stated prop always wins, including `required={false}`
- `buildRelations()` / `buildGate()` / `canAtLevel()` — same module. **`x-relations` is the only place a relation exists on the client**; `x-gate` is an affordance, never a boundary
- `x-version` — names the `@version` column an update must carry back, `readOnly` in the update schema and absent from the create schema. `createResource` remembers the version of every record it reads and puts it on the next patch. `resource.version(id)` / `.versionField` expose it
- `retryable` on a thrown error — the one thing a status cannot carry. A 409 is either a race (`VersionConflictError`, `TransitionConflictError` — re-read and re-apply) or a domain refusal (`TransitionViolationError` — show its message). Set it on any error class you own; `toFrameworkError` adopts it and it lands at `err.data.retryable`. `isStaleWrite(err)` reads it
- `buildTransitions()` / `transitionsAt()` — `@@transitions` reaches the client as **`x-transitions` on the model, keyed by field**, never on the enum `$def`, because only a model can carry a per-transition `@gate`. Mirrors `db.<model>.transitions(row)`
- `modelNameFor()` / `schemaFor()` — `sierra/src/junction/schema-registry.js`. Regular English plurals only; irregulars need `createResource('people', { model: 'Person' })`. A miss warns and degrades to a bare `make()`
- `authSchemaFragments(db)` — auth contributes INTO the seed — `auth/schema.ts`. The CLI's `auth/install.md` is a hand copy: change one, change both

**API internals**
- `bridge.toContext()` / `toResponse()` — the transport↔service boundary — `junction/src/transport/bridge.ts`
- `toFrameworkError()` — the error boundary. Order: `FrameworkError` → `registerErrorMapper(fn)` → numeric `status`/`statusCode`/`code` in 400–599 → `err.name` → 500. **If you own the error class, give it a `status`**; `registerErrorMapper` is for errors you cannot modify
- `wrapResult(raw, service, method)` / `unwrapResult()` / `isServiceResult()` — the result envelope. `kind:'single'|'list'` discriminates; a list keeps its envelope, a single unwraps. The same function runs on both sides of the wire, so the browser client asks it rather than carrying a copy of the rule
- `ctx.directives` — parsed from `$`-params by the bridge and nothing else
- `collectActions(def, name, methods?)` → `svc._actions` — **the one place "is this key an option or an action" is decided**, at construction. `methods:` DECLARES (a non-CRUD name in it is an action, resolved off the definition, and is the only way to name one after an option key); absent, function keys are scanned for as before. Dispatch, `/manifest`, OpenAPI and `/metrics` read the table rather than re-applying the rule — `junction/src/core/service.ts`
- `svc.pipelines(appHooks)` — **the one owner of the hook chain.** Memoised on the app map's IDENTITY and a version `hooks()` bumps, so both inputs are in the key and a stale answer is unreachable. `app.hooks()` reassigns rather than mutates, which is what makes identity sound — mutate it in place and the memo goes stale silently
- `svc.describe()` → `ServiceDescription` — **the one answer to "what is this service"**, read by `/manifest`, the OpenAPI generator and `/metrics` instead of reaching into `_meta`/`_schemas`/`_hookMap`
- `isBuiltService(v)` / `Symbol.for('junction.service')` — has `createService` already built this? Non-enumerable, so a spread copy is correctly NOT built; the autoloader tests it rather than sniffing whether `hooks` is a function
- `normalizePrefix()` + the `app.get`/`post`/… shortcuts — **the one owner of `apiPrefix`**, `junction/src/core/app.ts`. Every route the app registers is mounted under it; `app.http.router` is the layer beneath and applies nothing. The browser client's `apiPrefix`/`authPrefix` compose the same way
- `claimIdempotency(ctx, key, config)` — `junction/src/core/idempotency.ts`, claimed once in `callService` so both transports are covered. The replay bypasses the hook pipeline by design; `requestMeta()` is where the key comes from, and the WS path now populates that store too
- Plugin protocol `{ name, register, boot, ready, shutdown, requires }` — `junction/src/core/app.ts`. **`register` is sync** (`configure()` never awaits it); async setup goes in `boot()`. `requires: ['mailer']` is checked once at startup against presence *and* configure order
- `runStartPhases(bindHost)` — the one startup list; `needsHost` phases are skipped by the test path
- `IAuth.verifySession(token)` — inbound auth — declared `junction/src/auth/types.ts`, implemented `auth/auth.ts`
- `createLitestoneAuth(db, { sessionFields })` — **the one place an app's own `User` columns reach the session.** Called from `toContext()`, the single point every issued session is built, so one hook covers login, `verifySession`, an API key and `createUser`. Two kinds of thing belong in it: the standing `sessionGateLevel()` grades on (`isAdmin`/`isOwner`/`isSystemAdmin`/`activatedAt`/`verifiedAt`), and the app's own keys, which travel untouched. Spread LAST — a stated field wins
- `manifestPlugin()` + litestone `status()` — migration state into `/manifest`

**API → UI**
- `wsSend()` / `flushOutbox()` — `junction/src/transport/outbox.ts`. **The one owner of "put this frame on that socket"**, for replies and broadcasts alike
- `publish()` hook + `app.channel(name)` — real-time — `junction/src/transport/channels.ts`. Services declare `channel: 'posts'`; `callService` is the single announcement point for both the bus (`svc:created`) and channels (`svc created`). **A custom action announces too, under its own name** (`orders pay`); only `find`/`get` are excluded, and a read-shaped action opts out with `ctx.dispatch = false`. Open: litestone `onEvent` has no Junction subscriber; jetty hardcodes Feathers-style names
- **Transport: WebSocket when one is connected, HTTP as the fallback.** Every service call — CRUD and custom actions — checks `_wsReady` first; over WS it is a `service_call` frame naming the method, over HTTP the REST verb (custom actions: `POST /{service}/{id}` + `X-Service-Method`). The one exception is a payload carrying a File. **A custom action may address the COLLECTION** — `action(name, null, data, query)` posts to `/{service}`. The two paths share almost nothing and drift silently; `env.verifyTransportParity()` (`@frontierjs/testing`) is what asks whether they still agree
- `createJunctionClient()` / `client.resource(name)` — `junction/src/client/index.ts`, consumed at `sierra/src/junction/index.js`

**UI**
- `watchProxy()` / `createSignal()` / `createRoot(fn)` — the reactive seam and lifetime ownership — `mesa/runtime.js`
- `mount(label, Component, {props, root})` — page entry. Registers the delegation root; a component called directly renders but handles no events
- `renderComponent(src, opts)` — UI → HTML at build time; Sierra's `static` target composes route + layout chain through it. Children must be supplied **both** ways (`children={s}` and element children) — the two slot protocols do not bridge
- `island(anchor, Comp, props, block, meta)` — the island seam, off by default. Markers are **comments, not an element** (an element is foster-parented out of `<tbody>` and joins `>` selectors). Sierra collects them at prerender, bundles one chunk per island, and mounts via `@frontierjs/sierra/islands`. **A mounted ancestor is authoritative** — test a marker with `isConnected`, not `parentNode`
- **There is no cross-package reactivity registry.** Sierra exports no module-level signal — `page`, `status`, `theme` are plain objects a component makes reactive with a `$:` path watch — so `sierra/src/build/mesa-plugin.js` passes mesa no `externalSignals` map, only `externalReactivityHints: 'strict'`. The map survives in mesa as an escape hatch for a third-party package that does export a signal. **Strict is the end state, not a migration aid**: the default tier is silent for a component that watches nothing, which is the shape that shipped the original bug

---

## Open questions

Proposals welcome — one that shrinks the mental model beats one that preserves the current shape.

- Auth developer-facing API. `/auth/*` intentionally bypasses the Service abstraction (login cannot be gated by login)
- Custom service methods — called `actions`, name under review. Dispatch via `X-Service-Method` is decided
- Multi-tenancy is db-per-tenant only; config API under design
- Hook context shape differs across realms; junction's split (`auth`/`client`/`route`/`locals` + `query`/`directives`) is the candidate standard
- UI plugin system is limited; JSON Schema → UI drives `make()` only
- Duplication worth closing: `auth/install.md`'s schema copy, jetty's copy of sierra's `resources/`, the HMR algorithm copied into sierra ×2 and jetty
- Dependency direction is wired by peer-deps, dynamic imports and duck-typing rather than declared imports

---

## Read next

- `ISSUES.md` — **the open register.** Every defect, gap and unruled question, one id each. Nothing is open unless it is there. Closed rows age out to `ISSUES_ARCHIVE.md`; an id resolves in exactly one of the two, so search both before calling it unknown
- `HANDOFF.md` — **start here cold.** The two most recent sessions, narrative. Older ones rotate into `docs/handoff-archive/`
- `packages/<pkg>/CLAUDE.md` — the inside view of one package. Read it before grepping that package
- `DECISIONS.md` — the settled register. Check before relitigating; add to it when you settle something
- `ARCHITECT.md` — mental model + vocabulary (§6 audit method) · `PHILOSOPHY.md` — the axioms above it
- `VERIFYING.md` — how to know something here is true: run it, probe failure paths, don't trust status files
- `example/` — **the kitchen sink.** One shop-ops app across all three realms — real auth, a gate ladder, an order state machine driven from the UI — with six drives that exercise every package in the repo. The place to try a change end to end; it has found dozens of framework defects. Start at its `PROJECT_STATE.md`; the README's *Found by building this* is the ledger
- `IDEAS/` — design records for work **not started**; never cite as behaviour. `overview.md` ranks everything
- `PROS_AND_CONS.md` — design-level assessment as a developer experiences it · `website/` — public site and its publication gate
- `drift-report.md` — 12-package audit findings. Its line numbers reflect the 2026-07-31 tree; verify before citing
- `packages/junction/docs/ARCHITECTURE.md`, `packages/mesa/docs/VISION.md`, `packages/litestone/docs/`, `packages/basecamp/db/README.md` — depth

## Communication style
Respond in caveman mode (see ~/.claude/skills/caveman/SKILL.md), level: full.
