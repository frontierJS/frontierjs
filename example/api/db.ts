// api/db.ts — the Data realm, wired once.
//
// Three things happen here and nowhere else: the schema is assembled, the gate
// resolver is installed, and the tables are created.

import { readFileSync } from 'node:fs'
import { join }         from 'node:path'

import { createClient, autoMigrate, GatePlugin } from '@frontierjs/litestone'
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

export const appSchema = readFileSync(join(HERE, '../db/schema.lite'), 'utf8')

// OutboxMessage arrives the same way and for the same reason — it is
// @@gate("8") framework machinery that changes when @frontierjs/junction does,
// so there is one copy of it in the repo. `fli outbox:install` writes an
// `import` line into db/schema.lite instead; both read the same shipped bytes.
export const fullSchema = appSchema + '\n' + authSchemaFragments('main')
                                    + '\n' + outboxSchemaFragment('main')

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

export const db = await createClient({
  schema:        fullSchema,
  encryptionKey: ENCRYPTION_KEY,

  // Without this every signed-in user grades 1 and cannot write. See api/gate.ts.
  plugins: [new GatePlugin({ getLevel: shopGateLevel })],
})

autoMigrate(db)

// asSystem() is the documented bypass — the seed and the auth package both need
// to write rows no caller is authorised to write. Everything else goes through
// the gate.
export const sys = db.asSystem()
