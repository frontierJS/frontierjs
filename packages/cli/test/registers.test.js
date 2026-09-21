// registers.test.js — the three registers, read as one document.
//
// The reader behind `fli register:*`. What matters here is not the shape of the
// JSON: it is that a record which stops being matched DISAPPEARS rather than
// erroring, which is how `repo-map.js` came to render a smaller register than
// the file held. So every reader is asserted against a fixture whose contents
// are known, and then against this repo, where the assertion is structural —
// a count would fail every time somebody files an issue.
//
// Parity with `repo-map.js` gets its own test. Both read `ISSUES.md` today and
// the map is the caller that will move onto this module; two readers over one
// file that disagree is the defect this module exists to remove.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join }     from 'path'
import { tmpdir }   from 'os'
import { fileURLToPath } from 'url'

import { readRegisters, IDEA_STATUS } from '../core/registers.js'
import { collect }                    from '../core/repo-map.js'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))

// ─── a fixture whose contents are known ───────────────────────────────────────

let ROOT
let LEGACY

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'fli-registers-'))

  writeFileSync(join(ROOT, 'ISSUES.md'), [
    '# Issues',
    '',
    '## S1 — blockers',
    '',
    '| Id | Pkg | Title | Status | Verified | Detail |',
    '| --- | --- | --- | --- | --- | --- |',
    '| <a id="fjs-001"></a>FJS-001 | cli · repo | **A thing is broken.** It cites FJS-002 and [a file](packages/cli/core/x.js#L4) | open | 2026-08-01 | [x.js](packages/cli/core/x.js) |',
    '',
    '## S3 — medium',
    '',
    '| Id | Pkg | Title | Status | Verified | Detail |',
    '| --- | --- | --- | --- | --- | --- |',
    '| FJS-002 | mesa | **A smaller thing.** | stale? | 2026-08-02 | — |',
    '',
    '## Closed',
    '',
    '| Id | Pkg | Title | Status | Verified | Detail |',
    '| --- | --- | --- | --- | --- | --- |',
    '| FJS-003 | ui | **Was broken.** | closed | 2026-08-03 | — |',
    '',
  ].join('\n'))

  writeFileSync(join(ROOT, 'DECISIONS.md'), [
    '# Decisions',
    '',
    '## Naming & vocabulary',
    '',
    '### <a id="fjs-d01"></a>2026-08-16 · `FJS-D01` — the first ruling, settled',
    '',
    'Because of a reason that runs onto a second line and cites FJS-001.',
    '',
    '### <a id="fjs-d02"></a>2026-08-17 · `FJS-D02` — the second ruling',
    '',
    'Which ends where the next heading starts.',
    '',
  ].join('\n'))

  // The legacy shape a project that has not migrated still has: a bold lead
  // with no boundary, and an id one time in three.
  LEGACY = mkdtempSync(join(tmpdir(), 'fli-legacy-'))
  writeFileSync(join(LEGACY, 'DECISIONS.md'), [
    '# Decisions',
    '',
    '## Rulings',
    '',
    '**2026-08-16 · `FJS-D01` — an id before the claim.** Argued at length',
    'over two lines.',
    '',
    '**2026-08-17 · An id in a parenthetical.** (`FJS-D02`, closing `FJS-016`.)',
    '',
    '**2026-08-18 · An id on the line below.**',
    'Closes `FJS-D03`; fixes `FJS-004`.',
    '',
    '**2026-08-19 · A ruling with no id at all.** Which was most of them.',
    '',
  ].join('\n'))

  mkdirSync(join(ROOT, 'IDEAS'))
  writeFileSync(join(ROOT, 'IDEAS', 'a-paper.md'), [
    '---', 'id: a-paper', 'status: partial', 'dated: 2026-08-04', 'revised: 2026-08-15', '---',
    '',
    '# Idea — A paper about something',
    '',
    '**Status: IDEA, mostly.** It mentions [[FJS-002]].',
    '',
  ].join('\n'))
  writeFileSync(join(ROOT, 'IDEAS', 'bare.md'), '# Idea — No frontmatter here\n')
  writeFileSync(join(ROOT, 'IDEAS', 'overview.md'), [
    '---', 'id: overview', 'status: index', 'dated: 2026-08-06', '---',
    '',
    '# Ideas — the overview',
    '',
    '| 0.1 | **A paper about something** — the claim | S | ●●●● | — | T | idea | `a-paper.md` |',
    '',
  ].join('\n'))
})

afterAll(() => {
  rmSync(ROOT,   { recursive: true, force: true })
  rmSync(LEGACY, { recursive: true, force: true })
})

// ─── issues ───────────────────────────────────────────────────────────────────

describe('issues', () => {
  test('reads an anchored row and an unanchored one alike', () => {
    const { issues } = readRegisters(ROOT)
    expect(issues.map(i => i.id).sort()).toEqual(['FJS-001', 'FJS-002', 'FJS-003'])
  })

  test('severity comes from the section, closed from § Closed', () => {
    const { issues } = readRegisters(ROOT)
    const by = Object.fromEntries(issues.map(i => [i.id, i]))
    expect(by['FJS-001'].severity).toBe('S1')
    expect(by['FJS-002'].severity).toBe('S3')
    expect(by['FJS-001'].closed).toBe(false)
    expect(by['FJS-003'].closed).toBe(true)
    expect(by['FJS-003'].status).toBe('closed')
  })

  test('a package cell holding two names is two packages', () => {
    const { issues } = readRegisters(ROOT)
    expect(issues.find(i => i.id === 'FJS-001').pkg).toEqual(['cli', 'repo'])
  })

  test('refs are derived from the prose, files from its links', () => {
    const row = readRegisters(ROOT).issues.find(i => i.id === 'FJS-001')
    expect(row.refs).toContain('FJS-002')
    expect(row.files).toEqual(['packages/cli/core/x.js'])
  })

  test('the title is the first bold claim, not the whole cell', () => {
    const row = readRegisters(ROOT).issues.find(i => i.id === 'FJS-001')
    expect(row.title).toBe('A thing is broken.')
  })
})

// ─── decisions ────────────────────────────────────────────────────────────────

describe('decisions', () => {
  test('a heading is a ruling, with its id, date and section', () => {
    const { decisions } = readRegisters(ROOT)
    expect(decisions).toHaveLength(2)
    expect(decisions.map(r => r.id)).toEqual(['FJS-D01', 'FJS-D02'])
    expect(decisions[0].form).toBe('heading')
    expect(decisions[0].date).toBe('2026-08-16')
    expect(decisions[0].section).toBe('Naming & vocabulary')
    expect(decisions[0].anchor).toBe('fjs-d01')
  })

  test('a ruling in a fenced block is content, not a record', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-fence-'))
    writeFileSync(join(root, 'DECISIONS.md'), [
      '# Decisions', '',
      'The format a ruling is written in:', '',
      '```',
      '### <a id="fjs-d40"></a>2026-08-08 · `FJS-D40` — the claim',
      '```', '',
      '## Rulings', '',
      '### <a id="fjs-d01"></a>2026-08-16 · `FJS-D01` — the only real one', '',
    ].join('\n'))
    writeFileSync(join(root, 'ISSUES.md'), [
      '## S1 — blockers', '',
      'A row is written like this:', '',
      '```',
      '| <a id="fjs-900"></a>FJS-900 | cli | **An example.** | open | 2026-08-01 | — |',
      '```', '',
      '| <a id="fjs-001"></a>FJS-001 | cli | **A real one.** | open | 2026-08-01 | — |',
    ].join('\n'))

    const d = readRegisters(root)
    expect(d.decisions.map(r => r.id)).toEqual(['FJS-D01'])
    expect(d.issues.map(r => r.id)).toEqual(['FJS-001'])
    rmSync(root, { recursive: true, force: true })
  })

  test('the body runs to the next heading', () => {
    const [first] = readRegisters(ROOT).decisions
    expect(first.body).toContain('runs onto a second line')
    expect(first.body).not.toContain('where the next heading starts')
    expect(first.refs).toContain('FJS-001')
  })

  // Read for a project that has not migrated. All three id spellings were in
  // use here, and a parser that saw only the first reported four fifths of the
  // register as unnameable.
  describe('the legacy bold-lead form', () => {
    test('an id before the claim, in a parenthetical, and on the line below', () => {
      const { decisions } = readRegisters(LEGACY)
      expect(decisions.map(r => r.id)).toEqual(['FJS-D01', 'FJS-D02', 'FJS-D03', null])
      expect(decisions.every(r => r.form === 'prose')).toBe(true)
    })

    test('a ruling with no id still gets a stable anchor', () => {
      const last = readRegisters(LEGACY).decisions[3]
      expect(last.anchor).toBeTruthy()
      expect(readRegisters(LEGACY).decisions[3].anchor).toBe(last.anchor)
    })

    test('a wrapped claim is read whole', () => {
      const first = readRegisters(LEGACY).decisions[0]
      expect(first.body).toContain('over two lines')
    })
  })
})

// ─── ideas ────────────────────────────────────────────────────────────────────

describe('ideas', () => {
  test('frontmatter is read, and a paper without it still appears', () => {
    const { ideas } = readRegisters(ROOT)
    const by = Object.fromEntries(ideas.map(i => [i.id, i]))
    expect(by['a-paper'].status).toBe('partial')
    expect(by['a-paper'].revised).toBe('2026-08-15')
    expect(by['a-paper'].form).toBe('frontmatter')
    expect(by['bare'].form).toBe('heading')
    expect(by['bare'].status).toBe('')
  })

  test('the title drops the register\'s own word for the file', () => {
    const paper = readRegisters(ROOT).ideas.find(i => i.id === 'a-paper')
    expect(paper.title).toBe('A paper about something')
  })

  test('a wikilink is a ref', () => {
    const paper = readRegisters(ROOT).ideas.find(i => i.id === 'a-paper')
    expect(paper.refs).toContain('FJS-002')
  })

  test('the overview ranks the paper it cites', () => {
    const paper = readRegisters(ROOT).ideas.find(i => i.id === 'a-paper')
    expect(paper.rank).toBe('0.1')
  })
})

// ─── the id index ─────────────────────────────────────────────────────────────

describe('ids', () => {
  test('one id in two places is reported, not silently overwritten', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-dup-'))
    writeFileSync(join(root, 'ISSUES.md'), [
      '## S1 — blockers',
      '| FJS-009 | cli | **One.** | open | 2026-08-01 | — |',
      '| FJS-009 | ui | **Two.** | open | 2026-08-01 | — |',
    ].join('\n'))

    const { ids } = readRegisters(root)
    expect(ids.duplicates.map(d => d.id)).toEqual(['FJS-009'])
    rmSync(root, { recursive: true, force: true })
  })

  test('a missing register is absent, never invented', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-empty-'))
    const d = readRegisters(root)
    expect(d.issues).toEqual([])
    expect(d.decisions).toEqual([])
    expect(d.ideas).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })
})

// ─── this repo ────────────────────────────────────────────────────────────────
//
// Structural only. A count here fails the day somebody files an issue, which
// teaches everyone to edit the test rather than read it.

describe('the repo it ships with', () => {
  test('every register is non-empty', () => {
    const d = readRegisters(REPO)
    expect(d.issues.length).toBeGreaterThan(0)
    expect(d.decisions.length).toBeGreaterThan(0)
    expect(d.ideas.length).toBeGreaterThan(0)
  })

  test('every open issue carries an id, a severity and a status', () => {
    for (const row of readRegisters(REPO).issues.filter(i => !i.closed)) {
      expect(row.id).toMatch(/^FJS-D?\d+$/)
      expect(row.severity).toBeTruthy()
      expect(row.status).toBeTruthy()
    }
  })

  test('every ruling is a heading and carries an id', () => {
    for (const ruling of readRegisters(REPO).decisions) {
      expect(ruling.form).toBe('heading')
      expect(ruling.id).toMatch(/^FJS-D\d+$/)
      expect(ruling.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  test('every idea paper has been migrated to frontmatter', () => {
    for (const paper of readRegisters(REPO).ideas) {
      expect(paper.form).toBe('frontmatter')
      expect(IDEA_STATUS).toContain(paper.status)
      expect(paper.dated).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  test('it agrees with repo-map about which issues are open', () => {
    const mine  = readRegisters(REPO).issues.filter(i => !i.closed).map(i => i.id).sort()
    const model = collect({ root: REPO })
    const theirs = Object.values(model.issues.bySeverity).flat().map(r => r.id).sort()
    expect(mine).toEqual(theirs)
  })
})
