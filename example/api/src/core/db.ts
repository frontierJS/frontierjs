// api/db.ts — the Data realm, wired once.
//
// Three things happen here and nowhere else: the schema is assembled, the gate
// resolver is installed, and the tables are created.

import { readFileSync } from 'node:fs'
import { join }         from 'node:path'

import { createTenantRegistry, autoMigrate, GatePlugin, FileStorage } from '@frontierjs/litestone'
import { authSchemaFragments }                   from '@frontierjs/auth'
import { outboxSchemaFragment }                  from '@frontierjs/junction'

import { shopGateLevel } from './gate.ts'

const HERE = import.meta.dir

// ─── The schema ───────────────────────────────────────────────────────────
//
// db/schema.lite is the app. The four auth models are APPENDED from auth's own
// exported fragments rather than pasted into the file, so there is one copy of
// them in the repo. Two consequences worth knowing:
//
//   · The browser build reads db/schema.lite from disk and therefore never
//     sees User / Credential / Session / Verification. That is correct — the
//     three credential models are @@gate("8"), and User reads at USER(4),
//     which is still above anything a public page may publish.
//   · `fli auth:install` writes them to disk instead — User appended into
//     db/schema.lite, the three @@gate("8") models into db/auth.lite, imported.
//     Same bytes, both ways: auth ships them as .lite and schema.ts reads them.
//     This file is the in-memory alternative, for an app assembling one string.

export const appSchema = readFileSync(join(HERE, '../../../db/schema.lite'), 'utf8')

// OutboxMessage arrives the same way and for the same reason — it is
// @@gate("8") framework machinery that changes when @frontierjs/junction does,
// so there is one copy of it in the repo. `fli outbox:install` writes an
// `import` line into db/schema.lite instead; both read the same shipped bytes.
// What the shop says about a model auth ships. It is a separate file and it is
// NOT imported by db/schema.lite, because that file is read by the browser
// build ALONE — no auth fragments — where `extend model User` is refused by
// name and takes the whole schema registry down with it. This is the one place
// both halves exist. See db/user.lite.
export const userExtension = readFileSync(join(HERE, '../../../db/user.lite'), 'utf8')

export const fullSchema = appSchema + '\n' + authSchemaFragments('main')
                                    + '\n' + outboxSchemaFragment('main')
                                    + '\n' + userExtension

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

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? DEV_KEY

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
// `dir` and `registry` are passed rather than left to the declaration. Relative
// paths in the block resolve against the SCHEMA FILE's directory, and this app
// assembles its schema in memory (auth's fragments, the outbox model), so there
// is no file to resolve against and the declaration would land them beside
// whatever directory the process happened to start in. The CLI, which reads the
// file, gets the same two paths from the block.
export const SHOPS_DIR     = join(HERE, '../../../db/shops')
export const SHOPS_REGISTRY = join(HERE, '../../../db/shops-registry.db')

// `database audit` is the one file the registry does NOT redirect — a logger
// database is shared across the fleet by design — so its declared path is the
// only one still resolving against the process CWD. Every site and widget
// script runs `cd <surface>` first, which is how `example/site/db/` came to
// exist and sit there ignored by `*.db*`. Named absolutely here for the same
// reason `dir` and `registry` are: a schema assembled in memory has no file to
// anchor a relative path against.
export const AUDIT_DIR = join(HERE, '../../../db/audit') + '/'

const registry = await createTenantRegistry({
  schema:        fullSchema,
  dir:           SHOPS_DIR,
  registry:      SHOPS_REGISTRY,
  encryptionKey: ENCRYPTION_KEY,

  // Every tenant's client is built with these. Without the gate every signed-in
  // user grades 1 and cannot write (see core/gate.ts); without FileStorage a
  // `File` column has nowhere to put the bytes.
  clientOptions: {
    databases: { audit: { path: AUDIT_DIR } },

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
  if (!_migrated.has(id)) { autoMigrate(client); _migrated.add(id) }
  return client
}

// The flagship always exists — a fresh clone has no files at all, and an API
// that boots with no shop is an app where every request 404s for a reason that
// has nothing to do with the request.
await registry.getOrCreate(DEFAULT_SHOP)

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
// to write rows no caller is authorised to write. Everything else goes through
// the gate.
export const sys = db.asSystem()
