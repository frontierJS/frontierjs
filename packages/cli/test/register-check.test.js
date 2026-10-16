// register-check.test.js — the registers, graded.
//
// Every rule gets a fixture that triggers it and a fixture that must not. The
// second half is the one that matters: a register check that over-fires is
// worse than one nobody wrote, because the backlog it prints teaches everyone
// to skip the phase. Three exemptions are asserted for exactly that reason —
// a closed row's stale link, a ruling and the question that asked for it
// sharing an id, and a paper that has not been migrated yet.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join }   from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

import { runRegisterCheck, formatRegisterCheck, RULES } from '../core/register-check.js'

// Every fixture declares the prefix its rows are written under.
const DECLARED = JSON.stringify({ registers: { prefix: 'FJS' } })

const REPO  = fileURLToPath(new URL('../../..', import.meta.url))
const TODAY = new Date('2026-08-18T00:00:00Z')

let ROOT

const rules = (result) => result.findings.map(f => f.rule)
const of    = (result, rule) => result.findings.filter(f => f.rule === rule)

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'fli-regcheck-'))
  writeFileSync(join(ROOT, 'package.json'), DECLARED)
  mkdirSync(join(ROOT, 'IDEAS'))
  mkdirSync(join(ROOT, 'src'), { recursive: true })
  writeFileSync(join(ROOT, 'src', 'real.js'), '// a file that is really there\n')

  writeFileSync(join(ROOT, 'ISSUES.md'), [
    '## S1 — blockers',
    '| Id | Pkg | Title | Status | Verified | Detail |',
    '| --- | --- | --- | --- | --- | --- |',
    '| <a id="fjs-001"></a>FJS-001 | cli | **Fine.** cites FJS-002 | open | 2026-08-17 | [ok](src/real.js) |',
    '| <a id="fjs-002"></a>FJS-002 | cli | **Also fine.** | open | 2026-08-17 | — |',
    '| <a id="fjs-010"></a>FJS-010 | cli | **Bad status.** | partly fixed | 2026-08-17 | — |',
    '| <a id="fjs-011"></a>FJS-011 | cli | **Bad date.** | open | last tuesday | — |',
    '| <a id="fjs-012"></a>FJS-012 | cli | **Dangling.** cites FJS-999 | open | 2026-08-17 | — |',
    '| <a id="fjs-013"></a>FJS-013 | cli | **Dead link.** | open | 2026-08-17 | [x](src/gone.js) |',
    '| FJS-014 | cli | **No anchor.** | open | 2026-08-17 | — |',
    '| <a id="fjs-015"></a>FJS-015 | cli | **Old.** | open | 2026-01-01 | — |',
    '| <a id="fjs-020"></a>FJS-020 | cli | **Reused id, first.** | open | 2026-08-17 | — |',
    '| <a id="fjs-020"></a>FJS-020 | ui | **Reused id, second.** | open | 2026-08-17 | — |',
    '| <a id="fjs-021"></a>FJS-021 | cli | **Done, and still here.** | closed | 2026-08-17 | — |',
    // Three shapes that do not line up with the header above them, and two that
    // do. The header is the declaration; a row is graded against it and never
    // against a count written into the rule.
    '| <a id="fjs-030"></a>FJS-030 | cli | **One cell too many.** | open | 2026-08-17 | — | dropped when rendered |',
    '| <a id="fjs-031"></a>FJS-031 | cli | **Too narrow to reach its date.** | open |',
    '| <a id="fjs-032"></a>FJS-032 | cli — **A closed-shaped row in an open table.** | 2026-08-17 | how it was fixed |',
    '| <a id="fjs-033"></a>FJS-033 | cli | **An escaped \\| pipe is not a cell.** | open | 2026-08-17 | — |',
    '| <a id="fjs-034"></a>FJS-034 | cli | **A blank date is a state, not a shape.** | open | — | — |',
    // The env segment: a cause outside the table is an error, a title that
    // smells with no segment is a warning, and a listed cause is neither.
    '| <a id="fjs-040"></a>FJS-040 | cli | **Drive fails after the last one.** | open | 2026-08-17 | [d](src/real.js) · env: bogus |',
    '| <a id="fjs-041"></a>FJS-041 | cli | **verify:x hangs: an evaluate times out after 30 s.** | open | 2026-08-17 | [d](src/real.js) |',
    '| <a id="fjs-042"></a>FJS-042 | cli | **verify:y times out waiting for the row.** | open | 2026-08-17 | [d](src/real.js) · env: timing |',
    '',
    '## Decisions awaiting a ruling',
    '| Id | Pkg | Question | Detail |',
    '| --- | --- | --- | --- |',
    '| FJS-D01 | cli | **Should the thing be a thing?** | — |',
    // The negative control for `cross-register-id`: an open question whose id
    // names no ruling is the ordinary state of every unanswered one.
    '| <a id="fjs-d02"></a>FJS-D02 | cli | **Should the other thing be a thing?** | — |',
    '',
    '## Closed',
    '| Id | Pkg | Title | Status | Verified | Detail |',
    '| --- | --- | --- | --- | --- | --- |',
    '| FJS-003 | cli | **Was broken.** | closed | 2026-08-01 | [gone](src/renamed-by-the-fix.js) |',
    '',
  ].join('\n'))

  writeFileSync(join(ROOT, 'DECISIONS.md'), [
    '# Decisions',
    '',
    '## Rulings',
    '',
    '**2026-08-16 · `FJS-D01` — the thing is a thing.** Settled.',
    '',
    '**2026-08-17 · A ruling nobody named.** Also settled, unaddressably.',
    '',
    // A ruling in force says nothing, which is the state of nearly every one and
    // the reason absence is not graded. The three below are the written cases.
    '### <a id="fjs-d03"></a>2026-08-18 · `FJS-D03` — in force, and silent about it.',
    'It says nothing, because being here is the statement.',
    '',
    '### <a id="fjs-d04"></a>2026-08-18 · `FJS-D04` — retired, and it names what replaced it.',
    '**Status:** superseded-by [`FJS-D03`](#fjs-d03)',
    '',
    '### <a id="fjs-d05"></a>2026-08-18 · `FJS-D05` — retired, and it names nothing.',
    '**Status:** superseded-by',
    '',
    '### <a id="fjs-d06"></a>2026-08-18 · `FJS-D06` — a word nobody declared.',
    '**Status:** parked',
    '',
    '### <a id="fjs-d07"></a>2026-08-18 · `FJS-D07` — taken back, and nothing replaced it.',
    '**Status:** withdrawn 2026-08-18 — the thing it escalated is gone.',
    '',
  ].join('\n'))

  writeFileSync(join(ROOT, 'IDEAS', 'good.md'), [
    '---', 'id: good', 'status: proposed', 'dated: 2026-08-04', '---', '',
    '# Idea — A well-formed paper', '',
    'It links [the register](../ISSUES.md) and [a file](src/real.js).', '',
  ].join('\n'))

  writeFileSync(join(ROOT, 'IDEAS', 'wrong.md'), [
    '---', 'id: wrong', 'status: percolating', 'dated: 4th of August', '---', '',
    '# Idea — A paper with values nobody declared', '',
  ].join('\n'))

  writeFileSync(join(ROOT, 'IDEAS', 'unmigrated.md'), '# Idea — No frontmatter at all\n')
})

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

// ─── the rules that fire ──────────────────────────────────────────────────────

describe('errors', () => {
  test('an id reused for two records of one kind', () => {
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'duplicate-id')
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe('FJS-020')
    expect(hits[0].detail).toContain('also at')
  })

  test('a citation pointing at nothing', () => {
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'unknown-ref')
    expect(hits.map(h => h.id)).toEqual(['FJS-012'])
    expect(hits[0].message).toContain('FJS-999')
  })

  test('a link to a file that is not there', () => {
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'dead-link')
    expect(hits.map(h => h.id)).toEqual(['FJS-013'])
  })

  test('a status and a date outside the vocabulary', () => {
    const result = runRegisterCheck({ root: ROOT, today: TODAY })
    expect(of(result, 'unknown-status').map(h => h.id).sort()).toEqual(['FJS-010', 'wrong'])
    expect(of(result, 'malformed-date').map(h => h.id).sort()).toEqual(['FJS-011', 'wrong'])
  })

  test('a closed row still sitting in an open section', () => {
    // The direction the register goes wrong that nothing was watching: the row
    // is correct and it is in the wrong place, so every count above it reads it
    // as work still to do. Sixteen had accumulated in this repo's own register
    // when the rule was written, one of them the only S1.
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'closed-in-open')
    expect(hits.map(h => h.id)).toEqual(['FJS-021'])
    expect(hits[0].message).toContain('§ Closed')
    expect(hits[0].message).toContain('S1')
  })

  test('a row under § Closed is not reported by it', () => {
    // `closed` is in ISSUE_STATUS because the reader SYNTHESIZES it for every
    // row down there — which is exactly what made it silently legal in an open
    // section. A rule that fired on both would be unfixable.
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'closed-in-open')
    expect(hits.some(h => h.id === 'FJS-003')).toBe(false)
  })

  test('a bad status is still a bad status, and a different rule', () => {
    const result = runRegisterCheck({ root: ROOT, today: TODAY })
    expect(of(result, 'unknown-status').some(h => h.id === 'FJS-021')).toBe(false)
    expect(of(result, 'closed-in-open').some(h => h.id === 'FJS-010')).toBe(false)
  })

  test('a row that does not line up with its table, in both directions', () => {
    // Two failures, one rule, because both are *the row disagrees with its
    // header* and both are silent. Wider: markdown DROPS every cell past the
    // header's width, which in this repo's § Closed took the citations off 137
    // rows while they sat in the file. Narrower or misplaced: the reader infers
    // a row's shape from its cell COUNT, so a four-cell row in a six-column
    // table was read as a decision-shaped one and given a status nobody wrote —
    // which is what let four closed rows sit in § S3 where `closed-in-open`
    // could not see them, and two open rows sit in § Closed uncounted.
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'row-shape')
    expect(hits.map(h => h.id).sort()).toEqual(['FJS-030', 'FJS-031', 'FJS-032'])

    const wide = hits.find(h => h.id === 'FJS-030')
    expect(wide.message).toContain('7 cells where its table declares 6')
    expect(wide.detail).toContain('dropped when the file is rendered')

    // Narrower is the other failure and gets the other remedy — the row came
    // from a different table, so it moves rather than being rewritten.
    expect(hits.find(h => h.id === 'FJS-031').detail).toContain('another table')
    expect(hits.find(h => h.id === 'FJS-032').detail).toContain('column 5 should hold the date')
  })

  test('an escaped pipe, a blank date and a BAD date are not shape problems', () => {
    // Three negative controls, and the third is the one that shaped the rule.
    // `\\|` is prose and splits nothing. A blank date is a legitimate state — a
    // row filed before anybody ran it. And a date cell reading "last tuesday"
    // is a bad VALUE in the right column, which `malformed-date` already owns:
    // grading it here would report one mistake twice and point at the wrong fix.
    const result = runRegisterCheck({ root: ROOT, today: TODAY })
    const ids    = of(result, 'row-shape').map(h => h.id)
    expect(ids).not.toContain('FJS-033')
    expect(ids).not.toContain('FJS-034')
    expect(ids).not.toContain('FJS-011')
    expect(of(result, 'malformed-date').map(h => h.id)).toContain('FJS-011')
  })

  test('every error is leveled as one', () => {
    for (const f of runRegisterCheck({ root: ROOT, today: TODAY }).errors) {
      expect(RULES.find(r => r.id === f.rule).level).toBe('error')
    }
  })
})

describe('warnings', () => {
  test('a ruling with no id', () => {
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'unnamed-ruling')
    expect(hits).toHaveLength(1)
    expect(hits[0].message).toContain('A ruling nobody named')
  })

  test('an open row with no anchor — a decision question included', () => {
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'missing-anchor')
    // The `FJS-D01` row is graded too: a ruling has to be able to link back to
    // the question it answers, which is the whole use for the anchor.
    expect(hits.map(h => h.id).sort()).toEqual(['FJS-014', 'FJS-D01'])
  })

  test('a row nobody has re-checked, against an injected clock', () => {
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'stale-verified')
    expect(hits.map(h => h.id)).toEqual(['FJS-015'])
  })

  test('env: a cause outside the table errors, a smelling title with no segment warns, a listed cause is silent', () => {
    const result = runRegisterCheck({ root: ROOT, staleDays: 0, today: TODAY })
    expect(of(result, 'env-cause').map(h => h.id)).toEqual(['FJS-040'])
    expect(of(result, 'env-smell').map(h => h.id)).toEqual(['FJS-041'])
    expect(result.findings.filter(f => f.id === 'FJS-042' && f.rule.startsWith('env-'))).toHaveLength(0)
  })

  test('staleDays 0 turns the clock rule off, so the answer is reproducible', () => {
    const result = runRegisterCheck({ root: ROOT, staleDays: 0, today: TODAY })
    expect(of(result, 'stale-verified')).toHaveLength(0)
  })
})

// ─── the rules that must NOT fire ─────────────────────────────────────────────

describe('exemptions', () => {
  test('a closed row\'s link to a file the fix renamed is not dead', () => {
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'dead-link')
    expect(hits.some(h => h.id === 'FJS-003')).toBe(false)
  })

  test('a ruling and the question that asked for it may share an id', () => {
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'duplicate-id')
    expect(hits.some(h => h.id === 'FJS-D01')).toBe(false)
  })

  // Sharing the id is legal; the question still being OPEN once the ruling
  // exists is not. The pair is the rule: `duplicate-id` must stay silent on
  // exactly the row `cross-register-id` reports, or the two are one rule
  // written twice.
  test('an open question whose id already names a ruling is reported', () => {
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'cross-register-id')
    expect(hits.map(h => h.id)).toEqual(['FJS-D01'])
    expect(hits[0].detail).toContain('reissue')
  })

  test('an open question with no ruling of its own is not', () => {
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'cross-register-id')
    expect(hits.some(h => h.id === 'FJS-D02')).toBe(false)
  })

  // Absence is the answer for nearly every ruling, so it is the half that must
  // stay silent — a rule firing on it would print 180 findings and be removed.
  test('a ruling in force declares nothing and is not reported', () => {
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'ruling-status')
    expect(hits.some(h => h.id === 'FJS-D03')).toBe(false)
  })

  test('a status word outside the vocabulary is', () => {
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'ruling-status')
    const hit  = hits.find(h => h.id === 'FJS-D06')
    expect(hit).toBeDefined()
    expect(hit.message).toContain('parked')
  })

  test('a retirement that names nothing is, and one that names a ruling is not', () => {
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'ruling-status')
    expect(hits.map(h => h.id).sort()).toEqual(['FJS-D05', 'FJS-D06'])
  })

  // `withdrawn` names no successor BECAUSE there is none, which is the content
  // rather than an omission. Paired with FJS-D05 above, where the same absence
  // under `superseded-by` is the finding.
  test('withdrawn names no successor and that is not a finding', () => {
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'ruling-status')
    expect(hits.some(h => h.id === 'FJS-D07')).toBe(false)
  })

  // Ordering is a claim about which ruling is current, so both halves are the
  // rule: the section that runs newest-first must stay silent, and only the
  // ruling that should move up is named.
  test('a section out of date order is reported against the later ruling', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-order-'))
    writeFileSync(join(root, 'package.json'), DECLARED)
    writeFileSync(join(root, 'DECISIONS.md'), [
      '# Decisions', '', '## Rulings', '',
      '### <a id="fjs-d01"></a>2026-08-10 · `FJS-D01` — the older one, on top.',
      'Body.', '',
      '### <a id="fjs-d02"></a>2026-08-20 · `FJS-D02` — the newer one, below it.',
      'Body.', '',
    ].join('\n'))
    const hits = of(runRegisterCheck({ root, today: TODAY }), 'ruling-order')
    expect(hits.map(h => h.id)).toEqual(['FJS-D02'])
    expect(hits[0].message).toContain('2026-08-10')
    rmSync(root, { recursive: true, force: true })
  })

  test('newest first is not, and neither are two rulings of one date', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-order-ok-'))
    writeFileSync(join(root, 'package.json'), DECLARED)
    writeFileSync(join(root, 'DECISIONS.md'), [
      '# Decisions', '', '## Rulings', '',
      '### <a id="fjs-d02"></a>2026-08-20 · `FJS-D02` — newest.', 'Body.', '',
      '### <a id="fjs-d03"></a>2026-08-20 · `FJS-D03` — same day.', 'Body.', '',
      '### <a id="fjs-d01"></a>2026-08-10 · `FJS-D01` — oldest.', 'Body.', '',
    ].join('\n'))
    expect(of(runRegisterCheck({ root, today: TODAY }), 'ruling-order')).toHaveLength(0)
    rmSync(root, { recursive: true, force: true })
  })

  // Sections are subject areas with no order between them, so the newest ruling
  // of a later section sitting under an older one is not a finding.
  test('the order resets at a section boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-order-sec-'))
    writeFileSync(join(root, 'package.json'), DECLARED)
    writeFileSync(join(root, 'DECISIONS.md'), [
      '# Decisions', '',
      '## One', '',
      '### <a id="fjs-d01"></a>2026-08-10 · `FJS-D01` — older section, older ruling.', 'Body.', '',
      '## Two', '',
      '### <a id="fjs-d02"></a>2026-08-20 · `FJS-D02` — later ruling, new section.', 'Body.', '',
    ].join('\n'))
    expect(of(runRegisterCheck({ root, today: TODAY }), 'ruling-order')).toHaveLength(0)
    rmSync(root, { recursive: true, force: true })
  })

  // A ruling is sometimes overtaken by a shipped fix nobody wrote a ruling for.
  // What the reader needs is a citation they can follow, and an issue is one.
  test('a retirement may name an issue rather than a ruling', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-status-issue-'))
    writeFileSync(join(root, 'package.json'), DECLARED)
    writeFileSync(join(root, 'ISSUES.md'), [
      '## Closed',
      '| Id | Pkg | Title | Status | Verified | Detail |',
      '| --- | --- | --- | --- | --- | --- |',
      '| <a id="fjs-690"></a>FJS-690 | cli | **The fix that moved it.** | closed | 2026-08-17 | — |',
    ].join('\n'))
    writeFileSync(join(root, 'DECISIONS.md'), [
      '# Decisions', '', '## Rulings', '',
      '### <a id="fjs-d01"></a>2026-08-18 · `FJS-D01` — overtaken by a fix.',
      '**Status:** amended-by [`FJS-690`](ISSUES.md#fjs-690)', '',
    ].join('\n'))
    const result = runRegisterCheck({ root, today: TODAY })
    expect(of(result, 'ruling-status')).toHaveLength(0)
    expect(of(result, 'unknown-ref')).toHaveLength(0)
    rmSync(root, { recursive: true, force: true })
  })

  test('a status pointing at an id no register holds is a citation fault', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-status-ref-'))
    writeFileSync(join(root, 'package.json'), DECLARED)
    writeFileSync(join(root, 'DECISIONS.md'), [
      '# Decisions', '', '## Rulings', '',
      '### <a id="fjs-d01"></a>2026-08-18 · `FJS-D01` — retired by a ghost.',
      '**Status:** superseded-by [`FJS-D99`](#fjs-d99)', '',
    ].join('\n'))
    const result = runRegisterCheck({ root, today: TODAY })
    expect(of(result, 'ruling-status')).toHaveLength(0)
    expect(of(result, 'unknown-ref').map(h => h.id)).toEqual(['FJS-D01'])
    rmSync(root, { recursive: true, force: true })
  })

  test('a paper with no frontmatter is not graded on values it never declared', () => {
    const result = runRegisterCheck({ root: ROOT, today: TODAY })
    expect(result.findings.some(f => f.id === 'unmigrated')).toBe(false)
  })

  test('a link relative to the file it is in resolves', () => {
    const hits = of(runRegisterCheck({ root: ROOT, today: TODAY }), 'dead-link')
    expect(hits.some(h => h.id === 'good')).toBe(false)
  })

  test('a record citing its own id is a sentence, not a reference', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-self-'))
    writeFileSync(join(root, 'package.json'), DECLARED)
    writeFileSync(join(root, 'ISSUES.md'), [
      '## S1 — blockers',
      '| <a id="fjs-001"></a>FJS-001 | cli | **FJS-001 is about itself.** | open | 2026-08-17 | — |',
    ].join('\n'))
    expect(of(runRegisterCheck({ root, today: TODAY }), 'unknown-ref')).toHaveLength(0)
    rmSync(root, { recursive: true, force: true })
  })
})

// ─── in the tree means committed, not on this disk ───────────────────────────
//
// A fresh clone is what CI grades, and it holds neither a sibling checkout nor
// a build: a link to either passed on the machine that wrote it and failed on
// every runner (FJS-009).

describe('a dead link is graded against the tree, not the disk', () => {
  let root
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'fli-regtree-'))
    writeFileSync(join(root, 'package.json'), DECLARED)
    writeFileSync(join(root, '.gitignore'), 'dist/\n')
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'dist', 'built.css'), '/* built */\n')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'real.js'), '// committed\n')
    writeFileSync(join(root, 'ISSUES.md'), [
      '## S1 — blockers',
      '| Id | Pkg | Title | Status | Verified | Detail |',
      '| --- | --- | --- | --- | --- | --- |',
      '| <a id="fjs-001"></a>FJS-001 | cli | **Committed.** | open | 2026-08-17 | [a](src/real.js) · [dir](src/) |',
      '| <a id="fjs-002"></a>FJS-002 | cli | **Build output.** | open | 2026-08-17 | [b](dist/built.css) |',
      '| <a id="fjs-003"></a>FJS-003 | cli | **Another repo.** | open | 2026-08-17 | [c](../elsewhere/x.ts) |',
    ].join('\n'))
    const run = spawnSync('git', ['init', '-q'], { cwd: root })
    if (run.status !== 0) throw new Error('git init failed')
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('an ignored file on disk is not in the tree', () => {
    const hits = of(runRegisterCheck({ root, today: TODAY }), 'dead-link')
    expect(hits.map(h => h.id)).toEqual(['FJS-002'])
  })

  test('a link that leaves the root is another repository\'s claim, and not graded', () => {
    const hits = of(runRegisterCheck({ root, today: TODAY }), 'dead-link')
    expect(hits.some(h => h.id === 'FJS-003')).toBe(false)
  })
})

// A client repo may keep its registers out of git on purpose. A clone then holds
// neither the papers nor the rows linking them, so a link between two of them is
// graded the way the folder is kept — on the disk — while a link out to code is
// still graded against the tree.

describe('a register folder git ignores is graded on the disk', () => {
  let root
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'fli-regignored-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', registers: { prefix: 'FJS', dir: '.project' } }))
    writeFileSync(join(root, '.gitignore'), '.project/\ndist/\n')
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'dist', 'built.css'), '/* built */\n')
    mkdirSync(join(root, '.project', 'IDEAS'), { recursive: true })
    writeFileSync(join(root, '.project', 'IDEAS', 'paper.md'), '---\nid: paper\nstatus: proposed\n---\n\n# Idea — a paper\n')
    writeFileSync(join(root, '.project', 'ISSUES.md'), [
      '## S1 — blockers',
      '| Id | Pkg | Title | Status | Verified | Detail |',
      '| --- | --- | --- | --- | --- | --- |',
      '| <a id="fjs-001"></a>FJS-001 | cli | **Paper beside it.** | open | 2026-08-17 | [p](IDEAS/paper.md) |',
      '| <a id="fjs-002"></a>FJS-002 | cli | **Build output.** | open | 2026-08-17 | [b](../dist/built.css) |',
      '| <a id="fjs-003"></a>FJS-003 | cli | **Missing paper.** | open | 2026-08-17 | [m](IDEAS/gone.md) |',
    ].join('\n'))
    const run = spawnSync('git', ['init', '-q'], { cwd: root })
    if (run.status !== 0) throw new Error('git init failed')
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('a link inside the ignored folder is live when the file is on disk', () => {
    const hits = of(runRegisterCheck({ root, today: TODAY }), 'dead-link')
    expect(hits.map(h => h.id).sort()).toEqual(['FJS-002', 'FJS-003'])
  })
})

// ─── the report ───────────────────────────────────────────────────────────────

describe('the report', () => {
  test('a clean register says so and finds nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-clean-'))
    writeFileSync(join(root, 'package.json'), DECLARED)
    writeFileSync(join(root, 'ISSUES.md'), [
      '## S1 — blockers',
      '| <a id="fjs-001"></a>FJS-001 | cli | **Fine.** | open | 2026-08-17 | — |',
    ].join('\n'))

    const result = runRegisterCheck({ root, today: TODAY })
    expect(rules(result)).toEqual([])
    expect(formatRegisterCheck(result).join('\n')).toContain('agrees with itself')
    rmSync(root, { recursive: true, force: true })
  })

  // The two halves of one rule, and they have to be asserted together: a check
  // that refused a thin register would be as wrong as one that passed an empty
  // directory, and from the refused side the two look identical.

  test('a register a project does not keep is not a failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-thin-'))
    writeFileSync(join(root, 'package.json'), DECLARED)
    writeFileSync(join(root, 'ISSUES.md'), [
      '## S1 — blockers',
      '| <a id="fjs-001"></a>FJS-001 | cli | **Fine.** | open | 2026-08-17 | — |',
    ].join('\n'))

    const result = runRegisterCheck({ root, today: TODAY })
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.sources).toEqual(['ISSUES.md'])
    expect(result.counts.decisions).toBe(0)
    rmSync(root, { recursive: true, force: true })
  })

  test('a root with no register at all is refused, not passed', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-none-'))
    writeFileSync(join(root, 'package.json'), DECLARED)
    expect(() => runRegisterCheck({ root, today: TODAY })).toThrow(/no register at/)
    rmSync(root, { recursive: true, force: true })
  })

  // The case that was green: `fli` walks up to the nearest package root, so
  // this command run from inside a package graded that package's directory and
  // reported that every register agreed with itself.
  test('a package directory inside this repo is refused rather than graded clean', () => {
    expect(() => runRegisterCheck({ root: join(REPO, 'packages', 'cli'), staleDays: 0 }))
      .toThrow(/no register at/)
  })

  test('the report names what it read', () => {
    const text = formatRegisterCheck(runRegisterCheck({ root: ROOT, today: TODAY })).join('\n')
    expect(text).toContain('read ISSUES.md')
  })

  test('the report names every rule that fired, once', () => {
    const result = runRegisterCheck({ root: ROOT, today: TODAY })
    const text   = formatRegisterCheck(result).join('\n')
    for (const rule of RULES) {
      const fired = of(result, rule.id).length > 0
      expect(text.includes(`${rule.id} — `)).toBe(fired)
    }
  })
})

// ─── this repo ────────────────────────────────────────────────────────────────

describe('the repo it ships with', () => {
  test('it runs, and the clock rule is off for a reproducible answer', () => {
    const result = runRegisterCheck({ root: REPO, staleDays: 0 })
    expect(result.counts.open).toBeGreaterThan(0)
    expect(result.counts.decisions).toBeGreaterThan(0)
    expect(of(result, 'stale-verified')).toHaveLength(0)
  })

  test('no rule over-fires on a register that has none of that fault', () => {
    const result = runRegisterCheck({ root: REPO, staleDays: 0 })
    // A dead link or a malformed date here would be a real finding; both are
    // currently zero, and a regression in the resolver would show up as a wall
    // of them rather than as one.
    expect(of(result, 'dead-link').length).toBeLessThan(5)
    expect(of(result, 'malformed-date').length).toBe(0)
  })
})

// ─── a register the reader could not read ─────────────────────────────────────
//
// The state between *no register here* and *a register that is empty*, and the
// only one of the three that used to pass: the readers are keyed to one id
// prefix, so a project keeping its registers under another one parses to
// nothing and every rule below is asked of nothing. Both controls are the test
// — an empty register is a project at the start and must stay green, and a
// fenced example is the format documenting itself.

describe('unparsed-record', () => {
  let dir

  const at = (files) => {
    dir = mkdtempSync(join(tmpdir(), 'fli-unparsed-'))
    writeFileSync(join(dir, 'package.json'), DECLARED)
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
    return runRegisterCheck({ root: dir, staleDays: 0 })
  }

  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  test('a table under another prefix is an error, not a clean sheet', () => {
    const result = at({
      'ISSUES.md': [
        '## S1 — blockers',
        '| Id | Pkg | Title | Status | Verified | Detail |',
        '| --- | --- | --- | --- | --- | --- |',
        '| `ACME-1` | web | **The thing broke.** measured | open | 2026-08-17 | — |',
        '',
      ].join('\n'),
    })
    expect(of(result, 'unparsed-record')).toHaveLength(1)
    expect(of(result, 'unparsed-record')[0].line).toBe(4)
    expect(result.counts.errors).toBeGreaterThan(0)
  })

  test('a register with no rows at all is a project at the start', () => {
    const result = at({
      'ISSUES.md': '# Issues\n\nNothing open.\n\n| Id | Pkg | Title | Status | Verified | Detail |\n| --- | --- | --- | --- | --- | --- |\n',
    })
    expect(of(result, 'unparsed-record')).toHaveLength(0)
  })

  test('a ruling heading under another prefix is read the same way', () => {
    const result = at({
      'DECISIONS.md': '## API design\n\n### 2026-08-16 · `ACME-D2` — the claim\n\nThe argument.\n',
    })
    expect(of(result, 'unparsed-record')).toHaveLength(1)
    expect(of(result, 'unparsed-record')[0].file).toBe('DECISIONS.md')
  })

  test('a fenced example is the format documenting itself, never a record', () => {
    const result = at({
      'ISSUES.md': [
        '# Issues',
        '',
        'A row is written like this:',
        '',
        '```',
        '| ACME-1 | web | **The claim.** | open | 2026-08-17 | — |',
        '```',
        '',
      ].join('\n'),
    })
    expect(of(result, 'unparsed-record')).toHaveLength(0)
  })

  test('this repo reads its own register whole', () => {
    expect(of(runRegisterCheck({ root: REPO, staleDays: 0 }), 'unparsed-record')).toHaveLength(0)
  })
})

// ─── the id says which register a row belongs to (FJS-1033) ──────────────────
//
// `ISSUES.md` holds two registers in one file. The reader tells them apart by
// SECTION; every other document tells them apart by PREFIX. Five closed defects
// sat in § Needs a decision and every rule passed over them, because the two
// rules written for misplacement are blind here by construction: `row-shape`
// grades on the cell count and both tables declare four columns, and the status
// branch is only reached for a row carrying a severity, which a decision-section
// row never does.
//
// Both firing cases are paired with the legitimate shape one prefix away, and
// the third control is the one the design turns on: § Closed holds BOTH kinds
// on purpose, because a question that gets its ruling closes under the id it
// was asked under.

describe('an id filed under the wrong section', () => {
  let dir
  const fixture = (files) => {
    dir = mkdtempSync(join(tmpdir(), 'fli-idsection-'))
    writeFileSync(join(dir, 'package.json'), DECLARED)
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
    return runRegisterCheck({ root: dir, staleDays: 0 })
  }
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  const DEFECTS = [
    '## S2 — high',
    '| Id | Pkg | Title | Status | Verified | Detail |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  const QUESTIONS = [
    '',
    '## Needs a decision',
    '| Id | Pkg | Question | Detail |',
    '| --- | --- | --- | --- |',
  ]

  test('a defect id among the questions is reported, and a ruling id there is not', () => {
    const result = fixture({ 'ISSUES.md': [
      ...DEFECTS,
      ...QUESTIONS,
      '| <a id="fjs-900"></a>FJS-900 | cli | **A defect parked among the questions.** | — |',
      // The pair. This is what the table is FOR, and a rule that fired on both
      // would be one nobody could leave switched on.
      '| <a id="fjs-d90"></a>FJS-D90 | cli | **A question waiting for a ruling.** | — |',
      '',
    ].join('\n') })

    const hits = of(result, 'id-section')
    expect(hits.map(h => h.id)).toEqual(['FJS-900'])
    // Named, because the fix is not the same in both directions: this one may
    // be a misfiled defect or a question issued under the wrong prefix.
    expect(hits[0].message).toContain('defect id')
  })

  test('a ruling id under a severity heading is reported, and a defect id there is not', () => {
    const result = fixture({ 'ISSUES.md': [
      ...DEFECTS,
      '| <a id="fjs-d91"></a>FJS-D91 | cli | **A question filed as a defect.** | open | 2026-08-17 | — |',
      '| <a id="fjs-901"></a>FJS-901 | cli | **An ordinary defect.** | open | 2026-08-17 | — |',
      ...QUESTIONS,
      '',
    ].join('\n') })

    const hits = of(result, 'id-section')
    expect(hits.map(h => h.id)).toEqual(['FJS-D91'])
    expect(hits[0].message).toContain('ruling id')
  })

  test('§ Closed holds both kinds, and that is the lifecycle rather than a loophole', () => {
    // The control the design turns on. A question that gets its ruling closes
    // as a row under the id it was asked under — twenty-seven of them sit in
    // this repo's own § Closed — so a rule reading the prefix everywhere would
    // report the normal end of every decision as a fault.
    const result = fixture({ 'ISSUES.md': [
      ...DEFECTS,
      ...QUESTIONS,
      '',
      '## Closed',
      '| Id | Title | Closed | How |',
      '| --- | --- | --- | --- |',
      '| <a id="fjs-902"></a>FJS-902 | cli — **A defect that was fixed.** | 2026-08-17 | fixed |',
      '| <a id="fjs-d92"></a>FJS-D92 | cli — **A question that got its ruling.** | 2026-08-17 | ruled |',
      '',
    ].join('\n') })

    expect(of(result, 'id-section')).toHaveLength(0)
  })

  test('this repo files every row under the section its id names', () => {
    // The live half. `FJS-1033` fixed the five by hand and left the rule open,
    // so a green answer here is the placement holding rather than the rule
    // never having been asked.
    expect(of(runRegisterCheck({ root: REPO, staleDays: 0 }), 'id-section')).toHaveLength(0)
  })
})

// ─── the overview's ranked rows ───────────────────────────────────────────────
//
// `overview.md` is read by four consumers and graded by none of them. Each
// fault below is silent in all four: a row of the wrong width is read into the
// wrong fields, a shared rank answers for whichever row came first, and a
// Status cell goes on saying `idea` after its paper shipped.

describe('the overview table', () => {
  let dir

  const HEAD = [
    '| # | Item | Effort | Payoff | Edge | Realms | Status | Source |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  const row = (rank, status, source = 'open.md', item = '**An item.**') =>
    `| ${rank} | ${item} | S | ●●○○ | parity | A | ${status} | \`${source}\` |`

  const fixture = (rows) => {
    dir = mkdtempSync(join(tmpdir(), 'fli-overview-'))
    writeFileSync(join(dir, 'package.json'), DECLARED)
    writeFileSync(join(dir, 'ISSUES.md'), [
      '## S2 — high',
      '| Id | Pkg | Title | Status | Verified | Detail |',
      '| --- | --- | --- | --- | --- | --- |',
      '| <a id="fjs-001"></a>FJS-001 | cli | **Still open.** | open | 2026-08-17 | — |',
      '',
      '## Closed',
      '| Id | Title | Closed | How |',
      '| --- | --- | --- | --- |',
      '| <a id="fjs-002"></a>FJS-002 | cli — **Fixed.** | 2026-08-17 | fixed |',
      '',
    ].join('\n'))
    mkdirSync(join(dir, 'IDEAS'))
    const paper = (name, status) => writeFileSync(join(dir, 'IDEAS', name),
      `---\nid: ${name.replace('.md', '')}\nstatus: ${status}\ndated: 2026-08-01\n---\n\n# ${name}\n`)
    paper('open.md', 'proposed')
    paper('done.md', 'shipped')
    paper('gone.md', 'withdrawn')
    writeFileSync(join(dir, 'IDEAS', 'overview.md'), [...HEAD, ...rows, ''].join('\n'))
    return runRegisterCheck({ root: dir, staleDays: 0 })
  }
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  test('a row of the wrong width is reported, in both directions', () => {
    const result = fixture([
      row('0.1', 'idea'),
      '| 0.2 | **Too narrow** | S | idea |',
      row('0.3', 'idea') + ' extra |',
    ])
    const hits = of(result, 'row-shape')
    expect(hits.map(h => h.id)).toEqual(['0.2', '0.3'])
    expect(hits[0].message).toContain('4 cells where its table declares 8')
    expect(hits[0].file).toBe('IDEAS/overview.md')
  })

  test('a row with no rank is reported rather than vanishing', () => {
    const hits = of(fixture([row('zero', 'idea')]), 'row-shape')
    expect(hits).toHaveLength(1)
    expect(hits[0].message).toContain('not a rank')
  })

  test('a rank two rows share is reported against the second', () => {
    const hits = of(fixture([row('1.1', 'idea'), row('1.2', 'idea'), row('1.1', 'partial')]), 'duplicate-id')
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe('1.1')
    expect(hits[0].detail).toContain('also at IDEAS/overview.md:')
  })

  test('an open status over a shipped or withdrawn paper is reported', () => {
    const result = fixture([
      row('2.1', 'idea', 'done.md'),
      row('2.2', '**proposed**', 'gone.md'),
      row('2.3', 'idea', 'open.md'),
    ])
    expect(of(result, 'overview-status').map(h => h.id)).toEqual(['2.1', '2.2'])
  })

  test('a defect whose every cited row is closed is reported, one with an open row is not', () => {
    const result = fixture([
      row('3.1', 'defect', 'open.md', '**Fixed `FJS-002`.**'),
      row('3.2', 'defect', 'open.md', '**Half `FJS-001` `FJS-002`.**'),
      row('3.3', 'defect', 'open.md', '**Cites nothing.**'),
      row('3.4', 'defect', 'open.md', '**Remainder.** after `FJS-002`, three fixes are still owed'),
    ])
    expect(of(result, 'overview-status').map(h => h.id)).toEqual(['3.1'])
  })

  test('a status already reconciled in prose is left alone', () => {
    const result = fixture([
      row('4.1', '~~`idea`~~ — shipped', 'done.md'),
      row('4.2', 'partial', 'done.md'),
      row('4.3', 'shipped', 'open.md'),
    ])
    expect(of(result, 'overview-status')).toHaveLength(0)
    expect(of(result, 'row-shape')).toHaveLength(0)
  })

  test('this repo\'s overview agrees with its papers and its register', () => {
    const result = runRegisterCheck({ root: REPO, staleDays: 0 })
    const here   = (rule) => of(result, rule).filter(h => h.file === 'IDEAS/overview.md')
    expect(here('overview-status')).toHaveLength(0)
    expect(here('row-shape')).toHaveLength(0)
    expect(here('duplicate-id')).toHaveLength(0)
  })
})

// ─── a ruling's Lives in, held to the tree (FJS-771) ─────────────────────────

describe('lives-in', () => {
  let LROOT

  beforeAll(() => {
    LROOT = mkdtempSync(join(tmpdir(), 'fli-livesin-'))
    writeFileSync(join(LROOT, 'package.json'), DECLARED)
    mkdirSync(join(LROOT, 'packages', 'alpha', 'src', 'core'), { recursive: true })
    writeFileSync(join(LROOT, 'packages', 'alpha', 'package.json'), JSON.stringify({ name: '@frontierjs/alpha' }))
    writeFileSync(join(LROOT, 'packages', 'alpha', 'src', 'core', 'client.js'), 'export function openClient() {}\n')
    writeFileSync(join(LROOT, 'ISSUES.md'), '## S1 — blockers\n| Id | Pkg | Title | Status | Verified | Detail |\n| --- | --- | --- | --- | --- | --- |\n')
    writeFileSync(join(LROOT, 'DECISIONS.md'), [
      '# Decisions', '', '## Rulings', '',
      '### <a id="fjs-d11"></a>2026-08-18 · `FJS-D11` — every citation holds.',
      '*Lives in:* `packages/alpha/src/core/client.js` (`openClient`) · `src/core/client.js` (`openClient`) · `@frontierjs/alpha/sub` · `FJS-D11` · `/a/route` · `*.glob` · `Name.md`.', '',
      '### <a id="fjs-d12"></a>2026-08-18 · `FJS-D12` — a path nothing holds.',
      '*Lives in:* `packages/alpha/src/core/gone.js` · `core/also-gone.js`.', '',
      '### <a id="fjs-d13"></a>2026-08-18 · `FJS-D13` — a symbol the file dropped.',
      '*Lives in:* `packages/alpha/src/core/client.js` (`openClient`, `closeClient`).', '',
      '### <a id="fjs-d14"></a>2026-08-18 · `FJS-D14` — a package nobody declares, across two lines.',
      '*Lives in:* `src/core/client.js`,',
      '`@frontierjs/utils` and `@frontierjs/alpha`.', '',
      '### <a id="fjs-d15"></a>2026-08-18 · `FJS-D15` — retired, so its paths are history.',
      '**Status:** superseded-by [`FJS-D11`](#fjs-d11)',
      '*Lives in:* `packages/alpha/src/core/gone.js`.', '',
      '### <a id="fjs-d16"></a>2026-08-18 · `FJS-D16` — a bare path is ambiguous, so its symbol is not graded.',
      '*Lives in:* `src/core/client.js` (`notHere`).', '',
    ].join('\n'))
  })

  afterAll(() => { rmSync(LROOT, { recursive: true, force: true }) })

  const hits = () => of(runRegisterCheck({ root: LROOT, staleDays: 0 }), 'lives-in').map(h => `${h.id}: ${h.message}`)

  test('a citation that resolves, in any of the spellings in use, is silent', () => {
    expect(hits().filter(h => h.startsWith('FJS-D11:'))).toEqual([])
  })

  test('a path no package holds is reported, root-relative or package-relative', () => {
    expect(hits().filter(h => h.startsWith('FJS-D12:'))).toEqual([
      'FJS-D12: Lives in names packages/alpha/src/core/gone.js, which is not in the tree',
      'FJS-D12: Lives in names core/also-gone.js, which is not in the tree',
    ])
  })

  test('a symbol the file no longer mentions is reported, one it still does is not', () => {
    expect(hits().filter(h => h.startsWith('FJS-D13:'))).toEqual([
      'FJS-D13: Lives in names closeClient in packages/alpha/src/core/client.js, which the file no longer mentions',
    ])
  })

  test('a package no package.json declares is reported, across a wrapped line', () => {
    expect(hits().filter(h => h.startsWith('FJS-D14:'))).toEqual([
      'FJS-D14: Lives in names @frontierjs/utils, which no package.json declares',
    ])
  })

  test('a retired ruling is exempt, as a closed row is', () => {
    expect(hits().filter(h => h.startsWith('FJS-D15:'))).toEqual([])
  })

  test('a bare package-relative path grades no symbol', () => {
    expect(hits().filter(h => h.startsWith('FJS-D16:'))).toEqual([])
  })

  test('the register this ships with has no stale citation', () => {
    expect(of(runRegisterCheck({ root: REPO, staleDays: 0 }), 'lives-in')).toEqual([])
  })
})
