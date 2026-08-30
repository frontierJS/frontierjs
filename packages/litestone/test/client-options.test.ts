// ─── createClient's option list ───────────────────────────────────────────────
//
// An unknown OPTION was dropped the way JavaScript drops any undeclared key,
// while an unknown PROPERTY on the built client throws by design — so a typo'd
// accessor was loud and a typo'd capability quietly did not apply (`FJS-579`).
// Five test files in this directory passed `autoMigrate: true`, which has never
// been an option; every one of them opens a fresh database, where creating and
// migrating are the same thing, so all five passed either way.
//
// The first test is the one that keeps the rest honest. `CLIENT_OPTIONS` exists
// for the SUGGESTION — the refusal comes from the rest object and cannot go
// stale — but a list that drifts turns a good "did you mean" into silence, and
// nothing else would say so. It is compared against the destructure itself,
// read out of the source.

import { describe, test, expect } from 'bun:test'
import { readFileSync }           from 'node:fs'
import { join, dirname }          from 'node:path'
import { fileURLToPath }          from 'node:url'
import { createClient }           from '../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC  = join(HERE, '..', 'src', 'core', 'client.js')
const DTS  = join(HERE, '..', 'src', 'index.d.ts')

/** The names the destructure actually binds — the one authority. */
function destructured(): string[] {
  const src     = readFileSync(SRC, 'utf8')
  const head    = src.indexOf('export async function createClient({')
  const destruc = src.slice(head, src.indexOf('\n} = {}) {', head))
  return destruc.split('\n').slice(1)
    .map(l => l.replace(/\/\/.*$/, '').trim())
    .map(l => l.match(/^([A-Za-z_$][\w$]*)\s*[:=,]/)?.[1] ?? l.match(/^([A-Za-z_$][\w$]*),?$/)?.[1])
    .filter((k): k is string => Boolean(k) && k !== 'unknownOptions')
}

const S = 'model Shop { id Int @id @default(autoincrement())  name String }'
const open = (opts: any = {}) => createClient({ schema: S, db: ':memory:', ...opts })

describe("createClient's option list", () => {
  test('CLIENT_OPTIONS names exactly what the destructure takes', () => {
    const src    = readFileSync(SRC, 'utf8')
    const listed = src
      .slice(src.indexOf('const CLIENT_OPTIONS = ['), src.indexOf(']', src.indexOf('const CLIENT_OPTIONS = [')))
      .match(/'([^']+)'/g)!.map(q => q.slice(1, -1))
    const taken  = destructured()

    expect(taken.length).toBeGreaterThan(20)   // the parse found a destructure, not nothing
    expect(listed.sort()).toEqual(taken.sort())
  })

  // The third statement of the same fact, and the one with the opposite failure:
  // the refusal above is what a JS caller hits, and `CreateClientOptions` is what
  // a TS caller is held to. It under-declared `resolveFrom`, `busyTimeout` and
  // `now` — three real options an excess-property check refused, two of them the
  // subject of their own live hazards.
  test('CreateClientOptions declares exactly what the destructure takes', () => {
    const dts   = readFileSync(DTS, 'utf8')
    const head  = dts.indexOf('export interface CreateClientOptions {')
    const body  = dts.slice(head, dts.indexOf('\n}', head))
    const typed = [...body.matchAll(/^  ([A-Za-z_$][\w$]*)\??\s*:/gm)].map(m => m[1])

    expect(typed.sort()).toEqual(destructured().sort())
  })

  test('an unknown option is refused by name, and the message lists what is legal', async () => {
    const err: any = await open({ zzz: 1 }).catch((e: any) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('unknown option')
    expect(err.message).toContain('zzz')
    expect(err.message).toContain('busyTimeout')       // the list is in the sentence
  })

  test('a near miss suggests the option it is one edit from', async () => {
    for (const [typo, meant] of [['encryptionKy', 'encryptionKey'], ['busyTimeot', 'busyTimeout'], ['databses', 'databases']]) {
      const err: any = await open({ [typo]: 1 }).catch((e: any) => e)
      expect(err.message).toContain(`did you mean \`${meant}\``)
    }
  })

  test('autoMigrate answers with the function rather than a suggestion', async () => {
    const err: any = await open({ autoMigrate: true }).catch((e: any) => e)
    expect(err.message).toContain('is not an option')
    expect(err.message).toContain('autoMigrate(db)')
    expect(err.message).toContain('FJS-566')
    expect(err.message).not.toContain('did you mean')
  })

  test('a misspelling of an answered name gets the answer, not the nearest real option', async () => {
    const err: any = await open({ autoMigrateee: true }).catch((e: any) => e)
    expect(err.message).toContain('`autoMigrate` is not an option')
  })

  test('every unknown key is named, not just the first', async () => {
    const err: any = await open({ zzz: 1, qqq: 2 }).catch((e: any) => e)
    expect(err.message).toContain('unknown options')
    expect(err.message).toContain('zzz')
    expect(err.message).toContain('qqq')
  })

  test('CONTROL — a call naming only real options still opens', async () => {
    const db = await open({ pluralize: false, policyDebug: false, busyTimeout: 100 })
    expect(await db.shop.count()).toBe(0)
    db.$close()
  })

  test('CONTROL — a key set to undefined is still a key the caller wrote', async () => {
    // JavaScript cannot tell `{ zzz: undefined }` from a typo the caller meant,
    // and a spread that carries one is how a wrapper passes its own options on.
    const err: any = await open({ zzz: undefined }).catch((e: any) => e)
    expect(err.message).toContain('zzz')
  })
})
