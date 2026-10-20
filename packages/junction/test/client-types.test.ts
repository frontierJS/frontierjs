// test/client-types.test.ts
//
// The browser half of FJS-018: does a schema's generated row type actually
// reach `client.service('posts')`?
//
// Nothing at runtime can answer that, so this compiles. A fixture is written to
// a temp directory — the REAL generator's output, junction's real client source
// behind the package specifier the augmentation names — and `tsc --noEmit` is
// run over it. The negative half rides in the same run: `@ts-expect-error` is an
// ERROR when the line it marks compiles cleanly, so a fixture that asserts a
// bogus column is refused fails the compile the moment inference stops working
// and everything silently widens back to `Record<string, unknown>`.
//
// The `paths` mapping is what makes this honest: `@frontierjs/junction/client`
// has no self-link inside this workspace, so without it the augmentation would
// declare a NEW ambient module and pass while proving nothing.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Through the package entry, not the tool file: `index.d.ts` is where the
// generator's options are DECLARED, so importing the module directly grades the
// call against whatever TypeScript infers from the JSDoc instead.
import { parse, generateTypeScript } from '../../litestone/src/index.js'

const HERE       = import.meta.dir
const CLIENT_SRC = resolve(HERE, '../src/client/index.ts')
const TSC        = resolve(HERE, '../../../node_modules/.bin/tsc')

const SCHEMA = `
  model Post {
    id        Int      @id
    title     String
    published Boolean  @default(false)
  }
`

/** Write the fixture, compile it, hand back tsc's own words. */
function compile(usage: string, opts: { augment?: 'junction' } = {}): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'junction-client-types-'))
  try {
    const dts = generateTypeScript(parse(SCHEMA).schema, { augment: opts.augment ?? undefined })
    writeFileSync(join(dir, 'db.d.ts'), dts)
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
        // The augmentation names the package; this is where the package is.
        paths: { '@frontierjs/junction/client': [CLIENT_SRC] },
      },
      files: ['db.d.ts', 'use.ts'],
    }, null, 2))

    const proc = Bun.spawnSync([TSC, '--noEmit', '-p', dir], { cwd: dir })
    const out  = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr)
    return { ok: proc.exitCode === 0, out }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the generated types reach the browser client', () => {
  test('a declared service infers its row, and a column the model lacks is refused', () => {
    const { ok, out } = compile(`
      import { createJunctionClient } from '@frontierjs/junction/client'

      const client = createJunctionClient({ url: 'http://localhost:3400' })

      export async function run() {
        const rows: { id: number; title: string }[] = await client.service('posts').findData()

        // Inferred, with no type argument anywhere above.
        const title: string = rows[0]!.title

        // @ts-expect-error — 'slug' is not a column on Post
        const slug: string = rows[0]!.slug

        // A row goes back the same way it came.
        const one = await client.service('posts').get(1)
        const published: boolean = one.published

        return { title, slug, published }
      }
    `, { augment: 'junction' })

    expect(out).toBe('')
    expect(ok).toBe(true)
  }, 30_000)

  test('an app that generates nothing keeps the open shape', () => {
    // No augmentation: `keyof ServiceTypes` is never, so the inferring overload
    // matches no call. This is every app today, and it must not become a
    // compile error.
    const { ok, out } = compile(`
      import { createJunctionClient } from '@frontierjs/junction/client'

      const client = createJunctionClient({ url: 'http://localhost:3400' })

      export async function run() {
        const rows = await client.service('posts').findData()
        // Untyped rows: anything is readable, nothing is checked.
        return rows[0]?.anythingAtAll
      }
    `)

    expect(out).toBe('')
    expect(ok).toBe(true)
  }, 30_000)

  test('an explicit type argument still wins, on a declared name and an unknown one', () => {
    // The inferring overload constrains its parameter to a registered name, so
    // `service<Foo>('posts')` fails it and falls through to the open overload
    // rather than erroring. A caller that was passing a type before the registry
    // existed keeps doing so.
    const { ok, out } = compile(`
      import { createJunctionClient } from '@frontierjs/junction/client'

      interface Draft extends Record<string, unknown> { headline: string }

      const client = createJunctionClient({ url: 'http://localhost:3400' })

      export async function run() {
        const mine  = await client.service<Draft>('posts').findData()
        const other = await client.service<Draft>('not-a-model').findData()
        return [mine[0]?.headline, other[0]?.headline]
      }
    `, { augment: 'junction' })

    expect(out).toBe('')
    expect(ok).toBe(true)
  }, 30_000)

  test('resource() infers the same row as service()', () => {
    const { ok, out } = compile(`
      import { createJunctionClient } from '@frontierjs/junction/client'

      const client = createJunctionClient({ url: 'http://localhost:3400' })

      export async function run() {
        const { tether, service, load } = client.resource('posts')

        tether.subscribe(rows => {
          const first: string | undefined = rows[0]?.title
          void first
        })

        // The proxy a resource hands back is the same row as its tether — it
        // used to be a bare ServiceProxy, so destructuring one dropped the type
        // the caller had just asked for.
        const made: boolean = (await service.create({ title: 'x' })).published
        const listed: string | undefined = (await load())[0]?.title

        // Every option is named, the row key included (FJS-D1316).
        const keyed = client.resource('posts', { idField: 'id', model: 'Post' })
        const title: string | undefined = keyed.tether.get()[0]?.title
        // @ts-expect-error — no positional argument after the name
        client.resource('posts', 'id')

        return [made, listed, title]
      }
    `, { augment: 'junction' })

    expect(out).toBe('')
    expect(ok).toBe(true)
  }, 30_000)

  test('the compile is real — a genuine type error fails it', () => {
    // Without this the four tests above prove only that tsc ran.
    const { ok, out } = compile(`
      import { createJunctionClient } from '@frontierjs/junction/client'

      const client = createJunctionClient({ url: 'http://localhost:3400' })

      export async function run() {
        const rows = await client.service('posts').findData()
        const n: number = rows[0]!.title
        return n
      }
    `, { augment: 'junction' })

    expect(ok).toBe(false)
    expect(out).toContain('use.ts')
  }, 30_000)
})

// FJS-2656: a method's declared `output:` reaches `invoke()`/`call()` once the
// app says which service answers it. The map is app code -- `litestone types`
// reads the seed and the seed holds no `methods:` -- so the fixture states it.
describe('a declared method answer reaches invoke() and call()', () => {
  const SEARCH_SCHEMA = `
    type SearchResult { total Int }
    model Post { id Int @id  title String }
  `

  function compileMethods(usage: string, augmentMethods: boolean): { ok: boolean; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'junction-client-methods-'))
    try {
      const dts = generateTypeScript(parse(SEARCH_SCHEMA).schema, { augment: 'junction' })
      writeFileSync(join(dir, 'db.d.ts'), dts)
      writeFileSync(join(dir, 'methods.d.ts'), augmentMethods ? `
        import type { SearchResult } from './db'
        declare module '@frontierjs/junction/client' {
          interface ServiceMethods { posts: { search: SearchResult } }
        }
        export {}
      ` : 'export {}\n')
      writeFileSync(join(dir, 'use.ts'), usage)
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          strict: true, target: 'ESNext', module: 'Preserve', moduleResolution: 'bundler',
          lib: ['ESNext', 'DOM', 'DOM.Iterable'], types: [], skipLibCheck: true,
          allowImportingTsExtensions: true, noEmit: true,
          paths: { '@frontierjs/junction/client': [CLIENT_SRC] },
        },
        files: ['db.d.ts', 'methods.d.ts', 'use.ts'],
      }, null, 2))
      const proc = Bun.spawnSync([TSC, '--noEmit', '-p', dir], { cwd: dir })
      const out  = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr)
      return { ok: proc.exitCode === 0, out }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('a declared method answers its type, and a field it lacks is refused', () => {
    const { ok, out } = compileMethods(`
      import { createJunctionClient } from '@frontierjs/junction/client'

      const client = createJunctionClient({ url: 'http://localhost:3400' })

      export async function run() {
        const posts = client.service('posts')
        const viaInvoke = await posts.invoke('search', 1, { q: 'x' })
        const viaCall   = await posts.call('search', 1, { q: 'x' })
        const a: number = viaInvoke.total
        const b: number = viaCall.total
        // @ts-expect-error -- 'hits' is not a field of SearchResult
        const c = viaInvoke.hits
        return [a, b, c]
      }
    `, true)

    expect(out).toBe('')
    expect(ok).toBe(true)
  }, 30_000)

  test('an undeclared method, and an app that declares nothing, answer unknown as before', () => {
    const declared = compileMethods(`
      import { createJunctionClient } from '@frontierjs/junction/client'
      const client = createJunctionClient({ url: 'http://localhost:3400' })
      export async function run() {
        const r: unknown = await client.service('posts').invoke('archive', 1)
        return r
      }
    `, true)
    expect(declared.out).toBe('')
    expect(declared.ok).toBe(true)

    const bare = compileMethods(`
      import { createJunctionClient } from '@frontierjs/junction/client'
      const client = createJunctionClient({ url: 'http://localhost:3400' })
      export async function run() {
        const r: unknown = await client.service('posts').invoke('search', 1)
        return r
      }
    `, false)
    expect(bare.out).toBe('')
    expect(bare.ok).toBe(true)
  }, 30_000)
})

// ─── FJS-503: a method's input types its body ───────────────────────────────

describe('defineMethod types ctx.data from the seed type its input names', () => {
  const SEED = `
    type TrackingUpdate { trackingCode String }
    model Order { id Int @id }
  `

  function compileSeed(usage: string, generated: boolean): { ok: boolean; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'junction-seed-types-'))
    try {
      const files = ['use.ts']
      if (generated) {
        writeFileSync(join(dir, 'db.d.ts'), generateTypeScript(parse(SEED).schema, { augment: 'junction' }))
        files.unshift('db.d.ts')
      }
      writeFileSync(join(dir, 'use.ts'), usage)
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          strict: true, noImplicitAny: false, target: 'ESNext', module: 'Preserve',
          moduleResolution: 'bundler', lib: ['ESNext', 'DOM', 'DOM.Iterable'],
          types: ['bun-types'], typeRoots: [resolve(HERE, '../../../node_modules')],
          skipLibCheck: true, allowImportingTsExtensions: true, noEmit: true,
          paths: { '@frontierjs/junction': [resolve(HERE, '../index.ts')] },
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

  test('ctx.data infers the declared shape, and a typo in input: is a compile error', () => {
    const { ok, out } = compileSeed(`
      import { defineMethod, type MethodDeclaration } from '@frontierjs/junction'

      export const recordTracking = defineMethod('TrackingUpdate', ctx => {
        const { trackingCode } = ctx.data
        const code: string = trackingCode
        // @ts-expect-error -- trackingCode is a string
        trackingCode.toFixed()
        // @ts-expect-error -- not a field of TrackingUpdate
        ctx.data.courier
        return code
      })

      export const entry: MethodDeclaration = { method: 'recordTracking', input: 'TrackingUpdate' }

      // @ts-expect-error -- no seed type of that name
      export const typo: MethodDeclaration = { method: 'recordTracking', input: 'TrackingUpdte' }

      // @ts-expect-error -- no seed type of that name
      defineMethod('TrackingUpdte', () => null)
    `, true)

    expect(out).toBe('')
    expect(ok).toBe(true)
  }, 90_000)

  test('an app that generates nothing keeps the open shape', () => {
    const { ok, out } = compileSeed(`
      import { defineMethod, type MethodDeclaration } from '@frontierjs/junction'

      export const m = defineMethod('Anything', ctx => ctx.data.whatever)
      export const entry: MethodDeclaration = { method: 'm', input: 'Anything' }
    `, false)

    expect(out).toBe('')
    expect(ok).toBe(true)
  }, 90_000)
})
