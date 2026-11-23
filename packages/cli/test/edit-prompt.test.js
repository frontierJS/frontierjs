// ─── edit-prompt.test.js — what the ask panel and a site edit say ───────────
//
// The words are the boundary a prompt owns: a chip is a key and the sentence
// lives in `edit-prompt.js`, so a request cannot put its own words in through
// one. What Claude may touch is the argv, pinned in `vite-ask.test.js`.

import { describe, test, expect } from 'bun:test'

import { ASK_EFFORT } from '@frontierjs/claude'
import { EDIT_KINDS, EDIT_MAX_HTML, EDIT_RULES, EDIT_SCOPES, PANEL_EFFORTS, editEffort, editPrompt, shareBudget } from '../core/edit-prompt.js'

describe('editPrompt', () => {

  const guides = [
    { pkg: 'css',  file: '/r/css/AGENTS.md',  about: 'the styling language' },
    { pkg: 'mesa', file: '/r/mesa/AGENTS.md', about: 'the .mesa language' },
  ]

  test('a first ask lists every guide; a kind names the ones to read first', () => {
    const p = editPrompt({ instruction: 'x', guides, kind: 'style' })
    expect(p).toContain('- /r/css/AGENTS.md — the styling language\n- /r/mesa/AGENTS.md — the .mesa language')
    expect(p).toContain('Before this change, read: /r/css/AGENTS.md')
    expect(p).not.toContain('read: /r/css/AGENTS.md, /r/mesa')
    expect(editPrompt({ instruction: 'x', guides, kind: 'layout' })).toContain('Before this change, read: /r/css/AGENTS.md, /r/mesa/AGENTS.md')
    expect(editPrompt({ instruction: 'x', guides, kind: 'text' })).not.toContain('Before this change')
  })

  test('a follow-up does not list the guides again, and still names a kind\'s', () => {
    const p = editPrompt({ instruction: 'x', guides, kind: 'behavior', followUp: true })
    expect(p).not.toContain('one guide per package')
    expect(p).toContain('Before this change, read: /r/mesa/AGENTS.md')
  })

  test('a prompt for another agent lists the guides and leaves the panel\'s rules out', () => {
    const p = editPrompt({ instruction: 'x', guides, kind: 'style', rules: false })
    expect(p).not.toContain(EDIT_RULES)
    expect(p).toContain('- /r/css/AGENTS.md — the styling language')
    expect(p).toContain('Before this change, read: /r/css/AGENTS.md')
  })

  test('a kind runs at its own effort unless one is asked for, and every kind\'s is one the panel offers', () => {
    expect(editEffort('style')).toBe('low')
    expect(editEffort('behavior')).toBe('high')
    expect(editEffort('style', 'max')).toBe('max')
    expect(editEffort(null)).toBe(ASK_EFFORT)
    expect(editEffort('toString')).toBe(ASK_EFFORT)
    for (const k of Object.values(EDIT_KINDS)) expect(PANEL_EFFORTS).toContain(k.effort)
  })

  test('a first pick carries the rules, the change, the page, the source and the HTML', () => {
    const p = editPrompt({ instruction: 'make it bold', picks: [{ loc: 'content/routes/index.mesa:4:3', html: '<h1>Hi</h1>' }], page: 'http://localhost:8690/' })
    expect(p.startsWith(EDIT_RULES)).toBe(true)
    expect(p).toContain('Change: make it bold')
    expect(p).toContain('The page: http://localhost:8690/')
    expect(p).toContain('The element:\n- source: content/routes/index.mesa:4:3')
    expect(p).toContain('<h1>Hi</h1>')
    expect(p).not.toContain(' of 1:')
  })

  test('several picks are numbered, each with its own source', () => {
    const p = editPrompt({ instruction: 'x', picks: [
      { loc: 'content/routes/index.mesa:2:3', html: '<h1>A</h1>' },
      { loc: 'content/parts/Lede.mesa:1:1',   html: '<h2>B</h2>' },
    ] })
    expect(p).toContain('Element 1 of 2:\n- source: content/routes/index.mesa:2:3')
    expect(p).toContain('Element 2 of 2:\n- source: content/parts/Lede.mesa:1:1')
    expect(p.indexOf('<h1>A</h1>')).toBeLessThan(p.indexOf('<h2>B</h2>'))
  })

  test('a follow-up drops the rules, and a long outerHTML is cut and says so', () => {
    const p = editPrompt({ instruction: 'x', picks: [{ html: 'a'.repeat(EDIT_MAX_HTML + 10) }], followUp: true })
    expect(p).not.toContain(EDIT_RULES)
    expect(p).toContain(`first ${EDIT_MAX_HTML} of ${EDIT_MAX_HTML + 10}`)
  })

  test('the page cut the HTML already: the whole size is still what it reports', () => {
    const p = editPrompt({ instruction: 'x', picks: [{ html: 'a'.repeat(EDIT_MAX_HTML), size: 50_000 }] })
    expect(p).toContain(`first ${EDIT_MAX_HTML} of 50000`)
  })

  test('the HTML budget is one for the whole prompt, however many picks', () => {
    const picks = Array.from({ length: 10 }, () => ({ html: 'z'.repeat(EDIT_MAX_HTML) }))
    const p = editPrompt({ instruction: 'x', picks, followUp: true })
    expect((p.match(/z/g) || []).length).toBe(EDIT_MAX_HTML)
  })

  test('a chip is its sentence, and a key that is not one adds nothing', () => {
    const p = editPrompt({ instruction: 'x', kind: 'style', scope: 'every', followUp: true })
    expect(p).toContain(`What to change: ${EDIT_KINDS.style.says}`)
    expect(p).toContain(`How far: ${EDIT_SCOPES.every}`)
    const q = editPrompt({ instruction: 'x', kind: 'toString', scope: '__proto__', followUp: true })
    expect(q).toBe('Change: x')
  })

  test('what the source said about a pick goes under it, and the resources once after all of them', () => {
    const p = editPrompt({ instruction: 'x', followUp: true, data: ['`pins` from src/resources/Pin.mesa — model Pin at ../db/schema.lite:1: id, name'], picks: [{
      loc: 'src/routes/_module.mesa:9:7', html: '<div></div>', repeats: 12,
      loops: [{ head: 'pins as p (p.id)', at: 'src/routes/_module.mesa:4' }],
      files: ['src/routes/workbench/index.mesa:30'],
      inner: [{ head: 'p.files as f', at: 'src/routes/workbench/index.mesa:41' }],
    }] })
    expect(p).toContain([
      '- source: src/routes/_module.mesa:9:7',
      '- drawn 12 times on the page from that source',
      '- inside: {#each pins as p (p.id)} at src/routes/_module.mesa:4',
      '- written in, under it: src/routes/workbench/index.mesa:30',
      '- loops under it: {#each p.files as f} at src/routes/workbench/index.mesa:41',
    ].join('\n'))
    expect(p.endsWith('the resources their files import:\n- `pins` from src/resources/Pin.mesa — model Pin at ../db/schema.lite:1: id, name')).toBe(true)
  })

  test('no instruction yet: no Change line, the picks still go', () => {
    const p = editPrompt({ picks: [{ loc: '/app/site/a.mesa:3:1', html: '<h1>A</h1>' }], followUp: true })
    expect(p).not.toContain('Change:')
    expect(p).toContain('- source: /app/site/a.mesa:3:1')
  })

})

describe('editPrompt — images', () => {

  test('the prompt says images follow, and says nothing when there are none', () => {
    expect(editPrompt({ instruction: 'x', followUp: true, images: 2 })).toContain('I pasted 2 images with this; they come after this text.')
    expect(editPrompt({ instruction: 'x', followUp: true, images: 1 })).toContain('I pasted an image with this; it comes after this text.')
    expect(editPrompt({ instruction: 'x', followUp: true })).not.toContain('pasted')
  })


})

describe('shareBudget', () => {

  test('what a short pick leaves over goes to the long ones', () => {
    expect(shareBudget([100, 5000, 5000], 4000)).toEqual([100, 1950, 1950])
  })

  test('nothing is cut when everything fits, and the total is never passed', () => {
    expect(shareBudget([10, 20], 4000)).toEqual([10, 20])
    const cut = shareBudget([3999, 3999, 3999], 4000)
    expect(cut.reduce((a, b) => a + b)).toBeLessThanOrEqual(4000)
  })

})
