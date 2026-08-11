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

| Package                                         | Realm   | What it does                                                                                        |
| ----------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| [`@frontierjs/litestone`](./packages/litestone) | Data    | Schema-first SQLite ORM with a gate system, plugin pipeline, and tenant registry                    |
| [`@frontierjs/junction`](./packages/junction)   | API     | Bun-native service framework with HTTP + WebSocket transport, hook pipeline, and real-time channels |
| [`@frontierjs/sierra`](./packages/sierra)       | UI      | Vite meta-framework with file-system routing, resource factory, and fine-grained reactive runtime   |
| [`@frontierjs/mesa`](./packages/mesa)           | UI      | Reactive component language and compiler — the runtime Sierra is built on                           |
| [`@frontierjs/cli`](./packages/cli)             | Tooling | `fli` — the single interface to all of the above                                                    |

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
npm install -g @frontierjs/cli

fli new my-app
cd my-app
bun run dev
```

API runs on `:8100`, web on `:8000` — the FJS port scheme, `packages/cli/core/ports.js`.

> **Alpha.** The published `@frontierjs/cli` is `0.0.0-beta.0` and lags this repo.
> Only Litestone and the CLI are on npm at all — see [Publishing status](#publishing-status).
> To work against current code, clone this repo and `bun install`.

**[Quickstart](./docs/QUICKSTART.md) is the whole path** — a new app, a model of
your own, and the deploy pipeline that puts it on a server. Every command in it
was run against a clean scaffold.

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
  schema:  './db/schema.lite',
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

**Access is declared, not programmed.** The gate system defines minimum trust levels per model, per operation, enforced at the database boundary. It cannot be bypassed from a route someone forgot to protect.

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
| [Quickstart](./docs/QUICKSTART.md)                                                    | A new app to a deployed server, in the order you type it                        |
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

| Package                                            | README                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| Litestone — Data realm ORM                         | [packages/litestone](./packages/litestone/README.md)                 |
| Junction — API realm framework                     | [packages/junction](./packages/junction/README.md)                   |
| Sierra — UI meta-framework                         | [packages/sierra](./packages/sierra/README.md)                       |
| Mesa — Reactive component language                 | [packages/mesa](./packages/mesa/README.md)                           |
| CLI — `fli`                                        | [packages/cli](./packages/cli/README.md)                             |
| Auth — identity, sessions, gate enforcement        | [packages/auth](./packages/auth/README.md)                           |
| Caravan — SQLite job queue + cron                  | [packages/caravan](./packages/caravan/README.md)                     |
| Conduit — outbound boundary (`app.conduit.send()`) | [packages/conduit](./packages/conduit/README.md)                     |
| Notifications — in-app + email fan-out             | [packages/notifications](./packages/notifications/README.md)         |
| CSS — semantics-first design system                | [packages/css](./packages/css/README.md)                             |
| Jetty — browser-extension app container            | [packages/jetty](./packages/jetty/README.md)                         |
| VS Code — Litestone + Mesa language support        | [packages/frontierjs-vscode](./packages/frontierjs-vscode/README.md) |

---

## Project Structure

**This is the layout. It is not a suggestion** — `fli create` scaffolds it, every package
README assumes it, and Sierra's schema auto-detection (`../db/schema.lite`) only finds the
schema because the UI sits one level down in `web/`.

Three directories at the app root, one per realm, all orbiting the shared schema:

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

  deploy/                    ← everything about shipping — Dockerfile, deploy steps
  tests/                     ← cross-project integration tests
  wiki/                      ← project documentation
```

**The database lives at the root** — shared by all sub-projects, owned by none of them.
`api/` and `web/` are peers; neither contains the other, and neither contains `db/`.

**Every sub-project has the same six folders**, so knowing one means knowing all of them:

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

**FrontierJS is alpha.** Only two packages are on npm today; everything else is
workspace-only and is consumed through `workspace:*`, not the registry.

| Package                     | On npm                                                                                                             | Notes                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `@frontierjs/litestone`     | [![npm](https://img.shields.io/npm/v/@frontierjs/litestone)](https://www.npmjs.com/package/@frontierjs/litestone) | `latest` is 1.1.0. Pin `^1.1.0` — never `latest` or `*`           |
| `@frontierjs/cli`           | [![npm](https://img.shields.io/npm/v/@frontierjs/cli)](https://www.npmjs.com/package/@frontierjs/cli)             | Published as `0.0.0-beta.0`; the in-repo version is ahead of it    |
| `@frontierjs/junction`      | not yet published                                                                                                  | workspace only                                                    |
| `@frontierjs/sierra`        | not yet published                                                                                                  | workspace only                                                    |
| `@frontierjs/mesa`          | not yet published                                                                                                  | workspace only                                                    |
| `@frontierjs/auth`          | not yet published                                                                                                  | relative `../junction/*` imports block publishing                 |
| `@frontierjs/caravan`       | not yet published                                                                                                  | workspace only                                                    |
| `@frontierjs/conduit`       | not yet published                                                                                                  | workspace only                                                    |
| `@frontierjs/notifications` | not yet published                                                                                                  | workspace only                                                    |
| `@frontierjs/css`           | not yet published                                                                                                  | workspace only                                                    |
| `@frontierjs/jetty`         | not yet published                                                                                                  | workspace only                                                    |

---

## License

MIT