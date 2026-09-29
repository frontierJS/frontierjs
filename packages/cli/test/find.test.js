// find.test.js — `register:find` answers ids and titles, open first, never bodies.
//
// Asserted against a project that is not this one (`ELA`, registers in
// `.project/`), the same fixture shape as close.test.js, with a closed row, an
// archived row and a ruling so every file the search claims to read is read.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join }   from 'path'
import { tmpdir } from 'os'

import { findRows } from '../core/find.js'

const ISSUES = [
  '# Issues',
  '',
  '## S2 — high',
  '',
  '| Id | Area | Title | Status | Verified | Detail |',
  '| --- | --- | --- | --- | --- | --- |',
  '| <a id="ela-003"></a>ELA-003 | api | **Inbound skips hooks** | open | 2026-09-25 | the STOP keyword path |',
  '| <a id="ela-002"></a>ELA-002 | api | **STOP throws on a texted reply** | open | 2026-09-25 | `handleKeywords` patches two fields |',
  '',
  '## Closed',
  '',
  '| Id | Title | Closed | How |',
  '| --- | --- | --- | --- |',
  '| <a id="ela-001"></a>ELA-001 | api — **STOP was ignored** | 2026-09-01 | Fixed |',
  '',
]

const ARCHIVE = [
  '# Archive',
  '',
  '| Id | Title | Closed | How |',
  '| --- | --- | --- | --- |',
  '| <a id="ela-000"></a>ELA-000 | web — **STOP button missing** | 2026-08-01 | Fixed |',
  '',
]

const DECISIONS = [
  '# Decisions',
  '',
  '## Texting',
  '',
  '### <a id="ela-d01"></a>2026-09-02 · `ELA-D01` — A STOP reply unsubscribes from every list',
  '',
  'Body.',
  '',
]

let dirs = []
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })

function project({ declared = { prefix: 'ELA', dir: '.project' } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fli-find-'))
  dirs.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ela', registers: declared }))
  mkdirSync(join(root, '.project'))
  writeFileSync(join(root, '.project', 'ISSUES.md'), ISSUES.join('\n'))
  writeFileSync(join(root, '.project', 'ISSUES_ARCHIVE.md'), ARCHIVE.join('\n'))
  writeFileSync(join(root, '.project', 'DECISIONS.md'), DECISIONS.join('\n'))
  return root
}

describe('searching', () => {

  test('title hits first — open, then ruling, then closed and archived — and a body-only hit last', () => {
    const out = findRows({ root: project(), terms: 'stop' })
    expect(out.ok).toBe(true)
    expect(out.hits.map(h => [h.id, h.where])).toEqual([
      ['ELA-002', 'title'],
      ['ELA-D01', 'title'],
      ['ELA-001', 'title'],
      ['ELA-000', 'title'],
      ['ELA-003', 'body'],
    ])
  })

  test('every term must hold, case-folded, and an area counts as a term', () => {
    const out = findRows({ root: project(), terms: 'WEB stop' })
    expect(out.hits.map(h => h.id)).toEqual(['ELA-000'])
  })

  test('an id finds its row, with where to read it', () => {
    const [hit] = findRows({ root: project(), terms: 'ela-002' }).hits
    expect(hit).toMatchObject({ id: 'ELA-002', status: 'open', severity: 'S2', area: 'api', file: '.project/ISSUES.md', line: 8 })
  })

  test('a hit carries the title, never the body', () => {
    const [hit] = findRows({ root: project(), terms: 'handleKeywords' }).hits
    expect(hit.title).toBe('STOP throws on a texted reply')
    expect(JSON.stringify(hit)).not.toContain('patches')
  })

  test('the limit cuts the list and total still counts every hit', () => {
    const out = findRows({ root: project(), terms: 'stop', limit: 2 })
    expect(out.hits).toHaveLength(2)
    expect(out.total).toBe(5)
  })

  test('a closed row states no severity', () => {
    const [hit] = findRows({ root: project(), terms: 'ELA-001' }).hits
    expect(hit.status).toBe('closed')
    expect(hit.severity).toBeNull()
  })

})

describe('what it refuses', () => {

  test('no terms', () => {
    expect(findRows({ root: project(), terms: '  ' }).reason).toMatch(/at least one term/)
  })

  test('no declared prefix', () => {
    expect(findRows({ root: project({ declared: { dir: '.project' } }), terms: 'stop' }).reason).toMatch(/registers\.prefix/)
  })

})
