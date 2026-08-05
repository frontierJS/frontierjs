// src/core/db.ts
// The Data boundary. One Litestone client for the whole app.
//
// Everything that touches Basecamp's data goes through here — services via
// `ctx.locals.db` (scoped to the caller by createApp({ db })), engines and
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
// — and that declaration WINS: createClient({ db }) is ignored when it is
// present, with no error and no warning. Passing both reads like the option
// decides the path, which is how a test that believed it was in-memory ended up
// writing the declared file.
//
// Both declared paths resolve against the PROCESS CWD, not this file — the
// database and the audit trail alike. Start the API from the package root or
// they land somewhere surprising.

import { createClient } from '@frontierjs/litestone'
import { env, DEV_ENCRYPTION_KEY } from './env.ts'

export type BasecampDb = Awaited<ReturnType<typeof createClient>>

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

  return createClient({
    path:          SCHEMA_PATH,
    encryptionKey: env.ENCRYPTION_KEY,
  })
}
