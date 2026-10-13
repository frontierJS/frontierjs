// What the Registers screen hands Claude (api core/registers.ts) — the prompt
// per intent, and the refusals that keep `fix` and `frame` to one id of the
// kind their skill works on. Pure: the atlas is a literal, no fli, no disk.

import { describe, expect, test } from 'bun:test'
import { composePrompt, namedIds, branchSlug, explainPrompt, type Atlas, type Queued } from '../src/core/registers.ts'

const at = (file: string, line: number) => ({ file, line, href: file, edit: '' })

const atlas = {
  name: 'ws', prefix: 'FJS', dir: '.', sources: [], sections: ['Access control'], ready: [], blocked: [],
  issues: [
    { id: 'FJS-12', aliases: ['FJS-9'], pkg: ['junction'], title: 'A retry writes twice', status: 'open', severity: 'S2',
      verified: '', closed: false, body: '', refs: [], blockedBy: [], rank: null, links: [], at: at('ISSUES.md', 40) },
    { id: 'FJS-13', aliases: [], pkg: ['mesa'], title: 'Closed one', status: 'closed', severity: 'S3',
      verified: '', closed: true, body: '', refs: [], blockedBy: [], rank: null, links: [], at: at('ISSUES.md', 90) },
  ],
  rulings:   [{ id: 'FJS-D4', date: '2026-01-01', section: 'Access control', title: 'Gates live in the schema', status: '',
                supersededBy: null, body: '', refs: [], links: [], at: at('DECISIONS.md', 7) }],
  questions: [{ id: 'paper:cross-origin', source: 'idea', question: 'Cross-origin.', state: 'decidable',
                options: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }], recommend: { letter: 'B', why: 'w' },
                paper: 'paper', at: at('IDEAS/paper.md', 12) }],
  ideas: [],
} as unknown as Atlas

describe('namedIds', () => {
  test('ids the registers hold, an alias and a paper question among them; an unknown id is dropped', () => {
    expect(namedIds(atlas, 'see fjs-9, FJS-D4 and FJS-404, then paper:cross-origin'))
      .toEqual(['FJS-9', 'FJS-D4', 'paper:cross-origin'])
  })
})

describe('composePrompt', () => {
  test('discuss carries the text, cites each named record at its line, and asks for no edits', () => {
    const out = composePrompt(atlas, { text: 'FJS-12 still bites', intent: 'discuss' })
    if ('refused' in out) throw new Error(out.refused)
    expect(out.prompt.startsWith('FJS-12 still bites')).toBe(true)
    expect(out.prompt).toContain('- FJS-12 — issue, S2, open (ISSUES.md:40): A retry writes twice')
    expect(out.prompt).toContain('Change no file')
    expect(out.prompt).toContain('fli register:find')
  })

  test('file says how to write it down and nothing else', () => {
    const out = composePrompt(atlas, { text: 'Toasts stack forever', intent: 'file' })
    if ('refused' in out) throw new Error(out.refused)
    expect(out.prompt).toContain('fli register:file --sev')
    expect(out.prompt).toContain('Change no source file')
    expect(out.ids).toEqual([])
  })

  test('fix is the fix-next skill on one open row, with the rest of the text as notes', () => {
    const out = composePrompt(atlas, { text: 'FJS-12 — only on retry', intent: 'fix' })
    if ('refused' in out) throw new Error(out.refused)
    expect(out.prompt).toBe('/fix-next FJS-12 --ask\n\nFrom the person who sent it:\n\n— only on retry')
  })

  test('fix refuses a closed row, no row, and two rows', () => {
    expect(composePrompt(atlas, { text: 'FJS-13', intent: 'fix' })).toEqual({ refused: expect.stringMatching(/open row/) })
    expect(composePrompt(atlas, { text: 'it is broken', intent: 'fix' })).toEqual({ refused: expect.stringMatching(/open row/) })
    expect(composePrompt({ ...atlas, issues: [atlas.issues[0], { ...atlas.issues[0], id: 'FJS-14', aliases: [] }] }, { text: 'FJS-12 FJS-14', intent: 'fix' }))
      .toEqual({ refused: expect.stringMatching(/names FJS-12, FJS-14/) })
  })

  test('frame is the frame-next skill on one open question', () => {
    expect(composePrompt(atlas, { text: 'paper:cross-origin', intent: 'frame' })).toEqual({ ids: ['paper:cross-origin'], prompt: '/frame-next paper:cross-origin' })
    expect(composePrompt(atlas, { text: 'FJS-12', intent: 'frame' })).toEqual({ refused: expect.stringMatching(/open question/) })
  })

  test('an empty text and an unknown intent are refused by name', () => {
    expect(composePrompt(atlas, { text: '  ', intent: 'discuss' })).toEqual({ refused: expect.stringMatching(/paste/) })
    expect(composePrompt(atlas, { text: 'x', intent: 'ship' })).toEqual({ refused: expect.stringMatching(/'ship' is not one of/) })
  })
})

describe('branchSlug', () => {
  test('from the first id, lowercased, stepping past a branch that exists', () => {
    expect(branchSlug(['FJS-12'], () => false)).toBe('fjs-12')
    expect(branchSlug(['paper:cross-origin'], () => false)).toBe('paper-cross-origin')
    expect(branchSlug(['FJS-12'], s => s === 'fjs-12' || s === 'fjs-12-2')).toBe('fjs-12-3')
    expect(branchSlug([], () => false)).toBe('discuss')
  })
})

describe('explainPrompt', () => {
  const q: Queued = {
    id: 'paper:cross-origin', question: 'Cross-origin.', body: 'The store is on another origin.',
    options: [{ letter: 'A', text: 'a list of origins' }, { letter: 'B', text: 'any origin, a scoped token' }],
    recommend: { letter: 'B', why: 'a wildcard grants nothing without a credential' },
    paper: 'paper', status: 'proposed', file: 'IDEAS/paper.md', line: 12,
  }

  test('the question as argued — id at its line, prose, every option and the recommendation', () => {
    const p = explainPrompt(q)
    expect(p).toContain('paper:cross-origin — IDEAS/paper.md:12')
    expect(p).toContain('**Cross-origin.** The store is on another origin.')
    expect(p).toContain('- **A** — a list of origins')
    expect(p).toContain('- **Recommend B** — a wildcard grants nothing without a credential')
    expect(p).toContain('You are read-only')
  })

  test('a question with no recommendation says so rather than inventing one', () => {
    expect(explainPrompt({ ...q, recommend: null })).toContain('No recommendation is written.')
  })
})
