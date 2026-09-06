// api/src/core/db.ts — the Data realm, wired once.
//
// Three things happen here and nowhere else: the schema is assembled, the gate
// resolver is installed, and the tables are created.

import { join }         from 'node:path'

import { createTenantRegistry, autoMigrate, GatePlugin, FileStorage } from '@frontierjs/litestone'

import { shopGateLevel } from './gate.ts'

const HERE = import.meta.dir

// ─── The schema ───────────────────────────────────────────────────────────
//
// **db/schema.lite is the whole of it, and this file assembles nothing**
// (`FJS-626`). It used to append auth's fragments, junction's outbox model and
// db/user.lite in memory, which meant the app ran a schema no tool could read:
// every one of them takes a PATH, so `access.snapshot.md`,
// `release.snapshot.md`, `ddl.snapshot.sql` and `jsonschema.snapshot.md` each
// described 32 models while 39 ran. The seven missing were `User`, `Credential`,
// `Session`, `Verification`, `OauthFlow`, `OutboxMessage` and the audit trail —
// the identity model and the credential store, in the one artefact whose whole
// job is *who may do what*. The `snapshots` CI phase passed throughout, because
// it re-runs the same command from the same directory and gets the same
// incomplete answer.
//
// The deploy gate is what made it worth fixing rather than documenting:
// `release:check` compares release SURFACES, so a contract on `Session` was in
// neither and graded expand.
//
// The models now arrive the way `fli auth:install` and `fli outbox:install`
// write them — `User` pasted into schema.lite because an app owns that one, the
// rest `import`ed so a package upgrade reaches this app. `parseFile` resolves an
// import and every reader uses it, so the browser build gets them too, which is
// what let db/user.lite become an ordinary `import "./user.lite"` rather than a
// third string concatenated here.

// The FILE. It is what every relative `database { path }` and the `tenancy { }`
// block resolve against once `resolveFrom: 'schema'` is stated below, and it is
// now also where the schema itself comes from (`FJS-449`).
export const SCHEMA_FILE = join(HERE, '../../../db/schema.lite')

// ─── The client ───────────────────────────────────────────────────────────
//
// NOTE there is no `db:` option. db/schema.lite declares `database main`, and
// that declaration wins — a `db:` passed here would be ignored silently, which
// is a memorable way to lose an afternoon when you think you are running
// against ':memory:' and are in fact writing a file.

// 64 hex characters — 32 bytes decoded. A 64-character string is not enough:
// the key is parsed as hex, so 'dev' padded to 64 chars decodes to ONE byte and
// createClient rejects it with "must be 32 bytes (got 1)".
export const DEV_KEY = 'deadbeef'.repeat(8)

// Exported because a drive building its own client off this schema gets `@frontierjs/auth`'s `@encrypted` columns with it, so it
// needs the key the app is using rather than one of its own.
export const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? DEV_KEY

if (!process.env.ENCRYPTION_KEY) {
  console.warn(
    '[example] ENCRYPTION_KEY not set — using a fixed development key.\n' +
    '          Fine here; never anywhere real. Generate one with: openssl rand -hex 32'
  )
}

// ─── Where the bytes go ───────────────────────────────────────────────────
//
// A `File` column stores a JSON REFERENCE; the bytes live in object storage.
// Locally that is a directory this API serves, which makes three settings one
// fact and they have to agree:
//
//   localPath   where the plugin writes          → api/db.ts, here
//   keyPattern  the path under it                → here; leads with `storage/`
//               and carries no `:id`, which resolves to the string
//               "new" on every create — the key is chosen on the way
//               IN, before the row has an id to name
//   publicBase  what fileUrl() rebuilds from     → here
//   http.static what actually serves the bytes   → api/app.ts, rooted at the same dir
//
// `publicBase` is not optional the way it looks. fileUrl() rebuilds a URL from
// publicBase, or failing that from `endpoint` — and a LOCAL ref carries neither
// unless one is stated, so it resolves to null, `<img src={null}>` renders a
// broken image, and nothing anywhere reports an error.
export const STORAGE_ROOT = join(HERE, '../../../db/public')
export const STORAGE_BASE = process.env.STORAGE_BASE ?? `http://localhost:${process.env.API_PORT ?? 8110}`

// ─── The fleet ────────────────────────────────────────────────────────────
//
// One shop is one FILE. `db/schema.lite` declares `tenancy { strategy database
// }`, so there is no single client here any more — there is a registry, and
// every request opens the shop it names.
//
// `path` is what makes the DECLARATION usable from any directory. The block says
// `dir "./shops"` and `registry "./shops-registry.db"`, written against the
// schema file's own directory; the string handed over here was assembled in
// memory (auth's fragments, the outbox model), so without naming the file those
// two land beside whatever directory the process happened to start in. Three
// scripts here `cd <surface>` before running, which is how an orphan
// `example/site/db/` came to exist and sit unnoticed under the repo's `*.db*`
// ignore, and how one `vite build` prerendered twelve product pages as zero
// products and exited 0 (`FJS-449`).
//
// The CLI reads the file and gets the same two paths. That is the point: one
// answer, whoever is asking.
const registry = await createTenantRegistry({
  // No `schema:`. Handed the path alone, litestone reads it with `parseFile`,
  // which resolves the imports — which is the whole of what makes the committed
  // artefacts describe the schema that runs.
  path:          SCHEMA_FILE,
  encryptionKey: ENCRYPTION_KEY,

  // Every tenant's client is built with these. Without the gate every signed-in
  // user grades 1 and cannot write (see core/gate.ts); without FileStorage a
  // `File` column has nowhere to put the bytes.
  clientOptions: {
    // Every tenant client anchors its declared paths the same way. `database
    // audit` is the one file the registry does NOT redirect — a logger database
    // is shared across the fleet by design — so it is the one that was still
    // following the process CWD, and it is now the declaration's `./db/audit/`
    // read from the app root.
    path:        SCHEMA_FILE,
    resolveFrom: 'schema',

    plugins: [
      new GatePlugin({ getLevel: shopGateLevel }),
      FileStorage({
        provider:   'local',
        localPath:  STORAGE_ROOT,
        publicBase: STORAGE_BASE,
        keyPattern: 'storage/:model/:uuid.:ext',
      }),
    ],
  },
})

/**
 * The shop a request that names no shop is for.
 *
 * `resolve subdomain` deliberately has no default — nothing can infer whether a
 * host, a header or a claim names the tenant — so the default is the APP's
 * decision and it is made here, once. This one exists because the whole of this
 * example is one shop with twelve drives pointed at `localhost`, and because a
 * storefront built ahead of time belongs to an origin rather than to a request.
 *
 * A real fleet would answer 404 instead. That is a one-line change, in one
 * place, which is the point of the wrapper.
 */
export const DEFAULT_SHOP = process.env.SHOP ?? 'flagship'

/**
 * Open a shop, and bring it up to the current schema the first time.
 *
 * `create()` writes fresh DDL for a shop that has never existed, which covers a
 * new one — but a shop created before a column was added has no path forward:
 * `registry.migrate()` is for apps that keep migration FILES, and this one uses
 * `autoMigrate`, which diffs the live database against the seed. So the diff
 * runs on first open, once per shop per process. An unchanged schema migrates
 * nothing, which is what makes that cheap enough to do on the way in.
 */
const _migrated = new Set<string>()
async function openShop(id: string) {
  const client = await registry.get(id)
  if (!_migrated.has(id)) {
    const result = autoMigrate(client)
    _migrated.add(id)
    // The result was thrown away, and a blocked migration is exactly the state
    // worth hearing about: this shop's database holds something this build's
    // schema does not describe. litestone names the DATABASE, which is "main"
    // for every shop under `strategy database`, so its own line cannot say
    // which one — and a fleet reaches this one shop at a time (`FJS-566`).
    for (const [name, r] of Object.entries(result ?? {})) {
      if ((r as { state?: string }).state !== 'blocked') continue
      console.warn(
        `[example] shop "${id}" (${name}) is NOT on this build's schema: ` +
        `${(r as { reason?: string }).reason}\n` +
        `          It is serving anyway. See the litestone line above for the two readings.`)
    }
  }
  return client
}

// The flagship always exists — a fresh clone has no files at all, and an API
// that boots with no shop is an app where every request 404s for a reason that
// has nothing to do with the request.
await registry.getOrCreate(DEFAULT_SHOP)

// The flagship's own settings, under `config` because the rest of the meta blob
// is the fleet's business and this key is junction's (`tenantConfig` in app.ts).
// `set` merges, so it is safe to run on every boot and does not stamp over
// whatever else a shop keeps here.
registry.meta.set(DEFAULT_SHOP, {
  config: { name: 'Flagship Store', mail: { from: 'orders@flagship.test' } },
})

/**
 * What `createApp({ tenants })` is handed: the registry, with this app's answer
 * for a request that names no shop.
 *
 * A wrapper rather than an option, because the fallback is a policy and not a
 * capability — `withTenantDb` asks `tenantFor` and Litestone's own answer is
 * *nobody said*. Saying which shop that means is exactly the kind of decision
 * that belongs in an app.
 */
export const shops = {
  tenancy:   registry.tenancy,
  tenantFor: (from: { host?: string | null, headers?: Record<string, unknown> | null, principal?: unknown }) =>
    registry.tenantFor(from) ?? DEFAULT_SHOP,
  get:       (id: string) => openShop(id),
  exists:    (id: string) => registry.exists(id),
  // The fleet half, for the seeder, the CLI-shaped scripts and the drive.
  create:      (id: string, meta?: Record<string, unknown>) => registry.create(id, meta),
  getOrCreate: async (id: string) => { await registry.getOrCreate(id); return openShop(id) },
  list:        () => registry.list(),
  // Each shop's own settings, which the registry has always carried as a JSON
  // blob and nothing has ever read. This is what `createApp({ tenantConfig })`
  // resolves per shop — a control plane rather than a row, which is the shape
  // `FJS-D126` refused to declare precisely because it differs per app.
  meta:        (id: string) => registry.meta.get(id) as Record<string, unknown>,
  metaSet:     (id: string, patch: Record<string, unknown>) => registry.meta.set(id, patch),
  delete:      (id: string) => registry.delete(id),
}

/**
 * The flagship's client, for everything that has no request to resolve a shop
 * from: the seeder, the two jobs, and the static site build.
 *
 * It is not "the database" any more and the name is kept deliberately — a
 * module that imports this is naming ONE shop, and the day it should have named
 * the caller's is the day it must reach for `ctx.locals.db` instead.
 */
export const db = await openShop(DEFAULT_SHOP)

// asSystem() is the documented bypass — the seed and the auth package both need
// to write rows no caller is authorized to write. Everything else goes through
// the gate.
export const sys = db.asSystem()
