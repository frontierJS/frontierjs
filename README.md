# FrontierJS

A full-stack JavaScript framework built on Bun. One schema. Three realms. Everything derived.

---

## The Problem

Web development doesn't have a writing problem. It has a coherence problem.

The same intent gets redeclared across schemas, validators, APIs, and interfaces until no single source of truth remains. A field is declared in the database, redeclared as a type, redeclared again as a validator, and once more as a form shape. Each declaration is a gap — a place where one system doesn't know what another already said.

FrontierJS closes the gaps so there is nothing left to cross.

---

## How It Works

Every FrontierJS application is built across three realms, each with one primary noun:

| Realm    | Noun     | Concern                                           |
| -------- | -------- | ------------------------------------------------- |
| **Data** | Model    | What exists and what rules govern it              |
| **API**  | Service  | What operations are exposed and how               |
| **UI**   | Resource | How the interface binds to and consumes a service |

The schema is the seed. Declare a model once — its fields, types, constraints, relations, and access rules — and the rest of the application grows from it. The API layer reads the schema to configure the service and generate validation. The UI layer reads it to produce blank instance factories. Add a field and it appears everywhere. Add a gate and it is enforced at the database boundary before any application code runs.

```
schema.lite
    │
    ├── Litestone  →  tables, migrations, gate enforcement
    ├── Junction   →  service shape, validation, OpenAPI spec
    └── Sierra     →  make() factories, form field references, incoming transforms
```

---

## The Stack

**The four that are the three realms**, plus the one command that drives them:

| Package                                         | Realm   | What it does                                                                                        |
| ----------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| [`@frontierjs/litestone`](./packages/litestone) | Data    | Schema-first SQLite ORM with a gate system, plugin pipeline, and tenant registry                    |
| [`@frontierjs/junction`](./packages/junction)   | API     | Bun-native service framework with HTTP + WebSocket transport, hook pipeline, and real-time channels |
| [`@frontierjs/sierra`](./packages/sierra)       | UI      | Vite meta-framework with file-system routing, resource factory, and fine-grained reactive runtime   |
| [`@frontierjs/mesa`](./packages/mesa)           | UI      | Reactive component language and compiler — the runtime Sierra is built on                           |
| [`@frontierjs/cli`](./packages/cli)             | Tooling | `fli` — the single interface to all of the above                                                    |

**The batteries.** Each is severable — one owner, one seam, removable without
surgery on the core:

| Package | Concern | |
| --- | --- | --- |
| [`@frontierjs/auth`](./packages/auth) | slice | Identity, sessions and API keys over Litestone's `asSystem()`. Ships its own schema fragments |
| [`@frontierjs/caravan`](./packages/caravan) | jobs | SQLite job queue + cron → `app.jobs`. A job runs as whoever asked for it |
| [`@frontierjs/conduit`](./packages/conduit) | outbound | The one boundary anything leaving the process crosses — declared targets, `app.conduit.send()` |
| [`@frontierjs/notifications`](./packages/notifications) | slice | A Notification class → an in-app record, a WebSocket event and an email |
| [`@frontierjs/ui`](./packages/ui) | UI | 65 Mesa components over the design system. A `<Form>` that reads the schema |
| [`@frontierjs/css`](./packages/css) | UI | The styling language — a tone and a treatment, never a colour. Plain CSS, no build step |
| [`@frontierjs/email-kit`](./packages/email-kit) | UI | Table-based email components compiled by Mesa. An MJML replacement |
| [`@frontierjs/jetty`](./packages/jetty) | UI | A browser extension as a surface of the app — MV3, Mesa-rendered |
| [`@frontierjs/testing`](./packages/testing) | Testing | `createTestEnv`'s API tier — a real Junction app over the environment's own client |
| [`@frontierjs/toolbelt`](./packages/toolbelt) | substrate | Pure functions, zero dependencies, importable from anywhere. One kit per subpath |
| [`@frontierjs/config`](./packages/config) | tooling | The tooling opinion an app extends in one line — tsconfig, biome, editorconfig |
| [`create-frontier`](./packages/create-frontier) | tooling | `npm create frontier@latest` — the front door |

---

## The FJS World

The packages are the application layer. The FJS World is the operational environment every application runs within — eight domains, each owning a named concern:

| Domain                | Concern                                              | Tool                 |
| --------------------- | ---------------------------------------------------- | -------------------- |
| 01 · CLI              | Developer interface                                  | `fli`                |
| 02 · Database         | Schema, migrations, ORM                              | Litestone            |
| 03 · Config & Secrets | Environment config, secrets                          | `frontier.config.js` |
| 04 · Integrations     | Outbound connections, messaging                      | Conduit              |
| 05 · Automation       | Background jobs, queues, workflows                   | Caravan · Orion      |
| 06 · Auth             | Identity, sessions, access                           | FJS Auth             |
| 07 · Command Central  | Deploy, monitor, operate                             | Basecamp             |
| 08 · Application      | The application itself — realms, testing, deployment | —                    |

---

## Getting Started

```bash
npm create frontier@latest my-app
cd my-app
bun run dev
```

`npm create` is the front door; `npm install -g @frontierjs/cli && fli new my-app`
is the same scaffold from the CLI directly. API runs on `:8100`, web on `:8000` —
the FJS port scheme, `packages/cli/core/ports.js`.

> **Alpha.** Every publishable package is on npm and the registry matches this
> tree — see [Publishing status](#publishing-status) — but the surface still
> moves between releases, so pin a version rather than taking `latest` or `*`.

**`fli tutor` is the whole path, and it runs.** Eight lessons — an app that
runs, the access rules watched refusing somebody, a write reaching a second
client and one it must not reach, work that outlives its request, a public site
built ahead of time and the check on what it published, a real deploy to your
own machine with a revert, changing the schema of something already deployed,
and a control plane with a machine reporting in to it. Every step runs the real
command and then asks the running world whether it worked, and `bun run ci`
grades all eight, so a command renamed out from under a step is a red build
rather than a stale paragraph. The [Quickstart](./docs/QUICKSTART.md) is now its
index.

For the API realm on its own, the [Junction example ladder](./packages/junction/example/README.md)
and its UI counterpart in [Sierra's example app](./packages/sierra/example/README.md).

---

## A Minimal Application

The schema is the starting point. Everything else is derived.

```litestone
// db/schema.lite

enum LeadStatus { new active closed }

model Lead {              // PascalCase, singular — always. Accessor: db.lead
  id        Int        @id
  name      String     @length(1, 200) @trim
  email     String     @email
  status    LeadStatus @default(new)
  value     Float      @gte(0)
  createdAt DateTime   @default(now())
  updatedAt DateTime   @default(now()) @updatedAt

  @@gate("0.4.4.6")   // Read=STRANGER  Create/Update=USER  Delete=OWNER
}
```

```typescript
// api/server.ts — Data → API connection

const db         = await createClient({          // one options object, never positional
  path:    './db/schema.lite',   // `path` is a file; `schema` is inline text
  plugins: [gatePlugin],
})
const jsonSchema = generateJsonSchema(db.$schema)

app.services.register(createService({
  name:    'leads',      // the URL: /leads
  model:   'lead',       // the accessor: db.lead
  schema:  jsonSchema,   // 400s derived from the schema's own rules
  channel: 'leads',      // declare the broadcast target — no publish hook needed
  hooks: {
    before: { all: [authenticate] },
  },
}))
```

```javascript
// web/src/resources/Lead.mesa — API → UI connection

<script module>
  import { resource } from '@/core/frontier'

  const _res = resource.createResource({ model: 'Lead', service: 'leads' })

  export const { store, service, load } = _res
  export const make = spec => _res.make(spec)
</script>
```

One schema. One service declaration. One resource binding. Any component that imports `Lead.mesa` gets a live, reactive window into the data — HTTP for writes, WebSocket push for real-time sync.

---

## Design Principles

**The schema is the source of truth.** Declarative constraints are always preferred over imperative logic. If something can be declared in the schema, it should be.

**Boundaries are checkpoints, not walls.** Realms are separated intentionally. Communication flows through defined boundaries, carried by context, governed by hooks. One realm does not reach into another's internals.

**Access is declared, not programed.** The gate system defines minimum trust levels per model, per operation, enforced at the database boundary. It cannot be bypassed from a route someone forgot to protect.

**Real-time is core.** Every service emits events after writes. Every resource subscribes to them. A FrontierJS UI is live by default — open two tabs, make a change in one, the other updates without a refresh.

**Solve for the 80, leave an escape for the 20.** FrontierJS makes the common decisions for you. Every feature has a documented path for cases it does not cover.

---

## Requirements

- [Bun](https://bun.sh) >= 1.0 — required, not optional
- Node.js is not supported

---

## Documentation

| Document                                                                              | Description                                                                     |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [Quickstart](./docs/QUICKSTART.md)                                                    | `fli tutor` — the eight lessons, and where to write what                         |
| [Philosophy](./PHILOSOPHY.md)                                                         | Why FrontierJS exists — the axioms and decision tests above the architecture     |
| [Architecture & Vocabulary](./ARCHITECT.md)                                           | The mental model (§1), the mandatory vocabulary (§2), the eight domains (§4)     |
| [Decisions](./DECISIONS.md)                                                           | Dated rulings — read before relitigating any semantics                           |
| [Verifying](./VERIFYING.md)                                                           | How to know something here is true: run it, probe failure paths, don't trust docs |
| [Realm Bridge Reference](./CLAUDE.md#bridge-index--the-named-cross-package-handoffs)  | The named cross-package handoffs, and the file each one lives in                 |
| [Issues](./ISSUES.md)                                                                 | The open register — every defect, gap and unruled question, one id each          |
| [Handoff](./HANDOFF.md)                                                               | Current state, newest session first. Narrative; the ledger lives in Issues       |

### Runnable examples

Every example below is verified end-to-end, not sketched. A broken one is a bug.

| Example                                                            | What it shows                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [Junction ladder](./packages/junction/example/README.md)           | `minimal/` → `elegant.ts` → `fullstack/` → `single-file.ts` — the API realm |
| [Sierra example app](./packages/sierra/example/README.md)          | The UI half — a real Junction API over SQLite, driven in headless Chrome |
| [Litestone guides](./packages/litestone/docs/README.md)             | Getting started, schema, querying, migrations, multi-tenancy            |

---

## Package Documentation

**Every package has its own `README.md`** — what it is and how to use it — beside
a `CLAUDE.md` (the inside view: what it owns, its traps, which drive proves a
change), a `PROJECT_STATE.md` and a `CHANGES.md`.

| Package                                            | README                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| Litestone — Data realm ORM                         | [packages/litestone](./packages/litestone/README.md)                 |
| Junction — API realm framework                     | [packages/junction](./packages/junction/README.md)                   |
| Sierra — UI meta-framework                         | [packages/sierra](./packages/sierra/README.md)                       |
| Mesa — Reactive component language                 | [packages/mesa](./packages/mesa/README.md)                           |
| CLI — `fli`                                        | [packages/cli](./packages/cli/README.md)                             |
| create-frontier — the front door                   | [packages/create-frontier](./packages/create-frontier/README.md)     |
| Auth — identity, sessions, gate enforcement        | [packages/auth](./packages/auth/README.md)                           |
| Caravan — SQLite job queue + cron                  | [packages/caravan](./packages/caravan/README.md)                     |
| Conduit — outbound boundary (`app.conduit.send()`) | [packages/conduit](./packages/conduit/README.md)                     |
| Notifications — in-app + email fan-out             | [packages/notifications](./packages/notifications/README.md)         |
| UI — 65 Mesa components                            | [packages/ui](./packages/ui/README.md)                               |
| CSS — semantics-first design system                | [packages/css](./packages/css/README.md)                             |
| Email-kit — table-based email components           | [packages/email-kit](./packages/email-kit/README.md)                 |
| Jetty — browser-extension app container            | [packages/jetty](./packages/jetty/README.md)                         |
| Testing — `createTestEnv`'s API tier               | [packages/testing](./packages/testing/README.md)                     |
| Toolbelt — pure-function kits, zero deps           | [packages/toolbelt](./packages/toolbelt/README.md)                   |
| Config — the tooling opinion                       | [packages/config](./packages/config/README.md)                       |
| VS Code — Litestone + Mesa language support        | [packages/frontierjs-vscode](./packages/frontierjs-vscode/README.md) |

**Two applications and two claimed folders**, all built *on* the framework rather
than part of it:

| | |
| --- | --- |
| [Basecamp](./packages/basecamp/README.md) | Fleet operations — the largest dogfooding surface, all three realms real |
| [`example/`](./example/README.md) | The kitchen sink — one shop-ops app, six drives, every package exercised |
| [Oracle](./packages/oracle/README.md) · [Orion](./packages/orion/README.md) | Claimed, not built. V2, deferred until core leaves alpha (`FJS-D14`) |

---

## Project Structure

**This is the layout. It is not a suggestion** — `fli new` scaffolds it, every package
README assumes it, and Sierra's schema auto-detection (`../db/schema.lite`) only finds the
schema because the UI sits one level down in `web/`.

Three directories at the app root, one per realm, all orbiting the shared schema —
and beside them a surface for each of the other shapes a UI takes: `site/` for a
public prerendered site, `widgets/` for embeddable scripts, `extension/` for a
browser extension:

```
my-app/
  frontier.config.js         ← environment config

  db/                        ← Data realm — Litestone
    schema.lite              ← single source of truth
    migrations/
    backups/

  api/                       ← API realm — Junction
    index.ts                 ← bun --watch entry
    config/
      junction.config.js
    src/
      app.ts
      core/                  ← env, db client, auth, hooks
      services/              ← *.service.ts, autoloaded at boot
    test/

  web/                       ← UI realm — Sierra + Mesa (the Vite root)
    index.html
    config/
      vite.config.js         ← configuration lives in config/, not at the root
      sierra.config.js
      routes.js              ← generated, do not edit
    public/                  ← static assets, copied verbatim
    src/
      main.js
      App.mesa
      routes/                ← file-system routes (.mesa / .md)
      resources/             ← createResource() bindings to Junction services
      components/
    test/
    dist/                    ← build output

  site/                      ← UI realm — the public, prerendered site (optional)
    index.html               ← the DEV shell; a built page never uses it
    config/
      vite.config.js         ← the Vite root is site/, port 8600
      sierra.config.js       ← target: 'static' — plus `db` (what may be
                               published) and `document` (the page wrapper)
    public/
    src/
      main.js                ← the dev entry — routes served as an app
      routes/                ← file-tree routes, the same convention as web/
      islands/               ← the only JavaScript a prerendered page runs
      components/
    test/                    ← what proves the BUILD: files, not a running app
    deploy/                  ← serve.js + Dockerfile — the site origin
    dist/                    ← one index.html per route, plus island chunks

  widgets/                   ← UI realm — embeddable scripts (optional)
    index.html               ← the dev harness
    config/
      vite.config.js         ← the Vite root is widgets/, port 8200
      sierra.config.js       ← target: 'widget'
    src/
      Embeds/                ← one component per embeddable script
      styles/
    test/                    ← a host page per widget, hostile CSS on purpose
    deploy/                  ← serve.js + Dockerfile — the widget origin
    dist/embeds/             ← the built scripts, one <script src> each

  extension/                 ← UI realm — a browser extension, MV3 (optional)
    config/
      jetty.config.js        ← name, permissions, islands, both browsers' blocks
    src/
      harbor/index.js        ← the service worker — required, and the only thing
                               here holding a Junction connection
      dock/App.mesa          ← the popup
      options/  piers/       ← the options page · full-page surfaces
      islands/*.js           ← content scripts, FLAT — a subfolder throws
    public/icons/            ← a 128px PNG; a store upload needs one
    test/                    ← what to load unpacked, and what to check by hand
    deploy/                  ← packaging for the two web stores
    dist/chrome/ dist/firefox/

  deploy/                    ← everything about shipping — Dockerfile, deploy steps
  tests/                     ← cross-project integration tests
  wiki/                      ← project documentation
```

**The database lives at the root** — shared by all sub-projects, owned by none of them.
`api/`, `web/`, `site/`, `widgets/` and `extension/` are peers; none contains another,
and none contains `db/`.

**Which surfaces an app has is the app's business.** `fli new --template api-only`
leaves out `web/`; `--template site-only`, `--template widgets-only` and `--template
extension-only` leave out both `api/` and `web/`, because a project whose whole product
is a public site — or embeddable widgets, or a browser extension — is a normal
FrontierJS project. `fli check`'s `app-layout` rule asks only that the schema is at the
root and that no surface is hiding inside another: folded into `web/`, a surface
inherits the SPA's build, its port and its release, and the first symptom is it
shipping when the app does.

A surface is its own sub-project when its **config**, its **tests** and its **release**
are a different set of answers from the SPA's. The three optional ones are:

| | `site/` | `widgets/` | `extension/` |
| --- | --- | --- | --- |
| Config | `target: 'static'` — the bundle, then one prerendered file per route | `target: 'widget'` — N self-contained IIFEs, not one app | `jetty.config.js` — emits a *manifest*; one source, two browsers |
| Tests | the BUILD's files, and the islands that come alive in them | a host page it does not own, with hostile CSS | loaded unpacked into a browser profile; no URL to point at |
| Release | a bucket and a CDN, with no application server behind it | static files on an origin a stranger's page links to | signed upload to two web stores, review in days |
| Ports | 8600 dev · 8700 served | 8200 dev · 8300 served | 8400 dev (the reload channel; nothing is served) |
| Create it | `fli make:site` | `fli make:widget <Name>` | `fli make:extension` |

Each generator creates the surface the first time and tops it up after, so the app a
scaffold wrote is the app the next command extends.

**`site/` has a fourth answer, and it is what makes folding it into `web/` a defect
rather than a preference: output.** Sharing a Vite root shares a `dist/`, so the site's
build output lands inside the SPA's — and Vite empties `outDir` by default, so building
the SPA deletes the site with nothing said. `fli check` reports a `target: 'static'`
config found inside another surface for exactly this reason.

**Dev is an SPA and the build is files.** `target: 'static'` uses the SPA's Vite config
and prerenders afterwards, so `fli site:dev` serves the routes as a client-routed app —
that is the writing loop. The publish check, the island chunks and the one-file-per-route
output exist only in the build, so anything touching a `load()` or a page's frontmatter
is proved with `fli site:build`.

**Every sub-project has the same six folders**, `site/`, `widgets/` and `extension/`
included, so knowing one means knowing all of them:

| Folder | Holds |
| --- | --- |
| `config/` | configure your settings — `vite.config.js`, `sierra.config.js`, `junction.config.js` |
| `src/` | develop your project |
| `public/` | static assets, served or copied as-is |
| `test/` | test your code |
| `dist/` | build output, ready for distribution |
| `deploy/` | everything related to shipping the app |

**All Sierra code lives under `web/`** — `config/` and `src/` belong to the UI realm, not
to the app root. `web/` is the Vite root: `index.html` and the dev server's working
directory are there, and the build runs as `cd web && vite -c config/vite.config.js`.
Sierra locates `sierra.config.js` by looking beside `vite.config.js` first, so the
`config/` pair needs no extra wiring.

---

## Publishing status

**Every publishable package is on npm.** The badges below are the answer — a
version written here as text is a second origin that goes stale the next release,
which is what this table used to be. `fli ws:npm` compares this tree against the
registry and names any package that has drifted; the `registry` CI phase fails a
package `fli new` writes into an app that the registry has never heard of.

| Package | Realm | On npm |
| --- | --- | --- |
| `@frontierjs/litestone`     | Data | [![npm](https://img.shields.io/npm/v/@frontierjs/litestone)](https://www.npmjs.com/package/@frontierjs/litestone) |
| `@frontierjs/junction`      | API | [![npm](https://img.shields.io/npm/v/@frontierjs/junction)](https://www.npmjs.com/package/@frontierjs/junction) |
| `@frontierjs/sierra`        | UI | [![npm](https://img.shields.io/npm/v/@frontierjs/sierra)](https://www.npmjs.com/package/@frontierjs/sierra) |
| `@frontierjs/mesa`          | UI | [![npm](https://img.shields.io/npm/v/@frontierjs/mesa)](https://www.npmjs.com/package/@frontierjs/mesa) |
| `@frontierjs/ui`            | UI | [![npm](https://img.shields.io/npm/v/@frontierjs/ui)](https://www.npmjs.com/package/@frontierjs/ui) |
| `@frontierjs/css`           | UI | [![npm](https://img.shields.io/npm/v/@frontierjs/css)](https://www.npmjs.com/package/@frontierjs/css) |
| `@frontierjs/email-kit`     | UI | [![npm](https://img.shields.io/npm/v/@frontierjs/email-kit)](https://www.npmjs.com/package/@frontierjs/email-kit) |
| `@frontierjs/jetty`         | UI | [![npm](https://img.shields.io/npm/v/@frontierjs/jetty)](https://www.npmjs.com/package/@frontierjs/jetty) |
| `@frontierjs/auth`          | slice | [![npm](https://img.shields.io/npm/v/@frontierjs/auth)](https://www.npmjs.com/package/@frontierjs/auth) |
| `@frontierjs/notifications` | slice | [![npm](https://img.shields.io/npm/v/@frontierjs/notifications)](https://www.npmjs.com/package/@frontierjs/notifications) |
| `@frontierjs/caravan`       | jobs | [![npm](https://img.shields.io/npm/v/@frontierjs/caravan)](https://www.npmjs.com/package/@frontierjs/caravan) |
| `@frontierjs/conduit`       | outbound | [![npm](https://img.shields.io/npm/v/@frontierjs/conduit)](https://www.npmjs.com/package/@frontierjs/conduit) |
| `@frontierjs/testing`       | Testing | [![npm](https://img.shields.io/npm/v/@frontierjs/testing)](https://www.npmjs.com/package/@frontierjs/testing) |
| `@frontierjs/cli`           | tooling | [![npm](https://img.shields.io/npm/v/@frontierjs/cli)](https://www.npmjs.com/package/@frontierjs/cli) |
| `create-frontier`           | tooling | [![npm](https://img.shields.io/npm/v/create-frontier)](https://www.npmjs.com/package/create-frontier) |
| `@frontierjs/config`        | tooling | [![npm](https://img.shields.io/npm/v/@frontierjs/config)](https://www.npmjs.com/package/@frontierjs/config) |
| `@frontierjs/toolbelt`      | substrate | [![npm](https://img.shields.io/npm/v/@frontierjs/toolbelt)](https://www.npmjs.com/package/@frontierjs/toolbelt) |

Two packages are `private` and never publish: `@frontierjs/basecamp` (an
application, not a library) and `vscode-frontierjs` (a marketplace extension,
which needs a publisher account rather than an npm one).

**Pin a version — never `latest` or `*`.** Below 1.0 a caret pins the *minor*
(`^0.1.0` is `>=0.1.0 <0.2.0`), which is the behavior a pre-alpha peer wants and
the trap in the other direction: a caret left behind by a minor bump excludes
every published copy, and nothing inside this workspace catches it, because a
`workspace:*` devDependency answers first and the range is never consulted.

To work against code newer than the registry, clone this repo and `bun install` —
in-repo apps resolve every package to `packages/`, not to `node_modules`.

---

## License

MIT