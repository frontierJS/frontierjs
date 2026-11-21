// test/app-db-type.test.ts
//
// FJS-2482 / FJS-D877 -- does the app's generated client reach `$.db`, its one
// spelling (FJS-D1331)?
//
// Nothing at runtime can answer that, so this compiles: the REAL generator's
// system-audience output with `--augment junction`, junction's real entry
// behind the package specifier the augmentation names. `paths` is what makes it
// honest -- without it the augmentation declares a NEW ambient module and
// passes while proving nothing. The negative halves ride in the same run
// (`@ts-expect-error` is an error when its line compiles).
//
// The second case is the other branch of the conditional: an app that
// registers nothing keeps the hand-written `LitestoneClient`, whose models
// answer `unknown` rows and whose accessors accept any name.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { parse, generateTypeScript } from '../../litestone/src/index.js'

const HERE    = import.meta.dir
const JUNCTION = resolve(HERE, '../index.ts')
const JUNCTION_CLIENT = resolve(HERE, '../src/client/index.ts')
const LITESTONE = resolve(HERE, '../../litestone/src/index.d.ts')
const TSC     = resolve(HERE, '../../../node_modules/.bin/tsc')

// The program holds junction's whole entry, so tsc runs for seconds.
const TSC_MS = 60_000

const SCHEMA = `
  model Verse {
    id     Int    @id
    text   String
    bookId Int?
    note   String? @guarded
    book   Book?  @relation(fields: [bookId], references: [id])
  }
  model Book {
    id     Int    @id
    name   String
    verses Verse[]
  }
`

function compile(usage: string, opts: { generated: boolean; browser?: boolean }): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'junction-app-db-'))
  try {
    const files = ['use.ts']
    if (opts.generated) {
      const dts = generateTypeScript(parse(SCHEMA).schema, { audience: 'system', augment: 'junction' })
      writeFileSync(join(dir, 'db.d.ts'), dts)
      files.unshift('db.d.ts')
    }
    if (opts.browser) {
      const dts = generateTypeScript(parse(SCHEMA).schema, { audience: 'client', augment: 'junction' })
      writeFileSync(join(dir, 'web-db.d.ts'), dts)
      files.unshift('web-db.d.ts')
    }
    writeFileSync(join(dir, 'use.ts'), usage)
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict:                     true,
        // Junction's source imports toolbelt's untyped .js; the fixture is
        // graded for its own lines, not for the workspace's declaration gaps.
        noImplicitAny:              false,
        target:                    'ESNext',
        module:                     'Preserve',
        moduleResolution:           'bundler',
        lib:                        ['ESNext', 'DOM', 'DOM.Iterable'],
        types:                      ['bun-types'],
        typeRoots:                  [resolve(HERE, '../../../node_modules')],
        skipLibCheck:               true,
        allowImportingTsExtensions: true,
        noEmit:                     true,
        paths: {
          '@frontierjs/junction':  [JUNCTION],
          '@frontierjs/junction/client': [JUNCTION_CLIENT],
          '@frontierjs/litestone': [LITESTONE],
        },
      },
      files,
    }, null, 2))

    const proc = Bun.spawnSync([TSC, '--noEmit', '-p', dir], { cwd: dir })
    const out  = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr)
    return { ok: proc.exitCode === 0, out }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const TYPED = `
  import { $ } from '@frontierjs/junction'
  import type { ServiceContext } from '@frontierjs/junction'

  export async function viaAmbient() {
    const verse = await $.db.verse.findUnique({ where: { id: 1 }, include: { book: true } })
    const text: string | undefined = verse?.text
    const name: string | undefined = verse?.book?.name
    // @ts-expect-error -- a column the model lacks
    await $.db.verse.findFirst({ where: { nope: 1 } })
    return { text, name }
  }

  export async function notOnLocals(ctx: ServiceContext) {
    // @ts-expect-error -- locals is scratch; the client is $.db alone
    return ctx.locals.db.verse
  }
`

const UNTYPED = `
  import { $ } from '@frontierjs/junction'

  export async function viaAmbient() {
    const rows: unknown[] = await $.db.verse.findMany()
    const sys = $.db.asSystem()
    return { rows, sys }
  }
`

// FJS-4410 -- a raw route's client is the one `app.principalFor(ctx)` scopes,
// and it answers the type `$.db` does. The README's raw-route example is this.
const RAW_ROUTE = `
  import { createApp } from '@frontierjs/junction'

  const app = createApp({})
  app.post('/{owner}/{repo}.git/git-receive-pack', async (ctx) => {
    const { db } = await ctx.app.principalFor(ctx)
    const book = await db.book.findFirst({ where: { name: ctx.route.repo } })
    if (!book) return ctx.json({ message: 'Not Found' }, 404)
    if (!(await db.$checkWrite('book', 'update', book)).ok) return ctx.json({ message: 'Forbidden' }, 403)
    // @ts-expect-error -- a column the model lacks
    await db.book.findFirst({ where: { nope: 1 } })
    return ctx.json({ name: book.name })
  })
`

const RAW_ROUTE_UNTYPED = `
  import { createApp } from '@frontierjs/junction'

  const app = createApp({})
  app.get('/books', async (ctx) => {
    const { db } = await ctx.app.principalFor(ctx)
    return ctx.json(await db.book.findMany())
  })
`

describe('the registered client reaches $.db', () => {
  test('a raw route reads the same client through app.principalFor(ctx)', () => {
    const { ok, out } = compile(RAW_ROUTE, { generated: true })
    expect(out).toBe('')
    expect(ok).toBe(true)
  }, TSC_MS)

  test('a raw route in an app that registers nothing keeps the hand-written LitestoneClient', () => {
    const { ok, out } = compile(RAW_ROUTE_UNTYPED, { generated: false })
    expect(out).toBe('')
    expect(ok).toBe(true)
  }, TSC_MS)

  test('an app that augments AppDb reads typed rows through it, and not through ctx.locals', () => {
    const { ok, out } = compile(TYPED, { generated: true })
    expect(out).toBe('')
    expect(ok).toBe(true)
  }, TSC_MS)

  // FJS-4507 -- a scaffold's db/schema.d.ts and web/src/lib/db.d.ts sit in one
  // tsc program, and a @guarded column makes their rows differ. Both registering
  // the browser's ServiceTypes is TS2320 there.
  test('the system and browser files compile in one program', () => {
    const browser = `
      import type { ServiceTypes } from '@frontierjs/junction/client'
      // @ts-expect-error -- the browser's row has no @guarded column
      export const note: ServiceTypes['verses']['note'] = null
    `
    const { ok, out } = compile(TYPED + browser, { generated: true, browser: true })
    expect(out).toBe('')
    expect(ok).toBe(true)
  }, TSC_MS)

  test('an app that registers nothing keeps the hand-written LitestoneClient', () => {
    const { ok, out } = compile(UNTYPED, { generated: false })
    expect(out).toBe('')
    expect(ok).toBe(true)
  }, TSC_MS)
})
