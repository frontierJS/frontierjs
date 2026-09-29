// archive.test.js — `register:archive` trims § Closed and moves the links with it.
//
// Asserted against a project that is not this one (`ELA`, registers in
// `.project/`), and inside a real git repository, because the relink asks git
// which files the tree holds. Every result is read back through the reader
// `register:check` grades with.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join }         from 'path'
import { tmpdir }       from 'os'
import { execFileSync } from 'child_process'

import { archiveClosed }    from '../core/archive.js'
import { readRegisters }    from '../core/registers.js'

const closedRow = (n, date) =>
  `| <a id="ela-00${n}"></a>ELA-00${n} | api — **Defect ${n}** | ${date} | Fixed; see [ELA-001](#ela-001) and [ELA-00${n}](#ela-00${n}) |`

const ISSUES = [
  '# Issues',
  '',
  '## S2 — high',
  '',
  '| Id | Area | Title | Status | Verified | Detail |',
  '| --- | --- | --- | --- | --- | --- |',
  '| <a id="ela-001"></a>ELA-001 | api | **Still open, follows [ELA-003](#ela-003)** | open | 2026-09-25 | — |',
  '',
  '## Closed',
  '',
  '| Id | Title | Closed | How |',
  '| --- | --- | --- | --- |',
  closedRow(5, '2026-09-24'),
  closedRow(4, '2026-09-23'),
  closedRow(3, '2026-09-22'),
  closedRow(2, '2026-09-21'),
  '',
  '## See also',
  '',
]

const ARCHIVE = [
  '# Issues — archive',
  '',
  '1 rows · closed 2026-09-01 → 2026-09-01 · newest first.',
  '',
  '| Id | Title | Closed | How |',
  '| --- | --- | --- | --- |',
  '| <a id="ela-000"></a>ELA-000 | repo — **An older one** | 2026-09-01 | Fixed |',
  '',
]

let dirs = []
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })

function project({ archive = ARCHIVE } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fli-archive-'))
  dirs.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ela', registers: { prefix: 'ELA', dir: '.project' } }))
  mkdirSync(join(root, '.project'))
  mkdirSync(join(root, 'docs', 'deep'), { recursive: true })
  writeFileSync(join(root, '.project', 'ISSUES.md'), ISSUES.join('\n'))
  if (archive) writeFileSync(join(root, '.project', 'ISSUES_ARCHIVE.md'), archive.join('\n'))
  writeFileSync(join(root, 'docs', 'deep', 'notes.md'),
    'See [ELA-003](../../.project/ISSUES.md#ela-003), [ELA-005](../../.project/ISSUES.md#ela-005) and [other](../ISSUES.md#ela-003).\n')
  writeFileSync(join(root, 'code.js'), '// [ELA-003](.project/ISSUES.md#ela-003)\n')
  execFileSync('git', ['init', '-q'], { cwd: root })
  return root
}

const read = (root, f) => readFileSync(join(root, f), 'utf8')

describe('archiving § Closed', () => {

  test('the newest rows stay, the rest top the archive verbatim', () => {
    const root = project()
    const out  = archiveClosed({ root, keep: 2 })
    expect(out).toMatchObject({ ok: true, moved: 2, kept: 2, archived: 3 })

    const doc = readRegisters(root)
    const at  = id => doc.issues.find(r => r.id === id)
    expect(at('ELA-005').file).toBe('.project/ISSUES.md')
    expect(at('ELA-003').file).toBe('.project/ISSUES_ARCHIVE.md')
    expect(at('ELA-003').closed).toBe(true)

    const archive = read(root, '.project/ISSUES_ARCHIVE.md').split('\n')
    expect(archive[2]).toBe('3 rows · closed 2026-09-01 → 2026-09-22 · newest first.')
    expect(archive.slice(6, 9).map(l => l.match(/ELA-00\d/)[0])).toEqual(['ELA-003', 'ELA-002', 'ELA-000'])
    expect(read(root, '.project/ISSUES.md')).toContain('## See also')
  })

  test('a link to a moved anchor follows it, and one to an anchor that stayed is left', () => {
    const root = project()
    const out  = archiveClosed({ root, keep: 2 })
    expect(out.relinked).toEqual({ files: 1, links: 1 })

    const issues  = read(root, '.project/ISSUES.md')
    const archive = read(root, '.project/ISSUES_ARCHIVE.md')
    expect(issues).toContain('follows [ELA-003](ISSUES_ARCHIVE.md#ela-003)')
    expect(issues).toContain('[ELA-005](#ela-005)')
    // A moved row's link to a row that stayed now names the file it is in.
    expect(archive).toContain('see [ELA-001](ISSUES.md#ela-001) and [ELA-003](#ela-003)')

    const notes = read(root, 'docs/deep/notes.md')
    expect(notes).toContain('(../../.project/ISSUES_ARCHIVE.md#ela-003)')
    expect(notes).toContain('(../../.project/ISSUES.md#ela-005)')
    // Same spelling, a different file: it does not resolve to this register.
    expect(notes).toContain('(../ISSUES.md#ela-003)')
    expect(read(root, 'code.js')).toContain('.project/ISSUES.md#ela-003')
  })

  test('nothing past the limit is a success that writes nothing', () => {
    const root   = project()
    const before = read(root, '.project/ISSUES.md')
    expect(archiveClosed({ root })).toMatchObject({ ok: true, moved: 0, kept: 4 })
    expect(read(root, '.project/ISSUES.md')).toBe(before)
  })

  test('a project with no archive yet gets one', () => {
    const root = project({ archive: null })
    expect(archiveClosed({ root, keep: 3 })).toMatchObject({ ok: true, moved: 1, archived: 1 })
    expect(existsSync(join(root, '.project', 'ISSUES_ARCHIVE.md'))).toBe(true)
    expect(read(root, '.project/ISSUES_ARCHIVE.md')).toContain('1 rows · closed 2026-09-21 → 2026-09-21')
  })

  test('refuses a keep that is not a count', () => {
    expect(archiveClosed({ root: project(), keep: -1 }).ok).toBe(false)
  })
})
