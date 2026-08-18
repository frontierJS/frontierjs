// tests/client-types.test.ts
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
        const { store, service, load } = client.resource('posts')

        store.subscribe(rows => {
          const first: string | undefined = rows[0]?.title
          void first
        })

        // The proxy a resource hands back is the same row as its store — it
        // used to be a bare ServiceProxy, so destructuring one dropped the type
        // the caller had just asked for.
        const made: boolean = (await service.create({ title: 'x' })).published
        const listed: string | undefined = (await load())[0]?.title

        return [made, listed]
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
