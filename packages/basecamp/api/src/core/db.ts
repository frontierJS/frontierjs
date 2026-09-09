// src/core/db.ts
// The Data boundary. One Litestone client for the whole app.
//
// Everything that touches Basecamp's data goes through here — services via
// `ctx.locals.db` (scoped to the caller by createApp({ db })), jobs and
// bootstrap code via `asSystem()`. There is no second path: raw SQL against
// this database is how the previous version drifted out of sync with the
// schema, and the columns it assumed no longer exist.
//
// Two things this file is responsible for getting right:
//
//   1. The schema is db/schema.lite, resolved relative to THIS FILE, so the
//      client does not care what directory the process was started from.
//   2. The encryption key is passed. Secret.data is @encrypted; without a key
//      createClient() throws. env.ts makes it required for the same reason.
//
// What it deliberately does NOT pass is `db`. The database file is declared in
// the schema — `database main { path env("DATABASE_URL", "./db/basecamp.db") }`
// — and that declaration is the one statement of it. `db` OVERRIDES it, so
// passing both here would mean the deployment's DATABASE_URL is read and then
// ignored.
//
// Both declared paths resolve against the APP ROOT, not the process CWD, so the
// app opens the same database from the package root, from api/, or from a
// generator rerun anywhere else.
//
// The root is derived from the schema FILE and is not its directory:
// `schemaAnchor` steps out of a directory named `db`, which is where this
// schema lives. So the two declared paths keep the spelling they had when the
// CWD was the anchor — `./db/basecamp.db`, `./db/audit/` — and rewriting them
// relative to `db/` moves both. That is not theoretical: doing it put the
// database at packages/basecamp/basecamp.db and the trail at
// packages/basecamp/audit/, and litestone migrated the new file to the full
// schema, so a 319-check drive ran green against a database nobody meant.
//
// The anchor used to be the CWD, and it was load-bearing rather than incidental:
// a database here is TWO declared paths, and every isolating caller stated one
// of them and inherited the other from the directory it happened to run in.
// That is why the two drives disagreed — db/test/seed.test.ts gave the seeder a
// scratch CWD and got both moved, web/test/verify-screens.mjs redirected
// DATABASE_URL and ran with `cwd: PKG`, so its audit rows landed in the
// developer's own db/audit/ with nothing failing either way (`FJS-633`).
//
// Anchoring is only safe once both are STATED, which is what changed: every
// caller that redirects one now names the other. `FJS-449` is the failure that
// made the CWD load-bearing in the first place — an anchored audit log going
// back to the shared db/audit/ and the suite locking on it — and it cannot
// happen to a caller that names AUDIT_PATH.
//
// A deployment is unaffected — it binds both absolutely (/data/basecamp.db,
// /data/audit/) and an absolute path has no anchor.

import { createClient, GatePlugin } from '@frontierjs/litestone'
import { env, DEV_ENCRYPTION_KEY } from './env.ts'
import { basecampGateLevel }       from './gate.ts'

// db/schema.d.ts is GENERATED from db/schema.lite by `bun run db:types`, and
// `bun run test` fails if it is stale. audience=system, because this is the
// server: `Secret.data` is @encrypted and core/credentials.ts reads it through
// asSystem(), so the client-audience file — which strips protected columns —
// would type a real read as an error.
import type { LitestoneClient } from '../../../db/schema.d.ts'

// `createClient`'s own return type is the untyped client: every accessor is a
// Proxy no static type describes, so every row read out of one was `unknown`
// and had to be cast at the call site. The generated interface is the same
// client with the schema's own shapes on it.
export type BasecampDb = LitestoneClient

const SCHEMA_PATH = new URL('../../../db/schema.lite', import.meta.url).pathname

export async function createBasecampDb(): Promise<BasecampDb> {
  // The dev key is in the repo. Booting production on it would encrypt every
  // stored SSH key and provider token with a value anyone can read — which is
  // worse than plaintext, because the column reads as protected.
  if (env.NODE_ENV === 'production' && env.ENCRYPTION_KEY === DEV_ENCRYPTION_KEY)
    throw new Error(
      'ENCRYPTION_KEY is still the development placeholder. Secret.data would be ' +
      'encrypted with a publicly-known key. Set it: openssl rand -hex 32'
    )

  // The cast is the seam, and it is one line in one file: createClient answers
  // litestone's own untyped LitestoneClient, and the generated interface is
  // that same client with THIS schema's shapes on it. Nothing downstream casts.
  return createClient({
    path:          SCHEMA_PATH,
    // A relative declared path is anchored to the schema rather than to
    // wherever the process was started. See the header.
    resolveFrom:   'schema',
    encryptionKey: env.ENCRYPTION_KEY,
    // Supplying a GatePlugin REPLACES the one a @@gate-carrying schema installs
    // for itself. Supplying none does not turn gates off — the default resolver
    // takes over, and it grades a session on standing that travels with the
    // user, which cannot express *admin of THIS workspace*. Every caller here
    // would grade USER(4) in every workspace, including ones they are not in.
    plugins: [new GatePlugin({ getLevel: basecampGateLevel })],
  }) as unknown as BasecampDb
}
