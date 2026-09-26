// decide-walk.test.js — `fli decide` with no id, one key per question.
//
// The walk writes through `decide()` and `settle()` and nothing else, so what is
// asserted is that each key reaches the right one of them with the right
// arguments, and that every way out — skip, an empty reason, Esc — leaves the
// registers as they were. The terminal is scripted; the registers are real files.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join }   from 'path'
import { tmpdir } from 'os'

import { walk, readWhy }                   from '../core/decide-walk.js'
import { openDecisions, readDecisions }    from '../core/decisions.js'

const TODAY = new Date('2026-09-14T12:00:00')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fli-walk-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ registers: { prefix: 'FJS' } }))
  mkdirSync(join(root, 'IDEAS'))
  writeFileSync(join(root, 'ISSUES.md'), '## Needs a decision\n\n| Id | Area | Question | Detail |\n| --- | --- | --- | --- |\n')
  writeFileSync(join(root, 'DECISIONS.md'), [
    '# Decisions', '',
    '## Naming & vocabulary', '',
    '### <a id="fjs-d03"></a>2026-08-01 · `FJS-D03` — a view is not a model.', '', 'Body.', '',
    '### <a id="fjs-d04"></a>2026-08-02 · `FJS-D04` — replaced.', '', '**Status:** superseded-by `FJS-D03`', '',
    '## Access control', '', 'Rulings about access.', '',
    '## Open (discussed, not yet ruled)', '', 'Points at the queue.', '',
  ].join('\n'))
  writeFileSync(join(root, 'IDEAS', 'views.md'), [
    '---', 'id: views', 'status: proposed', '---', '', '## Open questions', '',
    '- **Omit encrypted columns?** Decryption is above SQLite.',
    '  - **A** — omit them', '  - **B** — expose the ciphertext', '  - **Recommend A** — a view that leaks nothing is expected',
    '- **Is a view a model?** Asked before.',
    '  - **A** — as `FJS-D03` rules: no', '  - **Recommend A** — FJS-D03 settles it',
    '- **Is a view renamed?** Once.',
    '  - **A** — as the old ruling says', '  - **Recommend A** — FJS-D04 settles it',
    '- **Does the cache key grow?** Nobody has measured it.',
    '',
  ].join('\n'))
  const read = () => [readFileSync(join(root, 'DECISIONS.md'), 'utf8'), readFileSync(join(root, 'IDEAS', 'views.md'), 'utf8')]
  return { root, read, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

// Answers each question from a script, and fails loudly on a key the prompt did not offer.
function scripted(keys, { edits = [] } = {}) {
  const asked = [], said = [], viewed = []
  const tty = {
    interactive: true,
    keys: async (question, choices) => {
      asked.push({ question, choices })
      const key = keys.shift()
      if (key === undefined) throw new Error(`the script ran out at ${question}`)
      if (!(key in choices)) throw new Error(`${key} was not offered at ${question}: ${Object.keys(choices)}`)
      return key
    },
  }
  return {
    asked, said, viewed,
    run: (root) => walk({
      root, tty, today: TODAY,
      echo: (s) => said.push(s),
      edit: async () => edits.shift() ?? '',
      view: async (q) => viewed.push(q.id),
    }),
  }
}

describe('the queue', () => {
  test('an open question whose recommendation names a live ruling is settled, and a retired ruling settles nothing', () => {
    const { root, cleanup } = fixture()
    try {
      const { settled, open, decidable } = openDecisions(root)
      expect(settled.map(q => [q.id, q.by])).toEqual([['views:is-a-view-a-model', 'FJS-D03']])
      expect(open.map(q => q.id)).toEqual(['views:is-a-view-renamed', 'views:does-the-cache-key-grow'])
      expect(decidable.map(q => q.id)).toEqual(['views:omit-encrypted-columns'])
    } finally { cleanup() }
  })
})

describe('the walk', () => {
  test('settled first, then the pick; the recommendation is offered first and the section by number', async () => {
    const { root, read, cleanup } = fixture()
    try {
      const [decBefore] = read()
      const s   = scripted(['y', 'a', '2'])
      const out = await s.run(root)
      expect(out).toEqual({ ruled: 1, settled: 1, skipped: 0, quit: false })

      expect(Object.keys(s.asked[1].choices)[0]).toBe('a')
      expect(s.asked[2].choices['2']).toBe('Access control')

      const [dec, paper] = read()
      expect(paper).toContain('~~**Is a view a model?**~~ **Answered 2026-09-14 (`FJS-D03`): FJS-D03 settles it.**')
      expect(dec.startsWith(decBefore.split('## Access control')[0])).toBe(true)
      expect(dec.split('## Access control\n\n')[1]).toMatch(/^### <a id="fjs-d5"><\/a>2026-09-14 · `FJS-D5` — Omit encrypted columns — Omit them\./)
      expect(readDecisions(root).filter(q => q.state === 'ruled').length).toBe(2)
    } finally { cleanup() }
  })

  test('a pick against the recommendation takes its reason from the editor, comment lines dropped', async () => {
    const { root, read, cleanup } = fixture()
    try {
      const s = scripted(['s', 'b', '1'], { edits: ['# why B?\nan operator\nreads ciphertext\n# ignored'] })
      expect(await s.run(root)).toEqual({ ruled: 1, settled: 0, skipped: 1, quit: false })
      expect(read()[0]).toContain('\nan operator reads ciphertext.\n')
    } finally { cleanup() }
  })

  test('every way out writes nothing: skip, an empty reason, Esc at the section, Esc at a question', async () => {
    const scripts = [
      [['s', 's']],
      [['s', 'b'], { edits: ['# only comments\n'] }],
      [['s', 'a', 'esc']],
      [['esc']],
    ]
    for (const [keys, opts] of scripts) {
      const { root, read, cleanup } = fixture()
      try {
        const was = read()
        await scripted(keys, opts).run(root)
        expect(read()).toEqual(was)
      } finally { cleanup() }
    }
  })

  test('v shows the question where it is argued and asks again', async () => {
    const { root, cleanup } = fixture()
    try {
      const s = scripted(['v', 's', 'v', 'esc'])
      expect((await s.run(root)).quit).toBe(true)
      expect(s.viewed).toEqual(['views:is-a-view-a-model', 'views:omit-encrypted-columns'])
    } finally { cleanup() }
  })

  test('the section used last is Enter the next time', async () => {
    const { root, cleanup } = fixture()
    try {
      writeFileSync(join(root, 'IDEAS', 'more.md'), [
        '---', 'id: more', 'status: proposed', '---', '', '## Open questions', '',
        '- **Second?** Yes.', '  - **A** — yes', '  - **B** — no', '  - **Recommend A** — because', '',
      ].join('\n'))
      const s = scripted(['s', 'a', '2', 'a', '1'])
      await s.run(root)
      const sections = s.asked.filter(a => a.question.includes('File it under'))
      expect(Object.values(sections[1].choices)[0]).toBe('Access control')
    } finally { cleanup() }
  })
})

test('readWhy drops the template and joins what is left into one paragraph', () => {
  expect(readWhy('# a\n\nfirst line\n  second\n# b\n')).toBe('first line second')
  expect(readWhy('# nothing\n')).toBe('')
})
