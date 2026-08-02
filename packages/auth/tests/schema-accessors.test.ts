// tests/schema-accessors.test.ts
//
// Two coupled bugs, both of which only surfaced at runtime against a real app:
//
//   error: "users" is not a table in this schema.
//     at login (auth.ts:101)
//
// 1. auth.ts and cleanup.ts called sys.users / sys.credentials / sys.sessions /
//    sys.verifications. Litestone's modelToAccessor is plain camelCase of the
//    model name (src/core/ddl.js), and the documented convention is PascalCase
//    singular — so `model User` is reached as db.user. The plural accessors
//    only worked against a schema that broke the convention.
//
// 2. authSchemaFragments() emitted `model users` (matching the plural calls, so
//    the two bugs concealed each other) and used the type names `Text` and
//    `Integer`. Litestone lists both in RENAMED_TYPES and rejects them outright
//    — "no aliases are accepted" — so the fragments `fli auth:install` injects
//    would not parse at all against current Litestone.
//
// This test closes the loop the two bugs left open: the schema this package
// ships must parse, and every accessor this package calls must exist in it.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { authSchemaFragments } from '../schema.ts'
import { parse } from '@frontierjs/litestone/parser'
import { modelToAccessor } from '@frontierjs/litestone/ddl'

// The fragments are injected into a host schema; @@db(main) and @@log(audit)
// can't resolve standalone.
const PREAMBLE = `
database main  { path "./app.db" }
database audit { path "./audit/"; driver logger; retention 90d }
`

function parsed() {
  const result = parse(PREAMBLE + authSchemaFragments('main'))
  return result
}

describe('authSchemaFragments', () => {

  test('parses against the current Litestone parser', () => {
    const { valid, errors } = parsed()
    expect(errors ?? []).toEqual([])
    expect(valid).toBe(true)
  })

  test('uses current scalar type names', () => {
    // Text / Integer / Real / Blob are in RENAMED_TYPES and hard-rejected.
    const frag = authSchemaFragments('main')
    for (const removed of ['Text', 'Integer', 'Real', 'Blob']) {
      expect(frag).not.toMatch(new RegExp(`\\s${removed}\\??\\s`))
    }
  })

  test('declares the four auth models, PascalCase singular', () => {
    const names = parsed().schema.models.map(m => m.name).sort()
    expect(names).toEqual(['Credential', 'Session', 'User', 'Verification'])
  })
})

describe('table methods', () => {

  // Litestone tables expose findMany / findFirst / findUnique /
  // findFirstOrThrow / findUniqueOrThrow / count / exists / aggregate /
  // groupBy / findManyCursor / create / createMany / update / updateMany /
  // upsert / upsertMany / remove / removeMany / restore / delete / deleteMany
  // / search. There is no `get`.
  //
  // verifySession called `sys.user.get(session.userId)`, so every
  // authenticated request threw. Login itself succeeded — it never touches
  // .get() — which made it look like auth worked and then silently bounced:
  // the 401 made the browser client emit 'unauthorized', Sierra cleared the
  // stored token and redirected to /login/, and clicking Sign in looped.
  const LITESTONE_TABLE_METHODS = new Set([
    'findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow',
    'count', 'exists', 'aggregate', 'groupBy', 'findManyCursor', 'query',
    'create', 'createMany', 'update', 'updateMany', 'upsert', 'upsertMany',
    'remove', 'removeMany', 'restore', 'delete', 'deleteMany', 'search',
  ])

  test('every table method the package calls exists on a Litestone table', () => {
    const src = ['auth.ts', 'cleanup.ts']
      .map(f => readFileSync(join(import.meta.dir, '..', f), 'utf8'))
      .join('\n')

    const called = [...new Set(
      [...src.matchAll(/\b(?:sys|db)\.[a-zA-Z]+\.([a-zA-Z]+)\(/g)].map(m => m[1])
    )]

    expect(called.length).toBeGreaterThan(0)
    for (const method of called) {
      expect([...LITESTONE_TABLE_METHODS]).toContain(method)
    }
  })

  test('no .get() calls on tables', () => {
    const src = ['auth.ts', 'cleanup.ts']
      .map(f => readFileSync(join(import.meta.dir, '..', f), 'utf8'))
      .join('\n')
    expect(src).not.toMatch(/\b(?:sys|db)\.[a-zA-Z]+\.get\(/)
  })
})

describe('accessor consistency', () => {

  test('every accessor the package calls exists in the schema it ships', () => {
    const accessors = parsed().schema.models.map(m => modelToAccessor(m.name))

    const src = ['auth.ts', 'cleanup.ts']
      .map(f => readFileSync(join(import.meta.dir, '..', f), 'utf8'))
      .join('\n')

    const called = [...new Set(
      [...src.matchAll(/\bsys\.([a-zA-Z_]\w*)\./g)].map(m => m[1])
    )]

    expect(called.length).toBeGreaterThan(0)   // guard against a silent regex miss
    for (const name of called) {
      expect(accessors).toContain(name)
    }
  })

  test('no plural accessors remain', () => {
    const src = ['auth.ts', 'cleanup.ts']
      .map(f => readFileSync(join(import.meta.dir, '..', f), 'utf8'))
      .join('\n')
    expect(src).not.toMatch(/\bsys\.(users|credentials|sessions|verifications)\./)
  })
})
