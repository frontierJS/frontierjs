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
import { authSchemaFragments, authUserModel, authMachineryModels, retargetDb } from '../schema.ts'
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

  test('declares the five auth models, PascalCase singular', () => {
    const names = parsed().schema.models.map(m => m.name).sort()
    expect(names).toEqual(['Credential', 'OauthFlow', 'Session', 'User', 'Verification'])
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


// ─── the split ───────────────────────────────────────────────────────────────
// The two `.lite` files this package ships are the source, and they are split by
// WHO OWNS THE MODEL — which the gate already states. User is the app's: it gets
// columns added, relations point at it, and `fli auth:install` appends it into
// the app's own schema.lite. The other three are @@gate("8"), meaning nothing
// outside asSystem() speaks to them, so they go in a file the app imports.
//
// A model that drifted across that line would be a real change with no other
// symptom: put User at 8 and an app cannot list its own people, put a credential
// model below 8 and its material becomes reachable from a request.

const modelsIn = (source: string) => {
  const result = parse(PREAMBLE + source)
  expect(result.errors ?? []).toEqual([])
  return (result.schema as any).models as any[]
}

const gateOf = (model: any) => model.attributes.find((a: any) => a.kind === 'gate')?.value

describe('the two shipped .lite files', () => {

  test('each half parses standalone against a host schema', () => {
    expect(modelsIn(authUserModel('main')).map(m => m.name)).toEqual(['User'])
    expect(modelsIn(authMachineryModels('main')).map(m => m.name).sort())
      .toEqual(['Credential', 'OauthFlow', 'Session', 'Verification'])
  })

  test('the halves are exactly the composed fragment', () => {
    expect(modelsIn(authSchemaFragments('main')).map(m => m.name).sort())
      .toEqual(['Credential', 'OauthFlow', 'Session', 'User', 'Verification'])
  })

  // The line the split is drawn on. Asserted rather than described, because a
  // model moving across it changes what an app can do and nothing else fails.
  test('the machinery is locked to asSystem() and User is not', () => {
    for (const m of modelsIn(authMachineryModels('main'))) expect(gateOf(m)).toBe('8')
    expect(gateOf(modelsIn(authUserModel('main'))[0])).toBe('4.4.4.5')
  })
})

describe('retargetDb', () => {

  test('--db moves every model, and main is a no-op', () => {
    const dbOf = (src: string) =>
      modelsIn(`database other { path "./other.db" }\n` + src)
        .map(m => `${m.name}→${m.attributes.find((a: any) => a.kind === 'db')?.name}`)

    expect(dbOf(authSchemaFragments('other')).sort())
      .toEqual(['Credential→other', 'OauthFlow→other', 'Session→other', 'User→other', 'Verification→other'])
    expect(authSchemaFragments('main')).toBe(retargetDb(authSchemaFragments('main'), 'main'))
  })

  // The files spell @@db(main) although an absent @@db already means main — the
  // literal exists solely so this substitution has something to match. Tidy it
  // out of the .lite files and --db silently stops working.
  test('every shipped model spells @@db(main) for the substitution to find', () => {
    expect(modelsIn(authSchemaFragments('main')).length).toBe(5)
    expect([...authSchemaFragments('main').matchAll(/^[ \t]*@@db\(main\)/gm)]).toHaveLength(5)
  })

  // Both .lite headers describe the substitution, so they contain the literal in
  // prose. A substring replace rewrote those sentences as well, which is why the
  // rule is line-anchored on both sides.
  test('a prose mention of the attribute is left alone', () => {
    const moved = authMachineryModels('other')
    expect(moved).toContain('rewrites @@db(main) when --db names another database')
    expect(moved).not.toContain('@@db(other) when --db')
  })
})

// ─── the CLI copy, which is gone ─────────────────────────────────────────────
// `fli auth:install` carried a hand copy of these models and it drifted three
// times. It reads the shipped `.lite` files out of the app's node_modules now
// (`FJS-038`), and both halves of that are checked here: that the copy has not
// come back, and that the ONE rule the CLI still restates — the @@db swap, which
// it cannot import because `fli` runs on node and schema.ts is TypeScript —
// still agrees with this package's.

describe('fli auth:install carries no copy of the schema', () => {

  const installMd = () =>
    readFileSync(join(import.meta.dir, '..', '..', 'cli', 'commands', 'auth', 'install.md'), 'utf8')

  test('it declares no models of its own', () => {
    const src = installMd()
    for (const model of ['User', 'Credential', 'Session', 'Verification']) {
      expect(src).not.toMatch(new RegExp(`^\\s*model\\s+${model}\\s*\\{`, 'm'))
    }
  })

  // Executed, not sighted. The CLI's arrow is lifted out of the markdown and run
  // against the shipped file; a mismatched literal fails here rather than in an
  // app that asked for --db and quietly got main.
  test('its @@db swap produces exactly what this package produces', () => {
    const src   = installMd()
    const match = src.match(/const retargetDb = \(source, db\) =>\n(.*)\n/)
    expect(match).not.toBeNull()

    const cliRetarget = new Function('source', 'db', `return ${match![1].trim()}`) as
      (source: string, db: string) => string

    const shipped = readFileSync(join(import.meta.dir, '..', 'db', 'auth.lite'), 'utf8')
    for (const db of ['main', 'auth']) {
      expect(cliRetarget(shipped, db)).toBe(authMachineryModels(db))
    }
  })
})
