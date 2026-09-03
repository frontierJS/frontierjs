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
// Both declared paths resolve against the PROCESS CWD, not this file — the
// database and the audit trail alike. Start the API from the package root or
// they land somewhere surprising.
//
// That is a property this app DEPENDS on rather than merely tolerates, so do not
// "fix" it with `resolveFrom: 'schema'`: db/test/seed.test.ts isolates a run by
// giving it a scratch CWD, and it redirects `database main` by env var and
// `database audit` by the CWD alone. Anchoring sends that audit log back to the
// shared db/audit/ and the suite fails on a locked database (`FJS-449`).
//
// `database audit` DOES have an env var — `AUDIT_PATH` — and nothing sets it,
// which is why the CWD is still what isolates it. The two drives disagree about
// this: db/test/seed.test.ts isolates by CWD and gets an isolated trail, while
// web/test/verify-screens.mjs redirects DATABASE_URL and runs with `cwd: PKG`,
// so its audit rows land in the developer's own db/audit/ (`FJS-633`). Setting
// AUDIT_PATH in both is what would make `resolveFrom: 'schema'` safe here, and
// it is also what would let the API's snapshots move into api/ the way
// example's have.

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
    encryptionKey: env.ENCRYPTION_KEY,
    // Supplying a GatePlugin REPLACES the one a @@gate-carrying schema installs
    // for itself. Supplying none does not turn gates off — the default resolver
    // takes over, and it grades a session on standing that travels with the
    // user, which cannot express *admin of THIS workspace*. Every caller here
    // would grade USER(4) in every workspace, including ones they are not in.
    plugins: [new GatePlugin({ getLevel: basecampGateLevel })],
  }) as unknown as BasecampDb
}
