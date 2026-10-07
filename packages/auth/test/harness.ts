// test/harness.ts
// Stands up a real Litestone database from the schema this package ships,
// and a real createLitestoneAuth() over it.
//
// Deliberately NOT a mock: the defects this package has had — plural
// accessors, `.get()` on a table, gate levels — were all invisible to a fake
// db and obvious against a real one. See ../../VERIFYING.md.

import { createClient, parse, generateDDLForDatabase } from '@frontierjs/litestone'
import { splitStatements } from '@frontierjs/litestone/migrate'
import { Database } from 'bun:sqlite'
import { tempDir } from '../../litestone/src/tmp-dirs.js'
import { join } from 'path'
import { authSchemaFragments } from '../schema.ts'
import { createLitestoneAuth } from '../auth.ts'
import type { LitestoneAuthOptions } from '../types.ts'

// 64 hex chars = 32 bytes. Test-only.
export const TEST_KEY =
  'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'

// Temp dirs cannot be removed when a test finishes and cannot be removed at
// exit either, so a run reaps the PREVIOUS runs' on the way in. The reasoning,
// and the two measurements behind it, are in litestone's tmp-dirs.js — this
// file is where the class was first fixed (FJS-362) and no longer holds its
// own copy of the sweep.
//
// Relative, not '@frontierjs/litestone/testing': bun resolves workspace:* to a
// COPY under node_modules/.bun, so the package spec tests a stale reaper.

export interface Harness {
  db:          any
  sys:         any
  auth:        ReturnType<typeof createLitestoneAuth>
  /** Last token handed to onPasswordResetRequested. */
  resetToken:  () => string
  /**
   * `requestPasswordReset` for a KNOWN address, resolving once the token is
   * minted. The method answers before it mints (FJS-1832), so awaiting it
   * alone reads the previous token. Hangs where `opts` replaces the callback.
   */
  requestReset: (email: string) => Promise<void>
  /** Resolves at the next token minted — for a reset requested over HTTP. Start it before the request. */
  nextReset:   () => Promise<void>
  /** Last token handed to onEmailVerificationRequested. */
  verifyToken: () => string
  /** Marks this harness done. Files are reaped by the NEXT run — see above. */
  cleanup:     () => void
}

/**
 * `clock` is what makes expiry testable at all. Four models here declare
 * `@@expires(expiresAt)`, so the filter reads the CLIENT's clock rather
 * than the host's — move it and a session lapses with nothing written and
 * nothing swept. While the predicate was a hand-rolled `new Date()`, no test
 * could stage that at all: it read the wall clock, so a lapse cost real time.
 */
export async function makeAuth(
  opts:  LitestoneAuthOptions = {},
  clock?: { now: () => Date },
): Promise<Harness> {
  const dir = tempDir('fjs-auth-')
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

  const db = await createClient({ parsed, encryptionKey: TEST_KEY, ...(clock ? { now: clock.now } : {}) })

  let resetToken = '', verifyToken = ''
  let resetMinted = () => {}
  const auth = createLitestoneAuth(db, {
    encryptionKey: TEST_KEY,
    onPasswordResetRequested:     async (_e, t) => { resetToken  = t; resetMinted() },
    onEmailVerificationRequested: async (_e, t) => { verifyToken = t },
    ...opts,
  })

  return {
    db,
    sys:         db.asSystem(),
    auth,
    resetToken:  () => resetToken,
    nextReset:   () => new Promise<void>(r => { resetMinted = r }),
    requestReset: async (email: string) => {
      const minted = new Promise<void>(r => { resetMinted = r })
      await auth.requestPasswordReset!(email)
      await minted
    },
    verifyToken: () => verifyToken,
    cleanup:     () => { /* dir is reaped by the next run */ },
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

/**
 * A login that produced a session.
 *
 * `login()` answers a union since `FJS-D261`, and a test that wanted the token
 * has to say which half it expected. A cast would have been one character and
 * would read `undefined.token` the day a fixture grows a second factor; this
 * names the case instead. `test/totp-login.test.ts` is where the other half is
 * asserted on purpose.
 */
export function signedIn(result: any): { token: string; user: any } {
  if (result && 'challenge' in result) {
    throw new Error('expected a session — this login owed a second factor')
  }
  return result
}
