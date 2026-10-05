// test/signatures.test.js — core/signatures.js and `fli sig`
//
// An agent that cannot ask for a signature greps src and reads a hundred lines
// around every hit (`FJS-1547`). So the answer must be the declaration as
// written, found through the re-export an app imports it by — and graded
// against the real workspace, since a fixture only proves the fixture.

import { test, expect, describe } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir }                 from 'node:os'
import { join, resolve }          from 'node:path'
import { typeScriptAt }           from '../core/functions.js'
import { entryPoints, collectExports, matchSymbol, renderSymbol, importFrom } from '../core/signatures.js'

const REPO = resolve(import.meta.dir, '../../..')
const ts   = await typeScriptAt(REPO)

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'fli-sig-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const FIXTURE = {
  'packages/demo/package.json': JSON.stringify({ name: '@frontierjs/demo', exports: { '.': './index.ts', './extra': { import: './extra.js' } } }),
  'packages/demo/index.ts': `export * from './core.ts'\nexport { renamed as reexported } from './extra.js'\n`,
  'packages/demo/core.ts': `/** Grants a token.\n *  Second line. */\nexport function grant(opts: GrantOptions, now = Date.now()): Token {\n  return { id: 1 }\n}\n\nexport const mint = (a: string): string => {\n  return a\n}\n\nexport interface GrantOptions {\n  /** Who holds it. */\n  subject: string\n  ttl?: number\n}\n\ninterface Token { id: number }\n`,
  'packages/demo/extra.js': `/** a plain-js export */\nexport function renamed(a, b) {\n  return a + b\n}\n`,
  'packages/private/package.json': JSON.stringify({ name: '@frontierjs/private', private: true, exports: { '.': './index.ts' } }),
  'packages/private/index.ts': `export function hidden(): void {\n}\n`,
}

describe('entryPoints', () => {
  test('reads a string, a condition map and main; skips non-code targets', () => {
    expect(entryPoints({ exports: { '.': './a.ts', './b': { types: './b.d.ts', import: './b.js' }, './l': './x.lite' } }))
      .toEqual([{ subpath: '.', file: './a.ts' }, { subpath: './b', file: './b.d.ts' }])
    expect(entryPoints({ main: './index.ts' })).toEqual([{ subpath: '.', file: './index.ts' }])
  })
})

describe('collectExports (fixture)', () => {
  const root = workspace(FIXTURE)
  const rows = collectExports(ts, root)
  const by   = name => rows.find(r => r.name === name)

  test('a function is its head with the body cut and its comment kept', () => {
    const r = by('grant')
    expect(r.kind).toBe('function')
    expect(r.text).toBe('export function grant(opts: GrantOptions, now = Date.now()): Token')
    expect(r.doc).toBe('Grants a token.\n Second line.')
    expect(r.file).toBe('packages/demo/core.ts')
    expect(r.line).toBe(3)
  })

  test('an arrow const is its head up to the arrow', () => {
    expect(by('mint').text).toBe('export const mint = (a: string): string =>')
  })

  test('an interface is printed whole when short', () => {
    expect(by('GrantOptions').text).toContain('subject: string')
    expect(by('GrantOptions').kind).toBe('interface')
  })

  test('a renamed re-export is listed under the name an app imports, not the declared one', () => {
    const r = by('reexported')
    expect(r.text).toContain('function renamed')
    expect(importFrom(r)).toBe("import { reexported } from '@frontierjs/demo'")
    expect(importFrom(by('renamed'))).toBe("import { renamed } from '@frontierjs/demo/extra'")
  })

  test('a private package and an unexported declaration are absent', () => {
    expect(by('hidden')).toBeUndefined()
    expect(by('Token')).toBeUndefined()
  })

  test('--pkg narrows by short name', () => {
    expect(collectExports(ts, root, { only: 'demo' }).length).toBe(rows.length)
    expect(collectExports(ts, root, { only: 'nothing' })).toEqual([])
  })

  test('a name matches exactly, then by substring, then as a member', () => {
    expect(matchSymbol(rows, 'grant').how).toBe('exact')
    expect(matchSymbol(rows, 'MIN').rows.map(r => r.name)).toEqual(['mint'])
    const m = matchSymbol(rows, 'ttl')
    expect(m.how).toBe('member')
    expect(m.rows.map(r => r.name)).toEqual(['GrantOptions'])
    expect(matchSymbol(rows, 'nothingLikeThis').rows).toEqual([])
  })

  test('the rendered row leads with where it is and how it is imported', () => {
    const out = renderSymbol(by('grant')).split('\n')
    expect(out[0]).toBe('# grant · function · packages/demo/core.ts:3')
    expect(out[1]).toBe("# import { grant } from '@frontierjs/demo'")
    expect(out).toContain('// Grants a token.')
    rmSync(root, { recursive: true, force: true })
  })
})

describe('the real workspace', () => {
  const rows = collectExports(ts, REPO, { only: 'junction' })

  test('bearerClaim is found with its signature, at the line that holds it', () => {
    const r = rows.find(x => x.name === 'bearerClaim')
    expect(r.text).toBe('export function bearerClaim(opts: BearerClaimOptions): DescribedResolver')
    expect(r.file).toBe('packages/junction/src/core/litestone.ts')
    expect(importFrom(r)).toBe("import { bearerClaim } from '@frontierjs/junction'")
  })

  test('an interface too long to read is its members, each cut to a signature', () => {
    const r = rows.find(x => x.name === 'CallOptions')
    expect(r.kind).toBe('interface')
    expect(r.text).toContain('transport?:')
  })

  test('an option is found as a member of what declares it', () => {
    const m = matchSymbol(collectExports(ts, REPO, { only: 'auth' }), 'sessionFields')
    expect(m.how).toBe('member')
    expect(m.rows.map(r => r.name)).toContain('LitestoneAuthOptions')
  })
})

describe('fli sig', () => {
  test('answers a name from the workspace and fails on a name nothing holds', async () => {
    const { spawnSync } = await import('node:child_process')
    const fli = resolve(import.meta.dir, '../bin/fli.js')
    const ok  = spawnSync(process.execPath, [fli, 'sig', 'gateAuthAround'], { cwd: REPO, encoding: 'utf8' })
    expect(ok.stdout).toContain('export function gateAuthAround(')
    const none = spawnSync(process.execPath, [fli, 'sig', 'noSuchSymbolAnywhere'], { cwd: REPO, encoding: 'utf8' })
    expect(none.status).toBe(1)
  }, 60000)
})
