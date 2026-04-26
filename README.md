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

fli create my-app
cd my-app
fli dev
```

The CLI starts all sub-projects in development mode. API runs on `:3000`, web on `:5173`.

For a full walkthrough — from blank project to deployed CRM — see the [Developer Guide](./docs/guide.md).

---

## A Minimal Application

The schema is the starting point. Everything else is derived.

```litestone
// db/schema.lite

model leads {
  id        Integer    @id
  name      Text       @length(1, 200) @trim
  email     Text       @email
  status    LeadStatus @default(new)
  value     Real       @gte(0)
  createdAt DateTime   @default(now())
  updatedAt DateTime   @default(now()) @updatedAt

  @@gate("0.4.4.6")   // Read=STRANGER  Create/Update=USER  Delete=OWNER
}
```

```typescript
// api/server.ts — Data → API connection

const db          = await createClient('./db/app.db', './db/schema.lite', { plugins: [gatePlugin] })
const jsonSchema  = generateJsonSchema(db.$schema)

app.services.register(createLitestoneService({
  name:   'leads',
  model:  'leads',
  schema: jsonSchema,
  hooks: {
    before: { all: [authenticate] },
    after:  { create: [publish(() => app.channel('leads'))] },
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

| Document                                          | Description                                        |
| ------------------------------------------------- | -------------------------------------------------- |
| [Philosophy](./docs/philosophy.md)                | Why FrontierJS exists and the principles behind it |
| [The FJS World](./docs/fjs-world.md)              | The eight domains and the decision framework       |
| [Architecture Overview](./docs/architecture.md)   | How the three realms connect                       |
| [Developer Guide](./docs/guide.md)                | Building with FrontierJS end-to-end                |
| [QuickStart](./docs/quickstart.md)                | Get a project running in minutes                   |
| [Terms & Definitions](./docs/terms.md)            | Vocabulary reference                               |
| [Code Examples](./docs/code-examples.md)          | Minimal working code for all three realms          |
| [Realm Bridge Reference](./docs/realm-bridges.md) | The seven integration points between realms        |

---

## Package Documentation

| Package                            | README                                               |
| ---------------------------------- | ---------------------------------------------------- |
| Litestone — Data realm ORM         | [packages/litestone](./packages/litestone/README.md) |
| Junction — API realm framework     | [packages/junction](./packages/junction/README.md)   |
| Sierra — UI meta-framework         | [packages/sierra](./packages/sierra/README.md)       |
| Mesa — Reactive component language | [packages/mesa](./packages/mesa/README.md)           |
| CLI — `fli`                        | [packages/cli](./packages/cli/README.md)             |

---

## Project Structure

A FrontierJS project separates concerns across sub-projects, all orbiting the shared schema:

```
my-app/
  frontier.config.js    ← environment config

  db/
    schema.lite         ← single source of truth
    migrations/
    backups/

  api/                  ← Junction API server
    src/
      services/
      middleware/
      jobs/
      automations/

  web/                  ← Sierra frontend
    src/
      routes/
      resources/
      components/

  tests/                ← cross-project integration tests
  wiki/                 ← project documentation
```

The database lives at the root — shared by all sub-projects, owned by none of them.

---

## Packages

| Package                 | Version                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@frontierjs/litestone` | [![npm](https://img.shields.io/npm/v/@frontierjs/litestone)](https://www.npmjs.com/package/@frontierjs/litestone) |
| `@frontierjs/junction`  | [![npm](https://img.shields.io/npm/v/@frontierjs/junction)](https://www.npmjs.com/package/@frontierjs/junction)   |
| `@frontierjs/sierra`    | [![npm](https://img.shields.io/npm/v/@frontierjs/sierra)](https://www.npmjs.com/package/@frontierjs/sierra)       |
| `@frontierjs/mesa`      | [![npm](https://img.shields.io/npm/v/@frontierjs/mesa)](https://www.npmjs.com/package/@frontierjs/mesa)           |
| `@frontierjs/cli`       | [![npm](https://img.shields.io/npm/v/@frontierjs/cli)](https://www.npmjs.com/package/@frontierjs/cli)             |

---

## License

MIT