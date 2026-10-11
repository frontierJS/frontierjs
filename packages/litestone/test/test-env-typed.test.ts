// test/test-env-typed.test.ts
//
// FJS-1125 — does `createTestEnv()` hand a test the app's generated client?
//
// Like registered-client.test.ts this compiles, because nothing at runtime can
// answer it: the generator's real output is written beside a consumer file and
// `tsc --noEmit` is run over both. `paths` points both specifiers at this
// source, or the augmentation would declare a NEW ambient module and pass
// while proving nothing.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { parse, generateTypeScript } from '../src/index.js'

const HERE    = import.meta.dir
const SRC     = resolve(HERE, '../src/index.d.ts')
const TESTING = resolve(HERE, '../src/testing.d.ts')
const TSC     = resolve(HERE, '../../../node_modules/.bin/tsc')

const SCHEMA = `
  model Employee {
    id   Int    @id
    name String
  }
`

// An app that registered nothing is the same program with no db.d.ts.
const REGISTERED = `
  import { createTestEnv } from '@frontierjs/litestone/testing'

  export async function run() {
    const env = await createTestEnv({ schema: 'model Employee { id Int @id\\n name String }' })
    const sys = await env.system.employee.findFirst({ where: { name: 'a' } })
    const as  = await env.actingAs({ id: 1 }).employee.findFirst({ where: { name: 'a' } })
    const at  = await (await env.atLevel(3)).employee.findFirst({ where: { name: 'a' } })
    const row: { id: number; name: string } | null = sys
    // @ts-expect-error -- a column the model lacks
    await env.system.employee.findFirst({ where: { nope: 1 } })
    return { ...row, ...as, ...at }
  }
`

const EXPLICIT = `
  import { createTestEnv } from '@frontierjs/litestone/testing'
  import type { LitestoneClient as Db } from './db.js'

  export async function run() {
    const env = await createTestEnv<Db>({ schema: 'model Employee { id Int @id\\n name String }' })
    const row = await env.system.employee.findFirst({ where: { name: 'a' } })
    // @ts-expect-error -- a column the model lacks
    await env.actingAs(null).employee.findFirst({ where: { nope: 1 } })
    return row
  }
`

// FJS-2531 -- a fixture row is the model's row, so its id goes into a where.
const FACTORIES = `
  import { createTestEnv } from '@frontierjs/litestone/testing'

  export async function run() {
    const env = await createTestEnv({
      schema:        'model Employee { id Int @id\\n name String }',
      autoFactories: true,
    })
    const users = env.factories.employee.asSystem()
    const me    = await users.createOne()
    const id: number = me.id
    const [a]   = await users.createMany(2)
    const same  = await env.system.employee.findFirst({ where: { id: me.id, name: a.name } })
    // @ts-expect-error -- an accessor the schema lacks
    env.factories.nobody
    return { id, same }
  }
`

function compile(usage: string, files: Record<string, string>): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'litestone-test-env-'))
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    writeFileSync(join(dir, 'use.ts'), usage)
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict:                     true,
        target:                     'ESNext',
        module:                     'Preserve',
        moduleResolution:           'bundler',
        lib:                        ['ESNext', 'DOM', 'DOM.Iterable'],
        types:                      [],
        skipLibCheck:               true,
        allowImportingTsExtensions: true,
        noEmit:                     true,
        paths: {
          '@frontierjs/litestone':         [SRC],
          '@frontierjs/litestone/testing': [TESTING],
        },
      },
      files: [...Object.keys(files), 'use.ts'],
    }, null, 2))

    const proc = Bun.spawnSync([TSC, '--noEmit', '-p', dir], { cwd: dir })
    const out  = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr)
    return { ok: proc.exitCode === 0, out }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const generated = generateTypeScript(parse(SCHEMA).schema, { audience: 'system' })

describe('createTestEnv answers the app\'s client', () => {
  test('a registered client types env.system, actingAs() and atLevel() with no call-site change', () => {
    const { ok, out } = compile(REGISTERED, { 'db.d.ts': generated })
    expect(out).toBe('')
    expect(ok).toBe(true)
  })

  test('env.factories answers each model\'s row, so createOne().id goes straight into a where', () => {
    const { ok, out } = compile(FACTORIES, { 'db.d.ts': generated })
    expect(out).toBe('')
    expect(ok).toBe(true)
  })

  test('a type argument names the client when nothing is registered', () => {
    const { ok, out } = compile(EXPLICIT, { 'db.d.ts': generated.replace(/declare module[\s\S]*?\n\}\n/, '') })
    expect(out).toBe('')
    expect(ok).toBe(true)
  })

  test('with nothing registered and no argument, a table stays unknown', () => {
    const { ok, out } = compile(REGISTERED, {})
    expect(ok).toBe(false)
    expect(out).toContain('use.ts')
  })
})

// FJS-2325 -- verifyTenantIsolation is on every TestEnv, so its type names it
// and the verdicts' `got` values, or an app's filter on them is `any`.
const TENANCY = `
  import { createTestEnv } from '@frontierjs/litestone/testing'

  export async function run() {
    const env   = await createTestEnv({ schema: 'model Employee { id Int @id\\n name String }' })
    const rows  = await env.verifyTenantIsolation({ ops: ['read', 'post-update'], actors: [{ workspaceId: 1 }, { workspaceId: 2 }] })
    const leaks = rows.filter(r => r.got === 'leaked')
    const model: string | null = leaks[0].model
    // @ts-expect-error -- not a verdict
    rows.filter(r => r.got === 'nope')
    // @ts-expect-error -- not an op
    await env.verifyTenantIsolation({ ops: ['nope'] })
    return model
  }
`

describe('verifyTenantIsolation is typed', () => {
  test('the method and its verdict values are on TestEnv', () => {
    const { ok, out } = compile(TENANCY, { 'db.d.ts': generated })
    expect(out).toBe('')
    expect(ok).toBe(true)
  })
})

// FJS-2144 -- the runtime returns the main database file's path, so a test that
// opens it from a second process reads it without a cast.
const PATH = `
  import { createTestEnv } from '@frontierjs/litestone/testing'

  export async function run() {
    const env = await createTestEnv({ schema: 'model Employee { id Int @id\\n name String }' })
    const file: string = env.path
    // @ts-expect-error -- a string, not a number
    const n: number = env.path
    return { file, n }
  }
`

describe('env.path is typed', () => {
  test('the main database file is a string on TestEnv', () => {
    const { ok, out } = compile(PATH, { 'db.d.ts': generated })
    expect(out).toBe('')
    expect(ok).toBe(true)
  })
})
