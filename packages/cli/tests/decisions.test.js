// decisions.test.js — what is waiting on the owner, and answering it.
//
// `core/decisions.js` reads the questions and `core/decide.js` rules on one.
// The reader's failure is silence — a paper whose questions sit under a heading
// it does not match drops out of the queue, and the queue still looks full —
// so it is asserted over this repo as well as over a fixture. The writer's
// failure is a register left half answered, so every refusal is paired with
// the pick that works, and the put-back is triggered on purpose.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join }          from 'path'
import { tmpdir }        from 'os'
import { fileURLToPath } from 'url'

import { readDecisions, openDecisions, rulingSections, QUESTIONS_HEADING } from '../core/decisions.js'
import { decide, nextDecisionNumber } from '../core/decide.js'
import { runRegisterCheck }           from '../core/register-check.js'

const REPO  = fileURLToPath(new URL('../../..', import.meta.url))
const TODAY = new Date('2026-09-14T12:00:00')

function fixture({ paper } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fli-decisions-'))
  mkdirSync(join(root, 'IDEAS'))

  writeFileSync(join(root, 'ISSUES.md'), [
    '## Needs a decision',
    '',
    '| Id | Area | Question | Detail |',
    '| --- | --- | --- | --- |',
    '| <a id="fjs-d07"></a>FJS-D07 | cli | **Should the thing be a thing?** It is argued elsewhere. | — |',
    '',
  ].join('\n'))

  writeFileSync(join(root, 'DECISIONS.md'), [
    '# Decisions',
    '',
    '## Naming & vocabulary',
    '',
    '### <a id="fjs-d03"></a>2026-08-01 · `FJS-D03` — an older ruling, named by FJS-D07\'s paper.',
    '',
    'Body.',
    '',
    '## Open (discussed, not yet ruled)',
    '',
    'Points at the queue.',
    '',
  ].join('\n'))

  writeFileSync(join(root, 'IDEAS', 'views.md'), paper ?? [
    '---',
    'id: views',
    'status: proposed',
    '---',
    '',
    '# Views — see FJS-D03',
    '',
    '## Open questions',
    '',
    '- **Omit encrypted columns, or expose them?** Decryption is above SQLite.',
    '  - **A** — omit them, and report the omission',
    '  - **B** — expose the ciphertext as it is',
    '    stored on disk',
    '  - **Recommend A** — a view that leaks nothing is what a caller expects',
    '- **Does the cache key grow?** Nobody has measured it.',
    '- ~~**Is this a view at all?**~~ **Answered 2026-08-01 (`FJS-D03`): yes.** It was.',
    '- **Omit encrypted columns, or expose them?** The same words twice.',
    '',
    '## See also',
    '',
    '- **Not a question** — a bullet under another heading.',
    '',
  ].join('\n'))

  writeFileSync(join(root, 'IDEAS', 'gone.md'), [
    '---', 'id: gone', 'status: withdrawn', '---', '', '## Open questions', '', '- **Moot?** Declined.', '',
  ].join('\n'))

  writeFileSync(join(root, 'IDEAS', 'numbered.md'), [
    '---', 'id: numbered', 'status: partial', '---', '', '## 9. Open questions', '', '1. **Still read?** Yes.', '',
  ].join('\n'))

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

// ─── the read ─────────────────────────────────────────────────────────────────

describe('the read', () => {

  test('each question is ruled, decidable or open, and says which', () => {
    const { root, cleanup } = fixture()
    try {
      const byId = Object.fromEntries(readDecisions(root).map(q => [q.id, q]))
      expect(byId['views:omit-encrypted-columns-or-expose-them'].state).toBe('decidable')
      expect(byId['views:does-the-cache-key-grow'].state).toBe('open')
      expect(byId['views:is-this-a-view-at-all'].state).toBe('ruled')
      expect(byId['FJS-D07'].state).toBe('open')
      expect(byId['FJS-D07'].source).toBe('issue')
    } finally { cleanup() }
  })

  test('options, their wrapped lines and the recommendation are read off the bullet', () => {
    const { root, cleanup } = fixture()
    try {
      const q = readDecisions(root).find(d => d.state === 'decidable')
      expect(q.options).toEqual([
        { letter: 'A', text: 'omit them, and report the omission' },
        { letter: 'B', text: 'expose the ciphertext as it is stored on disk' },
      ])
      expect(q.recommend).toEqual({ letter: 'A', why: 'a view that leaks nothing is what a caller expects' })
    } finally { cleanup() }
  })

  test('two questions worded alike in one paper get two ids', () => {
    const { root, cleanup } = fixture()
    try {
      const ids = readDecisions(root).map(q => q.id)
      expect(ids).toContain('views:omit-encrypted-columns-or-expose-them-2')
      expect(new Set(ids).size).toBe(ids.length)
    } finally { cleanup() }
  })

  test('a withdrawn paper has no live questions, and a numbered heading is still read', () => {
    // The pair: dropping every paper would also satisfy the first half.
    const { root, cleanup } = fixture()
    try {
      const papers = new Set(readDecisions(root).map(q => q.paper?.id))
      expect(papers.has('gone')).toBe(false)
      expect(papers.has('numbered')).toBe(true)
    } finally { cleanup() }
  })

  test('a bullet under any other heading is not a question', () => {
    const { root, cleanup } = fixture()
    try {
      expect(readDecisions(root).some(q => /Not a question/.test(q.question))).toBe(false)
    } finally { cleanup() }
  })

  test('the sections a ruling may go under leave out the one pointing at the queue', () => {
    const { root, cleanup } = fixture()
    try { expect(rulingSections(root)).toEqual(['Naming & vocabulary']) } finally { cleanup() }
  })
})

// ─── the pick ─────────────────────────────────────────────────────────────────

describe('the pick', () => {
  const ID = 'views:omit-encrypted-columns-or-expose-them'

  test('following the recommendation writes a ruling and strikes the question', () => {
    const { root, cleanup } = fixture()
    try {
      const before = nextDecisionNumber(root)
      const out    = decide({ root, id: ID, pick: 'a', section: 'Naming & vocabulary', today: TODAY })
      expect(out.ok).toBe(true)
      expect(out.ruling).toBe(`FJS-D${before}`)

      const dec = readFileSync(join(root, 'DECISIONS.md'), 'utf8')
      const [, afterHeading] = dec.split('## Naming & vocabulary\n\n')
      // Newest first: directly under the heading, above the older ruling.
      expect(afterHeading.startsWith(`### <a id="fjs-d${before}"></a>2026-09-14 · \`FJS-D${before}\` — `)).toBe(true)
      expect(dec).toContain("The paper's recommendation, taken as written: a view that leaks nothing is what a caller expects.")

      const paper = readFileSync(join(root, 'IDEAS', 'views.md'), 'utf8')
      expect(paper).toContain(`- ~~**Omit encrypted columns, or expose them?**~~ **Answered 2026-09-14 (\`FJS-D${before}\`): A — omit them, and report the omission.** Decryption`)

      expect(readDecisions(root).find(q => q.id === ID).state).toBe('ruled')
      expect(runRegisterCheck({ root, today: TODAY }).errors).toEqual([])
    } finally { cleanup() }
  })

  test('the next id is past every one issued anywhere, a paper included', () => {
    const { root, cleanup } = fixture()
    try {
      writeFileSync(join(root, 'IDEAS', 'reserved.md'), '---\nid: reserved\nstatus: proposed\n---\n\n# Reserves FJS-D40\n')
      expect(nextDecisionNumber(root)).toBe(41)
    } finally { cleanup() }
  })

  test('a pick against the recommendation is refused without a reason, and taken with one', () => {
    const { root, cleanup } = fixture()
    try {
      const bare = decide({ root, id: ID, pick: 'B', section: 'Naming & vocabulary', today: TODAY })
      expect(bare.ok).toBe(false)
      expect(bare.reason).toMatch(/not the recommendation/)
      expect(readFileSync(join(root, 'IDEAS', 'views.md'), 'utf8')).not.toContain('Answered 2026-09-14')

      const argued = decide({ root, id: ID, pick: 'B', why: 'an operator\nreads ciphertext\n### on purpose', section: 'Naming & vocabulary', today: TODAY })
      expect(argued.ok).toBe(true)
      // A reason is one paragraph; a newline in it cannot open a heading.
      expect(readFileSync(join(root, 'DECISIONS.md'), 'utf8')).toContain('\nan operator reads ciphertext ### on purpose.\n')
    } finally { cleanup() }
  })

  test('every other refusal leaves both files untouched', () => {
    const { root, cleanup } = fixture()
    try {
      const snapshot = () => [readFileSync(join(root, 'DECISIONS.md'), 'utf8'), readFileSync(join(root, 'IDEAS', 'views.md'), 'utf8')]
      const was = snapshot()
      const refusals = [
        [{ id: 'views:nope', pick: 'A', section: 'Naming & vocabulary' },                     /no question has the id/],
        [{ id: 'views:does-the-cache-key-grow', pick: 'A', section: 'Naming & vocabulary' }, /no options to pick from/],
        [{ id: 'views:is-this-a-view-at-all', pick: 'A', section: 'Naming & vocabulary' },   /already ruled/],
        [{ id: ID, pick: 'C', section: 'Naming & vocabulary' },                               /offers A, B, not C/],
        [{ id: ID, pick: 'A', section: 'Open (discussed, not yet ruled)' },                   /no section named/],
      ]
      for (const [args, reason] of refusals) {
        const out = decide({ root, today: TODAY, ...args })
        expect(out.ok).toBe(false)
        expect(out.reason).toMatch(reason)
      }
      expect(snapshot()).toEqual(was)
    } finally { cleanup() }
  })

  test('a write register:check refuses is put back', () => {
    // The question cites an id nothing issued. Standing in the paper it is the
    // paper's own finding; copied into a ruling it is a NEW one, in a new file.
    const paper = [
      '---', 'id: views', 'status: proposed', '---', '', '## Open questions', '',
      '- **Does FJS-D999 still apply?** Cited by nobody.',
      '  - **A** — yes', '  - **B** — no', '  - **Recommend A** — it does',
      '',
    ].join('\n')
    const { root, cleanup } = fixture({ paper })
    try {
      const was = [readFileSync(join(root, 'DECISIONS.md'), 'utf8'), readFileSync(join(root, 'IDEAS', 'views.md'), 'utf8')]
      const out = decide({ root, id: 'views:does-fjs-d999-still-apply', pick: 'A', section: 'Naming & vocabulary', today: TODAY })
      expect(out.ok).toBe(false)
      expect(out.reason).toMatch(/put back/)
      expect([readFileSync(join(root, 'DECISIONS.md'), 'utf8'), readFileSync(join(root, 'IDEAS', 'views.md'), 'utf8')]).toEqual(was)
    } finally { cleanup() }
  })
})

// ─── over this repo ───────────────────────────────────────────────────────────

describe('over this repo', () => {

  test('every heading a paper gives its open questions is one the reader matches', () => {
    // A paper arguing its questions under a heading the reader skips drops out
    // of the queue with nothing said. A heading RECORDING what the questions
    // became holds answers, and is named here rather than matched.
    const answers = new Set(['## What the open questions became'])
    const missed  = []
    for (const name of readdirSync(join(REPO, 'IDEAS')).filter(n => n.endsWith('.md'))) {
      readFileSync(join(REPO, 'IDEAS', name), 'utf8').split('\n').forEach((line, i) => {
        if (answers.has(line.trim())) return
        if (/^##\s/.test(line) && /\bopen questions?\b/i.test(line) && !QUESTIONS_HEADING.test(line)) {
          missed.push(`IDEAS/${name}:${i + 1} ${line}`)
        }
      })
    }
    expect(missed).toEqual([])
  })

  test('the queue is read, and it is not empty', () => {
    const { decidable, open, ruled } = openDecisions(REPO)
    expect(decidable.length + open.length).toBeGreaterThan(50)
    expect(ruled).toBeGreaterThan(0)
  })
})
