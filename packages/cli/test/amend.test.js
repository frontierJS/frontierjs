// amend.test.js — `register:amend` appends to a row, and refuses what it cannot.
//
// Asserted against a project that is not this one (`ELA`, registers in
// `.project/`), the same fixture as close.test.js. Every success is read back
// through the reader `register:check` grades with, so a row written in a shape
// the reader does not take fails here rather than passing as text.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join }   from 'path'
import { tmpdir } from 'os'

import { amendIssue }       from '../core/amend.js'
import { readRegisters }    from '../core/registers.js'
import { runRegisterCheck } from '../core/register-check.js'

const TODAY = new Date('2026-09-29T12:00:00Z')

const ISSUES = [
  '# Issues',
  '',
  '## S2 — high',
  '',
  '| Id | Area | Title | Status | Verified | Detail |',
  '| --- | --- | --- | --- | --- | --- |',
  '| <a id="ela-001"></a>ELA-001 | api | **STOP throws** | open | 2026-09-25 | `handleKeywords` patches two fields · [texts](../api/texts.js) |',
  '| <a id="ela-002"></a>ELA-002 | api | **Inbound skips hooks** | open | 2026-09-25 | — |',
  '',
  '## Needs a decision',
  '',
  '| Id | Area | Question | Detail |',
  '| --- | --- | --- | --- |',
  '| <a id="ela-d01"></a>ELA-D01 | api | **Does STOP unsubscribe every list?** | Found fixing ELA-001 |',
  '',
  '## Closed',
  '',
  '| Id | Title | Closed | How |',
  '| --- | --- | --- | --- |',
  '| <a id="ela-000"></a>ELA-000 | repo — **An older one** | 2026-09-01 | Fixed |',
  '',
]

let dirs = []
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })

function project({ declared = { prefix: 'ELA', dir: '.project' } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fli-amend-'))
  dirs.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ela', registers: declared }))
  mkdirSync(join(root, 'api'))
  writeFileSync(join(root, 'api', 'texts.js'), '')
  mkdirSync(join(root, '.project'))
  writeFileSync(join(root, '.project', 'ISSUES.md'), ISSUES.join('\n'))
  return root
}

const file = root => readFileSync(join(root, '.project', 'ISSUES.md'), 'utf8')
const row  = (root, id) => file(root).split('\n').find(l => l.includes(`</a>${id} `))

describe('amending a row', () => {

  test('the detail is appended after the register separator and Verified is today', () => {
    const root = project()
    const out  = amendIssue({ root, id: 'ELA-001', detail: 'Seen again from the web form', today: TODAY })
    expect(out).toEqual({ ok: true, id: 'ELA-001', file: '.project/ISSUES.md', line: 7 })
    expect(row(root, 'ELA-001')).toBe('| <a id="ela-001"></a>ELA-001 | api | **STOP throws** | open | 2026-09-29 | `handleKeywords` patches two fields · [texts](../api/texts.js) · Seen again from the web form |')

    const rec = readRegisters(root).issues.find(r => r.id === 'ELA-001')
    expect(rec.verified).toBe('2026-09-29')
    expect(rec.columns).toBe(6)
    expect(runRegisterCheck({ root, staleDays: 0 }).errors).toEqual([])
  })

  test('an empty Detail is replaced rather than joined to its dash', () => {
    const root = project()
    amendIssue({ root, id: 'ela-002', detail: 'Measured in hooks.test.js', today: TODAY })
    expect(row(root, 'ELA-002')).toEndWith('| 2026-09-29 | Measured in hooks.test.js |')
  })

  test('a question row takes the append alone — it has no Verified column', () => {
    const root = project()
    amendIssue({ root, id: 'ELA-D01', detail: 'also blocks ELA-002', today: TODAY })
    expect(row(root, 'ELA-D01')).toBe('| <a id="ela-d01"></a>ELA-D01 | api | **Does STOP unsubscribe every list?** | Found fixing ELA-001 · also blocks ELA-002 |')
  })

  test('a pipe in the detail is escaped, so the cell stays one cell', () => {
    const root = project()
    amendIssue({ root, id: 'ELA-001', detail: 'ran `a | b`\nand it held', today: TODAY })
    expect(readRegisters(root).issues.find(r => r.id === 'ELA-001').columns).toBe(6)
    expect(file(root)).toContain('ran `a \\| b` and it held')
  })

})

describe('what it refuses', () => {

  test('an id no row holds', () => {
    expect(amendIssue({ root: project(), id: 'ELA-404', detail: 'x', today: TODAY }))
      .toEqual({ ok: false, reason: 'no issue row has the id ELA-404' })
  })

  test('a closed row, and the file is untouched', () => {
    const root = project()
    const out  = amendIssue({ root, id: 'ELA-000', detail: 'x', today: TODAY })
    expect(out.reason).toMatch(/is closed .* fli file/)
    expect(file(root)).toBe(ISSUES.join('\n'))
  })

  test('no detail', () => {
    const root = project()
    expect(amendIssue({ root, id: 'ELA-001', detail: '  ', today: TODAY }).reason).toMatch(/--detail is required/)
    expect(file(root)).toBe(ISSUES.join('\n'))
  })

  test('no declared prefix', () => {
    const root = project({ declared: { dir: '.project' } })
    expect(amendIssue({ root, id: 'ELA-001', detail: 'x', today: TODAY }).reason).toMatch(/registers\.prefix/)
  })

  test('an amend the check disagrees with is put back', () => {
    const root = project()
    const out  = amendIssue({ root, id: 'ELA-001', detail: 'duplicates ELA-999', today: TODAY })
    expect(out.ok).toBe(false)
    expect(out.reason).toMatch(/put back.*unknown-ref/)
    expect(file(root)).toBe(ISSUES.join('\n'))
  })

})
