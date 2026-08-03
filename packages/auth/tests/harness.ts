// tests/harness.ts
// Stands up a real Litestone database from the schema this package ships,
// and a real createLitestoneAuth() over it.
//
// Deliberately NOT a mock: the defects this package has had — plural
// accessors, `.get()` on a table, gate levels — were all invisible to a fake
// db and obvious against a real one. See ../../VERIFYING.md.

import { createClient, parse, generateDDLForDatabase } from '@frontierjs/litestone'
import { splitStatements } from '@frontierjs/litestone/migrate'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { authSchemaFragments } from '../schema.ts'
import { createLitestoneAuth } from '../auth.ts'
import type { LitestoneAuthOptions } from '../types.ts'

// 64 hex chars = 32 bytes. Test-only.
export const TEST_KEY =
  'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'

// Temp dirs are removed at process exit, not when a test finishes.
//
// `@@log(audit)` on User/Session flushes through the jsonl driver AFTER the
// awaited call returns, so tearing the directory down inside afterAll() raced
// it and produced `SQLITE_READONLY_DBMOVED` unhandled errors between tests.
// (Consistent with the "audit logger async flush" landmine in ../../CLAUDE.md.)
const tempDirs: string[] = []
let exitHookInstalled = false

function removeAtExit(dir: string): void {
  tempDirs.push(dir)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const d of tempDirs) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })
}

export interface Harness {
  db:          any
  sys:         any
  auth:        ReturnType<typeof createLitestoneAuth>
  /** Last token handed to onPasswordResetRequested. */
  resetToken:  () => string
  /** Last token handed to onEmailVerificationRequested. */
  verifyToken: () => string
  /** Marks this harness done. Files are reaped at process exit — see above. */
  cleanup:     () => void
}

export async function makeAuth(opts: LitestoneAuthOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-auth-'))
  removeAtExit(dir)
  const dbPath = join(dir, 'auth.db')

  const source = `
database main  { path "${dbPath}" }
database audit { path "${dir}/audit/"; driver logger; retention 90d }
` + authSchemaFragments('main')

  const parsed = parse(source)
  if (!parsed.valid) throw new Error(`schema failed to parse: ${parsed.errors.join(', ')}`)

  const raw = new Database(dbPath)
  for (const stmt of splitStatements(generateDDLForDatabase(parsed.schema, 'main'))) {
    if (!stmt.startsWith('PRAGMA')) raw.run(stmt)
  }
  raw.close()

  process.env.MAIN_DB_PATH = dbPath
  process.env.AUDIT_PATH   = `${dir}/audit/`

  const db = await createClient({ parsed, encryptionKey: TEST_KEY })

  let resetToken = '', verifyToken = ''
  const auth = createLitestoneAuth(db, {
    encryptionKey: TEST_KEY,
    onPasswordResetRequested:     async (_e, t) => { resetToken  = t },
    onEmailVerificationRequested: async (_e, t) => { verifyToken = t },
    ...opts,
  })

  return {
    db,
    sys:         db.asSystem(),
    auth,
    resetToken:  () => resetToken,
    verifyToken: () => verifyToken,
    cleanup:     () => { /* dir is reaped at process exit */ },
  }
}

/** Asserts a promise rejects with a specific error class, and returns the error. */
export async function rejectsWith<T extends Error>(
  fn: () => Promise<unknown>,
  type: new (...args: any[]) => T,
): Promise<T> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof type) return err
    throw new Error(`expected ${type.name}, got ${(err as Error).constructor.name}: ${(err as Error).message}`)
  }
  throw new Error(`expected ${type.name}, but the call resolved`)
}
