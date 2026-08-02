# FrontierJS — Map

Bun-workspace monorepo: a schema-seeded fullstack framework. One mental model — three realms, three nouns:
**Data (Model) → API (Service) → UI (Resource)**, plus Deployment (Release) and Testing (Suite).
Everything derives from `db/schema.lite`; growth happens outward and traces back.
The vocabulary in `ARCHITECT.md` §2 is mandatory when describing or designing anything here.
Model names are **PascalCase and singular — always** (`model Lead` → accessor `db.lead`); `@@external` models exempt (they mirror foreign tables).

Before changing behavior that looks odd, check `DECISIONS.md` — several semantics are deliberate rulings, not bugs.

## Packages (state as of 2026-08-01) (NOTE: This whole project is in Alpha and not real/usable packages)

| Package           | Realm/Domain   | What it is                                                                                                             | State                                                                                  |
| ----------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| litestone         | Data / D2      | `.lite` language + parser, SQLite client, gates+policies, migrations, tenants, studio                                  | **shipped** v1.0.6 · 1227 tests green                                                  |
| junction          | API / D8       | Services, hook pipeline, HTTP/WS transport, channels, browser client; batteries (mail, cache, scheduler, webhooks, AI) | working (self-styled pre-alpha) · ~590 tests; 7 pre-existing test-drift fails          |
| sierra            | UI meta        | File-tree routing → route table + Vite build; `createResource` binding to Junction; postbuild/deploy artifacts         | working — SPA solid; `static`/`widget` targets advertised but unimplemented; no README |
| mesa              | UI substrate   | `.mesa` reactive compiler + signal runtime; **true leaf — zero workspace deps (keep it that way)**                     | working→shipped core · 813 tests                                                       |
| auth              | D6             | Native `IAuth` provider over Litestone `asSystem()`; ships schema fragments + `/auth/*` plugin                         | working, has run in production; near-zero flow-test coverage                           |
| caravan           | D5             | SQLite job queue + cron; Junction plugin → `app.jobs`                                                                  | working; `autoloadJobs` has a blocking scoping bug                                     |
| conduit           | D4             | Outbound boundary — declared targets, `app.conduit.send()` over http/ws/unix                                           | shipped narrow v0.1.0; a version *behind* the API its consumers document               |
| notifications     | vertical slice | Notification classes → in-app record + WS event + email fan-out (`app.notify`)                                         | working; zero tests; email bodies currently empty (shape mismatch)                     |
| cli (`fli`)       | D1             | Markdown-native command runtime; scaffolds, deploy pipeline, port broker                                               | working — 189 commands; edges aspirational                                             |
| jetty             | UI container   | Browser-extension app container (Mesa UI + service-worker relay to Junction)                                           | working, pre-production by its own labels                                              |
| frontierjs-vscode | D1             | Litestone language server + Mesa editor support                                                                        | **stub — does not build** (stale parser paths; Mesa disabled)                          |
| css               | UI             | Token-driven design system (UnoCSS + hand CSS)                                                                         | **stub — not a package** (no package.json; entry imports missing paths; unreferenced)  |

Tests: `bun test` inside each package. Runnable examples: `packages/junction/example/elegant.ts` (the modern 80%-path demo), `packages/litestone/example/seed.ts` and `server.js` and `gate-example.js`.

## Dependency direction

`Litestone ← Junction ← Sierra` — never the reverse. Mesa is a leaf consumed by Sierra and jetty.
Caveat: this direction is wired by optional peer-deps, dynamic imports, duck-typing, and hand-copies — **not declared dependencies**. Sierra imports mesa, junction, and litestone and declares none of them (compensated by hand-rolled exports-map resolvers).

## Bridge index — the named cross-package handoffs

These are the actual architecture; reach for them before grepping.

- `$setAuth(user)` / `asSystem()` — the Data-boundary checkpoint / bypass — `packages/litestone/src/core/client.js`
- `withLitestoneDb(db)` — per-request scoped client on `ctx.locals.db`; auto-installed by `createApp({ db })` — `packages/junction/src/core/litestone.ts`
- `gateAuth()` + `autoValidate()` — schema-derived 401s/400s for model services (merged via `createBaseService`; `createService({model})` forwards hooks so the derived layer survives) — `packages/junction/src/core/litestone.ts` + `core/service.ts`
- `generateJsonSchema(schema)` — Data → API/UI; consumed by junction validation and by sierra's `src/build/schema-plugin.js` → `registerSchemas()` in `virtual:sierra`
- `bridge.toContext()` / `toResponse()` — THE transport↔service boundary — `packages/junction/src/transport/bridge.ts`
- `publish()` hook + `app.channel(name)` — API → UI real-time — `packages/junction/src/transport/channels.ts`
- `createJunctionClient()` / `client.resource(name)` — API → browser — `packages/junction/src/client/index.ts`, consumed at `packages/sierra/src/junction/index.js`
- `watchProxy()` / `createSignal()` — the real Resource→UI reactive seam — `packages/mesa/runtime.js`, used by sierra router/junction and jetty
- `externalSignals` — sierra tells mesa which imports are reactive — `packages/sierra/src/build/mesa-plugin.js` (hand-maintained; slated for retirement per mesa's `PLAIN_OBJECT_STATE.md`)
- `mount(label, Component, {props, root})` — page entry into Mesa — `packages/mesa/runtime.js`
- `IAuth.verifySession(token)` — the inbound auth bridge — declared `packages/junction/src/auth/types.ts`, called in `transport/http.ts`, implemented `packages/auth/auth.ts`
- Plugin protocol `{ name, register, boot, ready, shutdown }` — how caravan/conduit/auth/notifications attach — `packages/junction/src/core/app.ts`
- `authSchemaFragments(db)` — auth contributes INTO the seed — `packages/auth/schema.ts` (the CLI's `auth/install.md` carries a divergent hand-copy: known bug)
- `parse()` / `parseFile()` — the `.lite` parser everyone reaches for — `packages/litestone/src/core/parser.js` (vscode bundler points at its pre-move path: broken)
- `manifestPlugin()` + litestone `status()` — migration state into `/manifest` — `packages/junction/src/plugins/manifest/index.ts`

## Landmines

- **Dialect trap**: junction's `"@frontierjs/litestone": "latest"` resolves *npm 1.0.3* (old `Integer/Text/Real` scalars), NOT the workspace 1.0.6 (`Int/String/Float`; old names hard-rejected). Check which one a file actually loads before writing schema strings.
- **No tsconfig anywhere** except frontierjs-vscode — cross-package type declarations are never checked (junction and conduit declare `app.conduit` with conflicting types, silently).
- **jetty's `src/resources/` is a hand-copy of sierra's** — already diverged (`createStore` signature). Fix one → audit the other.
- **`mesa-vite/` is nested inside `packages/mesa`** — invisible to the workspace glob; its HMR algorithm is hand-copied into sierra (×2 files) and jetty.
- **Real-time is fragmented**: litestone `onEvent` has zero listeners; junction emits the same moment twice (`svc:created` on `app.events`, `svc created` on channels — browser parses only the space form); jetty hardcodes Feathers-style event names.
- **Audit logger writes 0 rows** in litestone's examples (`@@log(audit)` → logger driver) — pre-existing, cause unknown (async flush suspected).
- Line numbers in `drift-report.md` reflect the 2026-07-31 tree; verify before citing.

## Unsettled (ARCHITECT.md §5, corrected)

- Auth developer-facing API not finalized; auth's `/auth/*` routes intentionally bypass the Service abstraction (login can't be gated by login).
- Custom service methods: called `actions`; name under review; dispatch stays via `X-Service-Method` header (decided — see DECISIONS.md). Live bug: `/metrics` reads a nonexistent `svc.actions` key.
- Multi-tenancy = db-per-tenant only (litestone `createTenantRegistry`); config API under design.
- Hook context shape differs across realms; junction's four-field split (`auth`/`client`/`route`/`locals`) is the candidate standard.
- UI plugin system limited; JSON Schema → UI drives `make()` only.
- Query params: `$limit`/`$offset` at API vs `limit`/`offset` in litestone — the gap is only the `$` prefix (`$skip` does not exist anywhere).

## Read next

- `ARCHITECT.md` — the mental model + mandatory vocabulary (§6 audit method)
- `PHILOSOPHY.md` — the axioms and decision tests above the architecture
- `DECISIONS.md` — dated rulings; check before relitigating any semantics
- `VERIFYING.md` — how to know something here is true: run it, probe failure paths, don't trust docs or status files
- `drift-report.md` — full 12-package audit findings (drift/friction/proposals, with what's since been fixed)
- `packages/junction/JUNCTION_PROJECT_STATE.md`, `packages/mesa/VISION.md`, `packages/litestone/docs/` — per-package depth
