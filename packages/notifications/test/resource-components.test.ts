// test/resource-components.test.ts
//
// FJS-3451 / FJS-D1455: the bell and the list the package ships through
// `./resource/*.mesa`. Three things go wrong quietly and are graded here: the
// files are not reachable by the export map, a clean compile emits a module
// that does not parse (Invariant 15), and a write reaches the service without
// `mutate`, which leaves the bell's count up until a reload (FJS-2111).

import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// Resolves a specifier through this package's own export map, the way an app does.
const exported = (name: string) => join(root, pkg.exports['./resource/*.mesa'].replace('*', name))

// The workspace's compiler by path: `@frontierjs/mesa` resolves to an install-time copy.
const compilerPath = join(root, '..', 'mesa', 'src', 'compiler.js')
const { compileSource } = await import(compilerPath)
const transpiler = new Bun.Transpiler({ loader: 'js' })

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('resource/ export map', () => {
  test('exports ./resource/*.mesa, ships resource/, and peers on mesa and ui', () => {
    expect(pkg.exports['./resource/*.mesa']).toBe('./resource/*.mesa')
    expect(pkg.files).toContain('resource')
    expect(Object.keys(pkg.peerDependencies)).toEqual(expect.arrayContaining(['@frontierjs/mesa', '@frontierjs/ui']))
  })

  for (const name of ['NotificationBell', 'NotificationList']) {
    test(`${name}.mesa exists at its exported path`, () => {
      expect(readFileSync(exported(name), 'utf8').length).toBeGreaterThan(0)
    })
  }
})

describe('resource/*.mesa compile', () => {
  for (const name of ['NotificationBell', 'NotificationList']) {
    test(`${name}.mesa compiles clean and its output parses as JS`, async () => {
      const warnings: string[] = []
      const ctx = await compileSource(readFileSync(exported(name), 'utf8'), {
        filename: `resource/${name}.mesa`,
        warning: (w: any) => warnings.push(w.message ?? String(w)),
      })
      expect(ctx.analysis?.errors ?? []).toEqual([])
      expect(warnings).toEqual([])
      // A clean compile can still emit a module that throws on load.
      expect(() => transpiler.transformSync(ctx.result)).not.toThrow()
    })
  }
})

describe('resource/ writes', () => {
  const files = readdirSync(join(root, 'resource')).filter(f => /\.(mesa|js)$/.test(f))
  const code = files.map(f => stripComments(readFileSync(join(root, 'resource', f), 'utf8'))).join('\n')

  test('the service is called only as the run of a mutate', () => {
    const lines = code.split('\n').filter(l => /\.service\./.test(l))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).toMatch(/\(\)\s*=>\s*notifications\.service\./)
  })

  test('no component reaches for a tether-less write or a resource of its own', () => {
    expect(code).not.toMatch(/createResource/)
    expect(code).not.toMatch(/\.invoke\(/)
  })

  test('a held row shows read at once, and mark-all is one mutate per unread row', async () => {
    const rows: any = await import(join(root, 'resource', 'rows.js'))
    const mutated: Array<{ id: number; intent: any }> = []
    const patched: number[] = []
    const notifications = {
      mutate: async (id: number, intent: any, run: () => Promise<unknown>) => {
        mutated.push({ id, intent })
        return run()
      },
      service: { patch: async (id: number) => { patched.push(id) } },
    }
    const list = [
      { id: 1, readAt: null }, { id: 2, readAt: '2026-01-01T00:00:00.000Z' }, { id: 3, readAt: null },
    ]

    await rows.markRead(notifications, list[0])
    expect(mutated[0]!.intent.readAt).toBeString()
    await rows.markUnread(notifications, list[1])
    expect(mutated[1]).toEqual({ id: 2, intent: { readAt: null } })

    mutated.length = 0
    patched.length = 0
    expect(await rows.markAllRead(notifications, list)).toBe(2)
    expect(mutated.map(m => m.id)).toEqual([1, 3])
    expect(patched).toEqual([1, 3])
  })

  test('a failed write in mark-all is thrown, not swallowed', async () => {
    const rows: any = await import(join(root, 'resource', 'rows.js'))
    const notifications = {
      mutate: async () => { throw new Error('refused') },
      service: { patch: async () => {} },
    }
    await expect(rows.markAllRead(notifications, [{ id: 1, readAt: null }])).rejects.toThrow('refused')
  })
})
