// web/test/ledger.test.js — `#ledger` over a root made here: which bench a row
// belongs to, and the file the workshop imports read back.
import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { benchesOf, checkout, count, dataFile, recount } from '../src/ledger.js'

const row = (id, pkg) => `| <a id="fjs-${id}"></a>FJS-${id} | ${pkg} | a title |`

function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'haven-ledger-'))
  for (const p of ['litestone', 'mesa', 'haven']) {
    mkdirSync(join(root, 'packages', p), { recursive: true })
    writeFileSync(join(root, 'packages', p, 'package.json'), '{}')
  }
  mkdirSync(join(root, 'packages', 'notes'))
  mkdirSync(join(root, 'packages', 'haven', 'web', 'src'), { recursive: true })
  writeFileSync(join(root, 'ISSUES.md'), [
    '# Issues', '',
    '## S2 — serious', '',
    '| ID | Pkg | Title |', '| --- | --- | --- |',
    row(1, '`litestone`, `junction`'),
    row(2, 'docs'),
    '## S3 — minor', '',
    row(3, '**mesa**'),
    row(4, 'fli'),
    row(5, 'mesa'),
    '## Closed', '',
    row(6, 'litestone'),
  ].join('\n'))
  return root
}

test('a checkout is a root with ISSUES.md; an installed Haven has none', () => {
  expect(checkout()).toBe(join(import.meta.dir, '../../../..'))
  const installed = mkdtempSync(join(tmpdir(), 'haven-installed-'))
  expect(checkout({ from: join(installed, 'a', 'b', 'c', 'd') })).toBeNull()
  rmSync(installed, { recursive: true })
})

test('a row is its first package\'s, a name that is no bench is frontierjs, fli is cli, and a closed row counts nowhere', () => {
  const root = fakeRoot()
  expect(benchesOf(root)).toEqual(['example', 'frontierjs', 'haven', 'litestone', 'mesa'])
  const c = count(root)
  expect(c.litestone).toEqual({ S1: 0, S2: 1, S3: 0, S4: 0 })
  expect(c.mesa).toEqual({ S1: 0, S2: 0, S3: 2, S4: 0 })
  expect(c.frontierjs).toEqual({ S1: 0, S2: 1, S3: 1, S4: 0 })
  rmSync(root, { recursive: true })
})

test('recount writes the file the workshop imports, and it reads back as the counts', async () => {
  const root = fakeRoot()
  const counts = recount({ root })
  const { LEDGER } = await import(dataFile(root))
  expect(LEDGER).toEqual(counts)
  expect(readFileSync(dataFile(root), 'utf8')).toStartWith('// web/src/ledger.data.js')
  rmSync(root, { recursive: true })
})
