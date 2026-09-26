// file.test.js — `register:file` writes a row the reader takes, and refuses what it cannot.
//
// Asserted against a project that is not this one (`ELA`, registers in
// `.project/`), as `close.test.js` is. Every success is read back through the
// reader `register:check` grades with, so a row in a shape the reader does not
// take fails here rather than passing as text.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join }   from 'path'
import { tmpdir } from 'os'

import { fileIssue }        from '../core/file.js'
import { readRegisters }    from '../core/registers.js'
import { runRegisterCheck } from '../core/register-check.js'

const TODAY = new Date('2026-09-26T12:00:00Z')

const ISSUES = [
  '# Issues',
  '',
  '## S2 — high',
  '',
  '| Id | Area | Title | Status | Verified | Detail |',
  '| --- | --- | --- | --- | --- | --- |',
  '| <a id="ela-002"></a>ELA-002 | api | **Inbound skips hooks** | open | 2026-09-25 | — |',
  '',
  '## S3 — medium',
  '',
  '| Id | Area | Title | Status | Verified | Detail |',
  '| --- | --- | --- | --- | --- | --- |',
  '',
  '## Closed',
  '',
  '| Id | Title | Closed | How |',
  '| --- | --- | --- | --- |',
  '| <a id="ela-007"></a>ELA-007 | repo — **An older one** | 2026-09-01 | Fixed |',
  '',
]

let dirs = []
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })

function project(issues = ISSUES) {
  const root = mkdtempSync(join(tmpdir(), 'fli-file-'))
  dirs.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ela', registers: { prefix: 'ELA', dir: '.project' } }))
  mkdirSync(join(root, '.project'), { recursive: true })
  writeFileSync(join(root, '.project', 'ISSUES.md'), issues.join('\n'))
  return root
}

const file  = root => readFileSync(join(root, '.project', 'ISSUES.md'), 'utf8')
const input = { severity: 'S3', area: 'api', title: 'A retry sends twice', detail: 'Measured by hand', today: TODAY }

describe('filing a row', () => {
  test('the id is one past the highest anywhere, § Closed included, at the project\'s width', () => {
    const root = project()
    const out  = fileIssue({ root, ...input })
    expect(out).toMatchObject({ ok: true, id: 'ELA-008' })

    const row = readRegisters(root).issues.find(r => r.id === 'ELA-008')
    expect(row).toMatchObject({ severity: 'S3', status: 'open', verified: '2026-09-26', closed: false })
    expect(row.title).toBe('A retry sends twice')
    expect(runRegisterCheck({ root }).errors).toEqual([])
  })

  test('the row tops its severity\'s table', () => {
    const root  = project()
    fileIssue({ root, ...input, severity: 's2' })
    const lines = file(root).split('\n')
    expect(lines[6]).toStartWith('| <a id="ela-008"></a>ELA-008 | api | **A retry sends twice** | open |')
    expect(lines[7]).toStartWith('| <a id="ela-002"></a>ELA-002')
  })

  test('a pipe in a sentence is escaped rather than ending the cell', () => {
    const root = project()
    fileIssue({ root, ...input, detail: 'a || b' })
    expect(file(root)).toContain('a \\|\\| b')
    expect(runRegisterCheck({ root }).errors).toEqual([])
  })

  test('refuses an unknown severity, a missing cell, and a severity with no table', () => {
    const root = project()
    expect(fileIssue({ root, ...input, severity: 'S9' }).reason).toContain('S1, S2, S3, S4')
    expect(fileIssue({ root, ...input, title: '  ' }).reason).toBe('--title is required')
    expect(fileIssue({ root, ...input, severity: 'S1' }).reason).toContain('no `## S1` table')
    expect(file(root)).toBe(ISSUES.join('\n'))
  })
})
