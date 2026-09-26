// owed-ruling.test.js — a question found mid-fix holds its row up, and its answer lets go.
//
// A fix that meets a choice files the question (`fli file --sev decision
// --blocks <row>`), argues its options in a paper bullet naming the new id, and
// moves on. `fli next` sets the row aside while the question is open. Answering
// the bullet — a pick or a settle — closes the question's row in the same act,
// and a pick takes the row's id, so the held row comes back naming its ruling
// with nothing edited by hand. Each step is read back through the readers
// `fli next`, `fli decisions` and `register:check` use.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'fs'
import { join }   from 'path'
import { tmpdir } from 'os'

import { fileIssue }        from '../core/file.js'
import { decide, settle }   from '../core/decide.js'
import { openDecisions }    from '../core/decisions.js'
import { rankNext }         from '../core/next.js'
import { readRegisters }    from '../core/registers.js'
import { runRegisterCheck } from '../core/register-check.js'

const TODAY = new Date('2026-09-26T12:00:00Z')

let dirs = []
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })

function project() {
  const root = mkdtempSync(join(tmpdir(), 'fli-owed-'))
  dirs.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ registers: { prefix: 'FJS' } }))
  writeFileSync(join(root, 'ISSUES.md'), [
    '# Issues', '',
    '## S2 — high', '',
    '| Id | Area | Title | Status | Verified | Detail |',
    '| --- | --- | --- | --- | --- | --- |',
    '| <a id="fjs-010"></a>FJS-010 | api | **A retry sends twice** | open | 2026-09-25 | Measured by hand |',
    '', '## Needs a decision', '',
    '| Id | Area | Question | Detail |',
    '| --- | --- | --- | --- |',
    '', '## Closed', '',
    '| Id | Title | Closed | How |',
    '| --- | --- | --- | --- |',
    '| <a id="fjs-009"></a>FJS-009 | repo — **An older one** | 2026-09-01 | Fixed |', '',
  ].join('\n'))
  writeFileSync(join(root, 'DECISIONS.md'), [
    '# Decisions', '',
    '## Transport', '',
    '### <a id="fjs-d03"></a>2026-08-01 · `FJS-D03` — a retry carries its key.', '', 'Body.', '',
    '## Open (discussed, not yet ruled)', '', 'Points at the queue.', '',
  ].join('\n'))
  mkdirSync(join(root, 'IDEAS'))
  writeFileSync(join(root, 'IDEAS', 'owed-rulings.md'), ['---', 'id: owed-rulings', 'status: proposed', '---', '', '# Rulings owed', '', '## Open questions', ''].join('\n'))
  return root
}

// What a fix session writes after `fli file` answers with the id.
function argue(root, id) {
  appendFileSync(join(root, 'IDEAS', 'owed-rulings.md'), [
    `- **${id} — Does a retry reuse its idempotency key?** Found fixing FJS-010.`,
    '  - **A** — reuse it', '  - **B** — mint a new one', '  - **Recommend A** — the key is already on the request', '',
  ].join('\n'))
}

const errors = (root) => runRegisterCheck({ root }).errors

describe('a question that holds a row up', () => {
  test('filed with --blocks: a D id in § Needs a decision, and the held row is set aside by fli next', () => {
    const root = project()
    const out  = fileIssue({ root, severity: 'decision', area: 'api', title: 'Does a retry reuse its key?', detail: 'Found fixing FJS-010', blocks: 'FJS-010', today: TODAY })
    expect(out).toMatchObject({ ok: true, id: 'FJS-D4', blocks: 'FJS-010' })

    const row = readRegisters(root).issues.find(r => r.id === 'FJS-D4')
    expect(row).toMatchObject({ severity: 'decision', closed: false })
    expect(readFileSync(join(root, 'ISSUES.md'), 'utf8')).toContain('Measured by hand · blocked by `FJS-D4` |')

    const next = rankNext(root)
    expect(next.ready.map(r => r.id)).not.toContain('FJS-010')
    expect(next.blocked.map(r => [r.id, r.blockedBy])).toEqual([['FJS-010', ['FJS-D4']]])
    expect(errors(root)).toEqual([])
  })

  test('a pick takes the row\'s id, closes the row, and the held row comes back', () => {
    const root = project()
    fileIssue({ root, severity: 'decision', area: 'api', title: 'Does a retry reuse its key?', detail: 'Found fixing FJS-010', blocks: 'FJS-010', today: TODAY })
    argue(root, 'FJS-D4')

    const q = openDecisions(root)
    expect(q.decidable.map(d => d.id)).toEqual(['owed-rulings:fjs-d4-does-a-retry-reuse-its-idempotency-key'])
    expect(q.open.map(d => d.id)).not.toContain('FJS-D4')

    const out = decide({ root, id: q.decidable[0].id, pick: 'A', section: 'Transport', today: TODAY })
    expect(out).toMatchObject({ ok: true, ruling: 'FJS-D4', closed: 'FJS-D4' })

    const dec = readFileSync(join(root, 'DECISIONS.md'), 'utf8')
    expect(dec).toContain('### <a id="fjs-d4"></a>2026-09-26 · `FJS-D4` — Does a retry reuse its idempotency key — Reuse it.')
    expect(readRegisters(root).issues.find(r => r.id === 'FJS-D4')).toMatchObject({ closed: true })

    const next = rankNext(root)
    expect(next.blocked).toEqual([])
    expect(next.ready.map(r => r.id)).toContain('FJS-010')
    expect(errors(root)).toEqual([])
  })

  test('a settle closes the row citing the ruling that already answered it, and mints nothing', () => {
    const root = project()
    fileIssue({ root, severity: 'decision', area: 'api', title: 'Does a retry reuse its key?', detail: 'Found fixing FJS-010', blocks: 'FJS-010', today: TODAY })
    appendFileSync(join(root, 'IDEAS', 'owed-rulings.md'), [
      '- **FJS-D4 — Does a retry reuse its idempotency key?** Found fixing FJS-010.',
      '  - **A** — as FJS-D03 rules: reuse it', '  - **Recommend A** — FJS-D03 settles it', '',
    ].join('\n'))

    const [q] = openDecisions(root).settled
    expect(q.by).toBe('FJS-D03')
    const out = settle({ root, id: q.id, by: q.by, today: TODAY })
    expect(out).toMatchObject({ ok: true, ruling: 'FJS-D03', closed: 'FJS-D4' })

    expect(readFileSync(join(root, 'DECISIONS.md'), 'utf8')).not.toContain('fjs-d4')
    expect(rankNext(root).ready.map(r => r.id)).toContain('FJS-010')
    expect(errors(root)).toEqual([])
  })

  test('--blocks refuses a row that is unknown or closed, and writes nothing', () => {
    const root   = project()
    const before = readFileSync(join(root, 'ISSUES.md'), 'utf8')
    const base   = { root, severity: 'decision', area: 'api', title: 'Q?', detail: 'd', today: TODAY }
    expect(fileIssue({ ...base, blocks: 'FJS-404' })).toMatchObject({ ok: false, reason: expect.stringContaining('no issue row has the id FJS-404') })
    expect(fileIssue({ ...base, blocks: 'FJS-009' })).toMatchObject({ ok: false, reason: expect.stringContaining('FJS-009 is closed') })
    expect(readFileSync(join(root, 'ISSUES.md'), 'utf8')).toBe(before)
  })
})
