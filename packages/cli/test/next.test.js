// next.test.js — the open register, ranked.
//
// Every term is asserted as a PAIR: two rows identical but for the one term,
// so a ranking that ignored it would put them in file order and fail. The rows
// are written in the order the term must REVERSE, for the same reason.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join }          from 'path'
import { tmpdir }        from 'os'
import { fileURLToPath } from 'url'

import { rankNext, blockedBy, WEIGHTS } from '../core/next.js'

// Every fixture declares the prefix its rows are written under.
const DECLARED = JSON.stringify({ registers: { prefix: 'FJS' } })

const REPO = fileURLToPath(new URL('../../..', import.meta.url))

const row = (id, pkg, title, detail = '—') =>
  `| <a id="${id.toLowerCase()}"></a>${id} | ${pkg} | **${title}** | open | 2026-09-10 | ${detail} |`

function fixture(rows, { closed = [], decisions = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fli-next-'))
  writeFileSync(join(root, 'package.json'), DECLARED)
  mkdirSync(join(root, 'IDEAS'))
  mkdirSync(join(root, 'src'))
  for (const f of ['a.js', 'b.js', 'notes.md']) writeFileSync(join(root, 'src', f), '')

  writeFileSync(join(root, 'ISSUES.md'), [
    '## S2 — high', '',
    '| Id | Pkg | Title | Status | Verified | Detail |', '| --- | --- | --- | --- | --- | --- |',
    ...rows.filter(r => r.sev === 'S2').map(r => r.line), '',
    '## S3 — medium', '',
    '| Id | Pkg | Title | Status | Verified | Detail |', '| --- | --- | --- | --- | --- | --- |',
    ...rows.filter(r => r.sev === 'S3').map(r => r.line), '',
    '## Closed', '',
    '| Id | Title | Closed | How |', '| --- | --- | --- | --- |',
    ...closed, '',
  ].join('\n'))

  writeFileSync(join(root, 'DECISIONS.md'), ['# Decisions', '', '## Repo conventions', '', ...decisions, ''].join('\n'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const S2 = (...a) => ({ sev: 'S2', line: row(...a) })
const S3 = (...a) => ({ sev: 'S3', line: row(...a) })
const ids = list => list.map(r => r.id)

describe('the terms', () => {

  test('severity ranks first, whatever the file order', () => {
    const { root, cleanup } = fixture([S3('FJS-001', 'cli', 'Lower.'), S2('FJS-002', 'cli', 'Higher.')])
    try { expect(ids(rankNext(root, { touched: new Set() }).ready)).toEqual(['FJS-002', 'FJS-001']) }
    finally { cleanup() }
  })

  test('within a severity, a row other records cite comes first — and citing itself counts for nothing', () => {
    const { root, cleanup } = fixture([
      S3('FJS-001', 'cli', 'Cites itself, FJS-001.'),
      S3('FJS-002', 'cli', 'Cited by a ruling.'),
    ], { decisions: ['### <a id="fjs-d01"></a>2026-09-01 · `FJS-D01` — leans on FJS-002.', '', 'Body.'] })
    try {
      const out = rankNext(root, { touched: new Set() }).ready
      expect(ids(out)).toEqual(['FJS-002', 'FJS-001'])
      expect(out[0].terms.find(t => t.term === 'cited').value).toBe(WEIGHTS.citedBy)
      expect(out[1].terms.some(t => t.term === 'cited')).toBe(false)
    } finally { cleanup() }
  })

  test('a row somebody is blocked by comes first, and the blocked row leaves the ranking', () => {
    const { root, cleanup } = fixture([
      S3('FJS-001', 'cli', 'Waits.', 'blocked by FJS-003'),
      S3('FJS-002', 'cli', 'Holds nothing.'),
      S3('FJS-003', 'cli', 'Holds one up.'),
    ])
    try {
      const out = rankNext(root, { touched: new Set() })
      expect(ids(out.ready)).toEqual(['FJS-003', 'FJS-002'])
      // Scored as blocking and only as blocking — the edge also cites the row.
      expect(out.ready[0].terms.map(t => [t.term, t.value])).toEqual([['severity', 30], ['blocks', WEIGHTS.blocks]])
      expect(out.blocked.map(r => [r.id, r.blockedBy])).toEqual([['FJS-001', ['FJS-003']]])
    } finally { cleanup() }
  })

  test('a blocker that has closed blocks nothing, with no edit to the blocked row', () => {
    const { root, cleanup } = fixture(
      [S3('FJS-001', 'cli', 'Waited.', 'blocked by FJS-003')],
      { closed: ['| <a id="fjs-003"></a>FJS-003 | **Done.** | 2026-09-12 | fixed |'] },
    )
    try {
      const out = rankNext(root, { touched: new Set() })
      expect(ids(out.ready)).toEqual(['FJS-001'])
      expect(out.blocked).toEqual([])
    } finally { cleanup() }
  })

  test('a row whose code was touched recently comes first — and a touched markdown file is not code', () => {
    const { root, cleanup } = fixture([
      S3('FJS-001', 'cli', 'Links notes.', '[notes](src/notes.md)'),
      S3('FJS-002', 'cli', 'Links code.', '[a](src/a.js)'),
    ])
    try {
      const out = rankNext(root, { touched: new Set(['src/a.js', 'src/notes.md']) }).ready
      expect(ids(out)).toEqual(['FJS-002', 'FJS-001'])
      expect(out[0].terms.find(t => t.term === 'touched').note).toMatch(/src\/a\.js/)
      expect(out[1].terms.some(t => t.term === 'touched')).toBe(false)
    } finally { cleanup() }
  })

  test('the score is the sum of the terms printed beside it', () => {
    const { root, cleanup } = fixture([S2('FJS-001', 'cli', 'All of it.', '[a](src/a.js)')])
    try {
      const [r] = rankNext(root, { touched: new Set(['src/a.js']) }).ready
      expect(r.score).toBe(r.terms.reduce((n, t) => n + t.value, 0))
      expect(r.score).toBe(WEIGHTS.severity.S2 + WEIGHTS.touched)
    } finally { cleanup() }
  })

  test('--pkg narrows to rows filed against that package', () => {
    const { root, cleanup } = fixture([S2('FJS-001', 'cli', 'Cli.'), S3('FJS-002', 'mesa · cli', 'Both.'), S3('FJS-003', 'mesa', 'Mesa.')])
    try { expect(ids(rankNext(root, { pkg: 'mesa', touched: new Set() }).ready)).toEqual(['FJS-002', 'FJS-003']) }
    finally { cleanup() }
  })
})

describe('the declaration', () => {
  test('blocked by is read with or without backticks, and nothing else in prose is', () => {
    expect(blockedBy({ body: 'blocked by FJS-12 and blocked by `FJS-D7`' })).toEqual(['FJS-12', 'FJS-D7'])
    expect(blockedBy({ body: 'the header block by FJS-12 · blocks FJS-9' })).toEqual([])
  })
})

describe('over this repo', () => {
  test('the register is ranked, and every row carries its severity term', () => {
    const { ready } = rankNext(REPO)
    expect(ready.length).toBeGreaterThan(20)
    expect(ready.every(r => r.terms[0].term === 'severity')).toBe(true)
    expect(ready.every((r, i) => i === 0 || ready[i - 1].score >= r.score)).toBe(true)
  })
})
