// test/registered-client.test.ts
//
// FJS-1258 / FJS-D495 — does `createClient()` answer the app's generated client?
//
// Nothing at runtime can answer that, so this compiles. The REAL generator's
// output is written beside a consumer file and `tsc --noEmit` is run over both.
// `paths` points the package specifier at this source: without it the
// augmentation would declare a NEW ambient module and pass while proving
// nothing. `@ts-expect-error` rides in the same run, so the negative half fails
// the compile the moment a model accessor widens back to `unknown`.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { parse, generateTypeScript } from '../src/index.js'

const HERE = import.meta.dir
const SRC  = resolve(HERE, '../src/index.d.ts')
const TSC  = resolve(HERE, '../../../node_modules/.bin/tsc')

const SCHEMA = `
  model Employee {
    id   Int    @id
    name String
    pin  String @guarded
  }
`

const USAGE = `
  import { createClient } from '@frontierjs/litestone'

  export async function run() {
    const db  = await createClient({ schema: 'model X { id Int @id }', db: ':memory:' })
    const one = await db.employee.findFirst({ where: { name: 'a' } })
    const sys = await db.asSystem().employee.findFirst({ where: { name: 'a' } })
    const row: { id: number; name: string } | null = sys
    // @ts-expect-error -- a column the model lacks
    await db.employee.findFirst({ where: { nope: 1 } })
    return { ...one, ...row }
  }
`

function compile(audience: 'client' | 'system'): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'litestone-registered-'))
  try {
    writeFileSync(join(dir, 'db.d.ts'), generateTypeScript(parse(SCHEMA).schema, { audience }))
    writeFileSync(join(dir, 'use.ts'), USAGE)
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
        paths: { '@frontierjs/litestone': [SRC] },
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

describe('the generated client reaches createClient()', () => {
  test('a system-audience file types db and db.asSystem() with no call-site change', () => {
    const { ok, out } = compile('system')
    expect(out).toBe('')
    expect(ok).toBe(true)
  })

  test('a client-audience file registers nothing: it strips what the server client reads', () => {
    const { ok, out } = compile('client')
    expect(ok).toBe(false)
    expect(out).toContain('use.ts')
  })

  test('the registration is a module augmentation of the package, system audience only', () => {
    const sys    = generateTypeScript(parse(SCHEMA).schema, { audience: 'system' })
    const client = generateTypeScript(parse(SCHEMA).schema, { audience: 'client' })
    expect(sys).toContain(`declare module '@frontierjs/litestone'`)
    expect(sys).toContain('interface Register')
    expect(client).not.toContain('interface Register')
  })
})
