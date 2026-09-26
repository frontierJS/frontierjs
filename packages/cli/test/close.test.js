// close.test.js — `register:close` moves a row, and refuses what it cannot.
//
// Asserted against a project that is not this one (`ELA`, registers in
// `.project/`), because the writer is only worth having where the prefix and the
// folder are both declared rather than assumed. Every success is read back
// through the same reader `register:check` grades with, so a row written in a
// shape the reader does not take fails here rather than passing as text.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join }   from 'path'
import { tmpdir } from 'os'

import { closeIssue }       from '../core/close.js'
import { readRegisters }    from '../core/registers.js'
import { runRegisterCheck } from '../core/register-check.js'

const TODAY = new Date('2026-09-25T12:00:00')

const ISSUES = [
  '# Issues',
  '',
  '## S2 — high',
  '',
  '| Id | Area | Title | Status | Verified | Detail |',
  '| --- | --- | --- | --- | --- | --- |',
  '| <a id="ela-001"></a>ELA-001 | api | **STOP throws** | open | 2026-09-25 | `handleKeywords` patches two fields · [texts](../api/texts.js) · [texting](IDEAS/texting.md) |',
  '| <a id="ela-002"></a>ELA-002 | api | **Inbound skips hooks** | open | 2026-09-25 | — |',
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

function project({ issues = ISSUES, declared = { prefix: 'ELA', dir: '.project' } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fli-close-'))
  dirs.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ela', registers: declared }))
  mkdirSync(join(root, 'api'))
  writeFileSync(join(root, 'api', 'texts.js'), '')
  mkdirSync(join(root, '.project', 'IDEAS'), { recursive: true })
  writeFileSync(join(root, '.project', 'IDEAS', 'texting.md'), '---\nid: texting\nstatus: proposed\n---\n\n# Idea — Texting\n')
  writeFileSync(join(root, '.project', 'ISSUES.md'), issues.join('\n'))
  return root
}

const file = root => readFileSync(join(root, '.project', 'ISSUES.md'), 'utf8')

describe('closing a row', () => {

  test('the row leaves its table and tops § Closed, read back as closed', () => {
    const root = project()
    const out  = closeIssue({ root, id: 'ELA-001', how: 'Uncommented the fields; texted STOP and read the row back', today: TODAY })
    expect(out.ok).toBe(true)

    const doc = readRegisters(root)
    const row = doc.issues.find(r => r.id === 'ELA-001')
    expect(row.closed).toBe(true)
    expect(doc.issues.filter(r => !r.closed).map(r => r.id)).toEqual(['ELA-002'])

    const closedRows = file(root).split('\n').filter(l => l.startsWith('| <a'))
    expect(closedRows[1]).toStartWith('| <a id="ela-001"></a>ELA-001 | api — **STOP throws** | 2026-09-25 |')
    expect(closedRows[2]).toContain('ELA-000')
    expect(runRegisterCheck({ root, staleDays: 0 }).errors).toEqual([])
  })

  test('the Detail cell\'s links follow the reason, and its prose does not', () => {
    const root = project()
    closeIssue({ root, id: 'ELA-001', how: 'Fixed', today: TODAY })
    const row = file(root).split('\n').find(l => l.includes('ELA-001'))
    expect(row).toEndWith('| Fixed · [texts](../api/texts.js) · [texting](IDEAS/texting.md) |')
    expect(row).not.toContain('handleKeywords')
  })

  test('a pipe in the reason is escaped, and a newline folded, so the cell stays one cell', () => {
    const root = project()
    closeIssue({ root, id: 'ela-002', how: 'ran `a | b`\nand it held', today: TODAY })
    const row = readRegisters(root).issues.find(r => r.id === 'ELA-002')
    expect(row.closed).toBe(true)
    expect(row.columns).toBe(4)
    expect(file(root)).toContain('ran `a \\| b` and it held')
  })

})

describe('what it refuses', () => {

  test('an id no row holds', () => {
    const out = closeIssue({ root: project(), id: 'ELA-404', how: 'x', today: TODAY })
    expect(out).toEqual({ ok: false, reason: 'no issue row has the id ELA-404' })
  })

  test('an id already closed, and the file is untouched', () => {
    const root = project()
    const out  = closeIssue({ root, id: 'ELA-000', how: 'x', today: TODAY })
    expect(out.ok).toBe(false)
    expect(out.reason).toMatch(/already closed/)
    expect(file(root)).toBe(ISSUES.join('\n'))
  })

  test('no reason', () => {
    const root = project()
    expect(closeIssue({ root, id: 'ELA-001', how: '  ', today: TODAY }).reason).toMatch(/--how is required/)
    expect(file(root)).toBe(ISSUES.join('\n'))
  })

  test('a register with no § Closed table, and the row is not lost', () => {
    const root = project({ issues: ISSUES.slice(0, 9) })
    const out  = closeIssue({ root, id: 'ELA-001', how: 'x', today: TODAY })
    expect(out.reason).toMatch(/no § Closed table/)
    expect(file(root)).toContain('ELA-001')
  })

  test('no declared prefix', () => {
    const root = project({ declared: { dir: '.project' } })
    expect(closeIssue({ root, id: 'ELA-001', how: 'x', today: TODAY }).reason).toMatch(/registers\.prefix/)
  })

  test('a close the check disagrees with is put back', () => {
    // A citation to an id nothing holds is an error the check makes on the
    // closed row, so the write must not stand.
    const root = project()
    const out  = closeIssue({ root, id: 'ELA-001', how: 'superseded by ELA-999', today: TODAY })
    expect(out.ok).toBe(false)
    expect(out.reason).toMatch(/put back.*unknown-ref/)
    expect(file(root)).toBe(ISSUES.join('\n'))
  })

})
