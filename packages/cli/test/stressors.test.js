// stressors.test.js — the stress loop's pure half: which listed app runs next,
// why one is passed over, and what a finished session is graded as.
//
// What can be WRONG: an edit elsewhere in a plan resetting an app's turn, a
// step ticked on an unmerged branch built a second time, and an outcome read
// off the session's words rather than the plan and the registers.

import { describe, test, expect } from 'bun:test'

import { waitedSince, blamedAt, orderCards, passedOver, claimed, grade, branchOf } from '../../../scripts/stressors.mjs'

const card = (app, waited, step = { id: '1.1', line: 9 }) => ({ app, dir: `/apps/${app}`, plan: {}, step, waited, error: null })

describe('waitedSince and blamedAt', () => {
  test('the box line\'s commit, the file\'s mtime for an uncommitted line, and the later attempt win in that order', () => {
    expect(waitedSince({ lineAt: '2026-10-16T00:00:00.000Z', mtime: '2026-11-01T00:00:00.000Z', attemptAt: undefined })).toBe('2026-10-16T00:00:00.000Z')
    expect(waitedSince({ lineAt: null, mtime: '2026-11-01T00:00:00.000Z' })).toBe('2026-11-01T00:00:00.000Z')
    expect(waitedSince({ lineAt: '2026-10-16T00:00:00.000Z', mtime: '2026-11-01T00:00:00.000Z', attemptAt: '2026-11-02T01:00:00.000Z' })).toBe('2026-11-02T01:00:00.000Z')
    expect(waitedSince({ lineAt: '2026-10-16T00:00:00.000Z', attemptAt: '2026-10-01T00:00:00.000Z' })).toBe('2026-10-16T00:00:00.000Z')
  })

  test('a blamed line answers its committer time, and a line not committed yet answers null', () => {
    expect(blamedAt('a1468aa381e4d958510734648d588d04713000de 20 20 1\nauthor J\ncommitter-time 1792166262\ncommitter-tz -0700\n\tline')).toBe(new Date(1792166262 * 1000).toISOString())
    expect(blamedAt('0000000000000000000000000000000000000000 20 20 1\nauthor Not Committed Yet\ncommitter-time 1792166262\n')).toBeNull()
    expect(blamedAt('')).toBeNull()
  })
})

describe('orderCards and passedOver', () => {
  test('longest waited first, a tie in the list\'s order, an app with no step left out', () => {
    const cards = [card('b', '2026-10-20T00:00:00.000Z'), card('a', '2026-10-16T00:00:00.000Z'), card('c', '2026-10-20T00:00:00.000Z'), { ...card('d', '2026-01-01T00:00:00.000Z'), error: 'no PLAN.md' }, { ...card('e', null), step: null }]
    expect(orderCards(cards).map(c => c.app)).toEqual(['a', 'b', 'c'])
  })

  test('a step ticked on its branch waits on the merge; a failed or blocked one is tried again', () => {
    const c = card('serpgrid', '2026-10-16T00:00:00.000Z', { id: '1.2', line: 12 })
    const log = [
      { app: 'serpgrid', step: '1.2', outcome: 'started' },
      { app: 'serpgrid', step: '1.2', outcome: 'ticked', branch: 'stress/1.2' },
    ]
    expect(passedOver(c, log)).toBe("1.2 is ticked on stress/1.2, waiting on the owner's merge")
    expect(passedOver(c, [{ app: 'serpgrid', step: '1.2', outcome: 'blocked' }])).toBeNull()
    expect(passedOver(c, [{ app: 'serpgrid', step: '1.1', outcome: 'ticked' }])).toBeNull()
    expect(passedOver({ ...c, error: 'PLAN.md does not parse: line 3' }, [])).toBe('PLAN.md does not parse: line 3')
    expect(passedOver({ ...c, step: null }, [])).toBe('no open box')
  })
})

describe('claimed and grade', () => {
  test('the last stress-next line of a report, with its note', () => {
    expect(claimed('did things\nstress-next: serpgrid 1.2 blocked — FJS-3900, FJS-D3901\n')).toEqual({ app: 'serpgrid', step: '1.2', status: 'blocked', note: 'FJS-3900, FJS-D3901' })
    expect(claimed('stress-next: a 1.1 failed\nstress-next: a 1.1 ticked')).toMatchObject({ status: 'ticked', note: '' })
    expect(claimed('nothing here')).toBeNull()
  })

  test('the plan and the registers decide; the claim only says busy or blocked where neither can', () => {
    const claim = s => ({ app: 'a', step: '1.1', status: s, note: '' })
    expect(grade({ before: 'open', after: 'done', filed: ['FJS-1'], claim: claim('failed') })).toBe('ticked')
    expect(grade({ before: 'open', after: 'open', filed: ['FJS-1'], claim: claim('ticked') })).toBe('blocked')
    expect(grade({ before: 'open', after: 'open', filed: [], claim: claim('busy') })).toBe('busy')
    expect(grade({ before: 'open', after: 'open', filed: [], claim: claim('blocked') })).toBe('blocked')
    expect(grade({ before: 'open', after: 'open', filed: [], claim: claim('ticked') })).toBe('failed')
    expect(grade({ before: 'open', after: null, filed: [], claim: null })).toBe('failed')
    expect(branchOf('1.2')).toBe('stress/1.2')
  })
})
