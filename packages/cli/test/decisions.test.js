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
import { spawn }         from 'child_process'

import { readDecisions, openDecisions, rulingSections, QUESTIONS_HEADING } from '../core/decisions.js'
import { decide, settle, nextDecisionNumber } from '../core/decide.js'
import { runRegisterCheck }           from '../core/register-check.js'

// Every fixture declares the prefix its rows are written under.
const DECLARED = JSON.stringify({ registers: { prefix: 'FJS' } })

const REPO  = fileURLToPath(new URL('../../..', import.meta.url))
const TODAY = new Date('2026-09-14T12:00:00')

function fixture({ paper } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fli-decisions-'))
  writeFileSync(join(root, 'package.json'), DECLARED)
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
      expect(q.recommend).toEqual({ letter: 'A', qualifier: null, why: 'a view that leaks nothing is what a caller expects' })
    } finally { cleanup() }
  })

  test('a recommendation saying more than its letter keeps the letter and the qualifier, and leaves the option above it alone', () => {
    const paper = [
      '---', 'id: views', 'status: proposed', '---', '', '## Open questions', '',
      '- **Hook the bulk writes?** Prose.',
      '  - **A** — fire the hook per row, inside the transaction',
      '  - **B** — own the tree', '  - **C** — neither',
      "  - **Recommend A's first half now, B after Q1 is measured** — a bulk write no hook hears is a defect",
      '- **Which one?** Prose.',
      '  - **A** — this', '  - **B** — that',
      '  - **Recommend B.** The full stop is inside the bold.',
      '- **Which variant?** Prose.',
      '  - **A** — this', '  - **C** — that, spelled **C1** or **C2**',
      '  - **Recommend C1.** C, spelled the first way.',
      '',
    ].join('\n')
    const { root, cleanup } = fixture({ paper })
    try {
      const [hook, which, variant] = readDecisions(root).filter(q => q.paper?.id === 'views')
      expect(hook.recommend).toEqual({ letter: 'A', qualifier: "A's first half now, B after Q1 is measured", why: 'a bulk write no hook hears is a defect' })
      expect(hook.options.find(o => o.letter === 'C').text).toBe('neither')
      expect(which.recommend).toEqual({ letter: 'B', qualifier: null, why: 'The full stop is inside the bold.' })
      expect(variant.recommend).toEqual({ letter: 'C', qualifier: 'C1', why: 'C, spelled the first way.' })
      expect(runRegisterCheck({ root, today: TODAY }).errors).toEqual([])
    } finally { cleanup() }
  })

  test('a recommendation line naming no option is an error, not text on the option above it', () => {
    const paper = [
      '---', 'id: views', 'status: proposed', '---', '', '## Open questions', '',
      '- **Hook the bulk writes?** Prose.',
      '  - **A** — yes', '  - **B** — no',
      '  - **Recommend neither yet** — measure first',
      '',
    ].join('\n')
    const { root, cleanup } = fixture({ paper })
    try {
      const q = readDecisions(root).find(d => d.paper?.id === 'views')
      expect(q.recommend).toBe(null)
      expect(q.options.find(o => o.letter === 'B').text).toBe('no')
      const found = runRegisterCheck({ root, today: TODAY }).errors.filter(f => f.rule === 'unread-recommendation')
      expect(found.map(f => [f.file, f.line])).toEqual([['IDEAS/views.md', 11]])
    } finally { cleanup() }
  })

  test('the prose after the question is its body, the lead left out', () => {
    const { root, cleanup } = fixture()
    try {
      const byId = Object.fromEntries(readDecisions(root).map(q => [q.id, q]))
      expect(byId['views:omit-encrypted-columns-or-expose-them'].body).toBe('Decryption is above SQLite.')
      expect(byId['views:does-the-cache-key-grow'].body).toBe('Nobody has measured it.')
      expect(byId['FJS-D07'].body).toBe('')
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

  test('a paper that shipped still queues the question it left open', () => {
    const { root, cleanup } = fixture()
    try {
      mkdirSync(join(root, 'IDEAS', 'shipped'))
      writeFileSync(join(root, 'IDEAS', 'shipped', 'built.md'), [
        '---', 'id: built', 'status: shipped', '---', '', '## Open questions', '',
        '- **Keyed per parent row too?** Built without it.',
        '  - **A** — no', '  - **B** — yes', '  - **Recommend B** — both sightings need it', '',
      ].join('\n'))
      const q = readDecisions(root).find(d => d.paper?.id === 'built')
      expect(q.state).toBe('decidable')
      expect(q.file).toBe(join('IDEAS', 'shipped', 'built.md'))
    } finally { cleanup() }
  })

  test('a bullet under any other heading is not a question', () => {
    const { root, cleanup } = fixture()
    try {
      expect(readDecisions(root).some(q => /Not a question/.test(q.question))).toBe(false)
    } finally { cleanup() }
  })

  test('a row a live bullet names is that bullet, and a ruled bullet hands the row back', () => {
    // The pair: dropping every issue row would also satisfy the first half.
    const paper = (lead) => [
      '---', 'id: thing', 'status: proposed', '---', '', '## Open questions', '',
      `- ${lead} Argued here.`,
      '  - **A** — yes', '  - **B** — no', '  - **Recommend A** — because', '',
    ].join('\n')

    const live = fixture({ paper: paper('**Should the thing be a thing? (`FJS-D07`)**') })
    try {
      const qs = readDecisions(live.root)
      expect(qs.some(q => q.id === 'FJS-D07')).toBe(false)
      expect(qs.find(q => q.question.includes('FJS-D07')).state).toBe('decidable')
    } finally { live.cleanup() }

    const ruled = fixture({ paper: paper('~~**Should the thing be a thing? (`FJS-D07`)**~~ **Answered 2026-09-14 (`FJS-D03`): A.**') })
    try {
      expect(readDecisions(ruled.root).find(q => q.id === 'FJS-D07')?.state).toBe('open')
    } finally { ruled.cleanup() }
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

  test('a question with no bold lead is struck by the sentence the reader queued it by', () => {
    const paper = [
      '---', 'id: views', 'status: proposed', '---', '', '## Open questions', '',
      '- Does the cache key grow with the view set? Nobody has',
      '  measured it.',
      '  - **A** — no', '  - **B** — yes', '  - **Recommend A** — the key is the name',
      '',
    ].join('\n')
    const { root, cleanup } = fixture({ paper })
    try {
      const id  = 'views:does-the-cache-key-grow-with-the-view-set'
      const out = decide({ root, id, pick: 'A', section: 'Naming & vocabulary', today: TODAY })
      expect(out.ok).toBe(true)
      expect(readFileSync(join(root, 'IDEAS', 'views.md'), 'utf8')).toContain(
        `- ~~**Does the cache key grow with the view set?**~~ **Answered 2026-09-14 (\`${out.ruling}\`): A — no.** Nobody has\n`)
      expect(readDecisions(root).filter(q => q.paper?.id === 'views').map(q => q.state)).toEqual(['ruled'])
    } finally { cleanup() }
  })

  test('a question that wraps is queued whole, and ruling it strikes the whole lead (FJS-2160)', () => {
    const paper = [
      '---', 'id: views', 'status: proposed', '---', '', '## Open questions', '',
      '- Does the cache key grow with the view set or only with',
      '  the number of tenants? Nobody has measured it.',
      '  - **A** — no', '  - **B** — yes', '  - **Recommend A** — the key is the name',
      '- **Where does the parse happen — the connector, or',
      '  one shared parser?** Argued below.',
      '  - **A** — connector', '  - **B** — shared',
      '',
    ].join('\n')
    const { root, cleanup } = fixture({ paper })
    try {
      const [plain, bold] = readDecisions(root).filter(q => q.paper?.id === 'views')
      expect(plain.question).toBe('Does the cache key grow with the view set or only with the number of tenants?')
      expect(plain.body).toBe('Nobody has measured it.')
      expect(bold.question).toBe('Where does the parse happen — the connector, or one shared parser?')
      expect(bold.body).toBe('Argued below.')
      expect(bold.options.map(o => o.letter)).toEqual(['A', 'B'])

      const out = decide({ root, id: plain.id, pick: 'A', section: 'Naming & vocabulary', today: TODAY })
      expect(out.ok).toBe(true)
      expect(readFileSync(join(root, 'IDEAS', 'views.md'), 'utf8')).toContain(
        `- ~~**${plain.question}**~~ **Answered 2026-09-14 (\`${out.ruling}\`): A — no.** Nobody has measured it.\n`)
      const out2 = decide({ root, id: bold.id, pick: 'B', why: 'one parser', section: 'Naming & vocabulary', today: TODAY })
      expect(out2.ok).toBe(true)
      expect(readDecisions(root).filter(q => q.paper?.id === 'views').map(q => q.state)).toEqual(['ruled', 'ruled'])
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

  test('a pick of a qualified recommendation says what it rules, and the ruling keeps the qualifier', () => {
    const paper = [
      '---', 'id: views', 'status: proposed', '---', '', '## Open questions', '',
      '- **Hook the bulk writes?** Prose.',
      '  - **A** — fire the hook per row, inside the transaction',
      '  - **B** — own the tree',
      "  - **Recommend A's first half now** — a bulk write no hook hears is a defect",
      '',
    ].join('\n')
    const { root, cleanup } = fixture({ paper })
    try {
      const id   = 'views:hook-the-bulk-writes'
      const bare = decide({ root, id, pick: 'A', section: 'Naming & vocabulary', today: TODAY })
      expect(bare.ok).toBe(false)
      expect(bare.reason).toMatch(/A's first half now/)
      expect(bare.reason).toMatch(/not A whole/)

      const out = decide({ root, id, pick: 'A', why: 'per row now; the in-transaction timing waits', section: 'Naming & vocabulary', today: TODAY })
      expect(out.ok).toBe(true)
      const dec = readFileSync(join(root, 'DECISIONS.md'), 'utf8')
      expect(dec).toContain(`\`${out.ruling}\` — Hook the bulk writes — A's first half now.`)
      expect(dec).not.toContain('— Fire the hook per row, inside the transaction.')
      expect(dec).toContain("**A** was picked as the recommendation qualifies it (*A's first half now*) over **B** (own the tree).")
      expect(dec).toContain('\nper row now; the in-transaction timing waits.\n')
      expect(readFileSync(join(root, 'IDEAS', 'views.md'), 'utf8')).toContain(`(\`${out.ruling}\`): A's first half now.**`)
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

// ─── a plan outside IDEAS ─────────────────────────────────────────────────────

describe('a question argued in one named file', () => {
  const PLAN = [
    '# Plan', '', '### Phase 1 — Mail', '', '- [ ] 1.1 Send it', '',
    '## Open questions (owner)', '',
    '- **Q1 — Which mail provider?** Prose.', '  - **A** — a sink', '  - **B** — a real one', '  - **Recommend A** — nothing sends yet',
    '- **Q2 — Is the key the name?** Asked.', '  - **A** — yes', '  - **B** — no', '  - **Recommend A** — FJS-D03 already rules it',
    '',
  ].join('\n')
  const Q1 = 'PLAN:q1-which-mail-provider'

  test('a PLAN.md question is no register source, and is ruled with file: at the id parsePlan gives it', async () => {
    const { parsePlan } = await import('../core/plan.js')
    const { root, cleanup } = fixture()
    try {
      writeFileSync(join(root, 'PLAN.md'), PLAN)
      expect(parsePlan(PLAN, { file: 'PLAN.md' }).blocking.map(q => q.id)).toEqual([Q1, 'PLAN:q2-is-the-key-the-name'])
      expect(decide({ root, id: Q1, pick: 'A', section: 'Naming & vocabulary', today: TODAY }).reason).toBe(`no question has the id ${Q1}`)

      const out = decide({ root, id: Q1, pick: 'A', section: 'Naming & vocabulary', file: 'PLAN.md', today: TODAY })
      expect(out.ok).toBe(true)
      expect(out.files).toEqual(['DECISIONS.md', 'PLAN.md'])
      const plan = readFileSync(join(root, 'PLAN.md'), 'utf8')
      expect(plan).toContain(`- ~~**Q1 — Which mail provider?**~~ **Answered 2026-09-14 (\`${out.ruling}\`): A — a sink.** Prose.`)
      expect(readFileSync(join(root, 'DECISIONS.md'), 'utf8')).toContain('Asked in [`PLAN.md`](PLAN.md) § Open questions.')
      expect(parsePlan(plan, { file: 'PLAN.md' }).blocking.map(q => q.id)).toEqual(['PLAN:q2-is-the-key-the-name'])
      expect(runRegisterCheck({ root, today: TODAY }).errors).toEqual([])

      const settled = settle({ root, id: 'PLAN:q2-is-the-key-the-name', by: 'FJS-D03', file: 'PLAN.md', today: TODAY })
      expect(settled).toMatchObject({ ok: true, ruling: 'FJS-D03', files: ['PLAN.md'] })
      expect(parsePlan(readFileSync(join(root, 'PLAN.md'), 'utf8'), { file: 'PLAN.md' }).blocking).toEqual([])
    } finally { cleanup() }
  })

  test('a file outside the root, not markdown, or absent is refused and nothing is written', () => {
    const { root, cleanup } = fixture()
    try {
      writeFileSync(join(root, 'PLAN.md'), PLAN)
      const dec = readFileSync(join(root, 'DECISIONS.md'), 'utf8')
      for (const [file, reason] of [['../PLAN.md', /not a markdown file inside/], ['package.json', /not a markdown file inside/], ['NOPE.md', /there is no NOPE\.md/], ['PLAN.md', /no question has the id PLAN:nope in PLAN\.md/]]) {
        const id = file === 'PLAN.md' ? 'PLAN:nope' : Q1
        expect(decide({ root, id, pick: 'A', section: 'Naming & vocabulary', file, today: TODAY }).reason).toMatch(reason)
      }
      expect(readFileSync(join(root, 'DECISIONS.md'), 'utf8')).toBe(dec)
      expect(readFileSync(join(root, 'PLAN.md'), 'utf8')).toBe(PLAN)
    } finally { cleanup() }
  })
})

// ─── settled by an existing ruling ────────────────────────────────────────────

describe('the settle', () => {
  const OPEN = 'views:does-the-cache-key-grow'
  const read = (root) => [readFileSync(join(root, 'DECISIONS.md'), 'utf8'), readFileSync(join(root, 'IDEAS', 'views.md'), 'utf8')]

  // Two retired rulings beside the live one, written the way `declaredStatus` reads them.
  const retire = (root) => writeFileSync(join(root, 'DECISIONS.md'), read(root)[0].replace('## Open (discussed', [
    '### <a id="fjs-d04"></a>2026-08-02 · `FJS-D04` — replaced.', '', '**Status:** superseded-by `FJS-D03`', '',
    '### <a id="fjs-d05"></a>2026-08-03 · `FJS-D05` — taken back.', '', '**Status:** withdrawn', '',
    '## Open (discussed',
  ].join('\n')))

  test('an open question is struck citing the ruling, and DECISIONS.md is not written', () => {
    const { root, cleanup } = fixture()
    try {
      const [dec] = read(root)
      const next  = nextDecisionNumber(root)
      const out   = settle({ root, id: OPEN, by: 'fjs-d03', why: 'the key is the view name, which D03 fixes', today: TODAY })
      expect(out.ok).toBe(true)
      expect(out.ruling).toBe('FJS-D03')
      expect(out.files).toEqual(['IDEAS/views.md'])

      const [decAfter, paper] = read(root)
      expect(decAfter).toBe(dec)
      expect(nextDecisionNumber(root)).toBe(next)
      expect(paper).toContain('- ~~**Does the cache key grow?**~~ **Answered 2026-09-14 (`FJS-D03`): the key is the view name, which D03 fixes.** Nobody')
      expect(readDecisions(root).find(q => q.id === OPEN).state).toBe('ruled')
      expect(runRegisterCheck({ root, today: TODAY }).errors).toEqual([])
    } finally { cleanup() }
  })

  test('a recommendation naming the ruling is the reason, and one that does not is not', () => {
    const paper = [
      '---', 'id: views', 'status: proposed', '---', '', '## Open questions', '',
      '- **Is a view a model?** Asked twice.',
      '  - **A** — no', '  - **B** — yes', '  - **Recommend A** — FJS-D03 already rules a view is not a model',
      '- **Is a view cached?** Asked once.',
      '  - **A** — no', '  - **B** — yes', '  - **Recommend A** — nothing reads it twice',
      '',
    ].join('\n')
    const { root, cleanup } = fixture({ paper })
    try {
      const out = settle({ root, id: 'views:is-a-view-a-model', by: 'FJS-D03', today: TODAY })
      expect(out.ok).toBe(true)
      expect(read(root)[1]).toContain('**Answered 2026-09-14 (`FJS-D03`): FJS-D03 already rules a view is not a model.**')

      const bare = settle({ root, id: 'views:is-a-view-cached', by: 'FJS-D03', today: TODAY })
      expect(bare.ok).toBe(false)
      expect(bare.reason).toMatch(/does not name FJS-D03, so --why/)
    } finally { cleanup() }
  })

  test('every refusal leaves both files untouched', () => {
    const { root, cleanup } = fixture()
    try {
      retire(root)
      const was = read(root)
      const refusals = [
        [{ id: 'views:nope', by: 'FJS-D03', why: 'x' },                   /no question has the id/],
        [{ id: 'views:is-this-a-view-at-all', by: 'FJS-D03', why: 'x' },  /already ruled/],
        [{ id: OPEN, by: 'FJS-D99', why: 'x' },                           /no ruling FJS-D99/],
        [{ id: OPEN, by: '', why: 'x' },                                  /no ruling \(none named\)/],
        [{ id: OPEN, by: 'FJS-D05', why: 'x' },                           /withdrawn/],
        [{ id: OPEN, by: 'FJS-D04', why: 'x' },                           /superseded by FJS-D03 — settle by that one/],
        [{ id: OPEN, by: 'FJS-D03' },                                     /--why has to say/],
      ]
      for (const [args, reason] of refusals) {
        const out = settle({ root, today: TODAY, ...args })
        expect(out.ok).toBe(false)
        expect(out.reason).toMatch(reason)
      }
      expect(read(root)).toEqual(was)
    } finally { cleanup() }
  })
})

// ─── several processes at once ────────────────────────────────────────────────

// FJS-3003: `--dry` is on every command, and a dry ruling writes the files it was asked not to.
describe('ruling and settling dry', () => {
  const snapshot = (root) => [readFileSync(join(root, 'DECISIONS.md'), 'utf8'), readFileSync(join(root, 'IDEAS', 'views.md'), 'utf8')]

  test('decide answers the ruling it would write and writes nothing', () => {
    const { root, cleanup } = fixture()
    try {
      const before = snapshot(root)
      const next   = nextDecisionNumber(root)
      const out    = decide({ root, id: 'views:omit-encrypted-columns-or-expose-them', pick: 'a', section: 'Naming & vocabulary', dry: true, today: TODAY })
      expect(out).toMatchObject({ ok: true, dry: true, ruling: `FJS-D${next}` })
      expect(snapshot(root)).toEqual(before)
    } finally { cleanup() }
  })

  test('settle answers the ruling it would cite and writes nothing', () => {
    const { root, cleanup } = fixture()
    try {
      const before = snapshot(root)
      const out    = settle({ root, id: 'views:does-the-cache-key-grow', by: 'FJS-D03', why: 'the key is the view name', dry: true, today: TODAY })
      expect(out).toMatchObject({ ok: true, dry: true, ruling: 'FJS-D03' })
      expect(snapshot(root)).toEqual(before)
    } finally { cleanup() }
  })

})

describe('ruling from several processes at once', () => {
  // `fli decide` in a terminal and basecamp's screen are two processes writing
  // one DECISIONS.md: unguarded, both read the same next id and the second write
  // drops the first ruling.
  test('every ruling lands, each under its own id', async () => {
    const asked = [1, 2, 3, 4].flatMap(n => [
      `- **Question ${n}?** Argued.`,
      '  - **A** — yes',
      '  - **B** — no',
      '  - **Recommend A** — it is',
    ])
    const { root, cleanup } = fixture({ paper: ['---', 'id: race', 'status: proposed', '---', '', '## Open questions', '', ...asked, ''].join('\n') })
    try {
      const module = join(import.meta.dir, '..', 'core', 'decide.js')
      const script = `const { decide } = await import(${JSON.stringify(module)}); const out = decide({ root: ${JSON.stringify(root)}, id: 'race:question-' + process.argv[1], pick: 'A', section: 'Naming & vocabulary' }); if (!out.ok) { console.error(out.reason); process.exit(1) }`
      const codes = await Promise.all([1, 2, 3, 4].map(n => new Promise(done =>
        spawn(process.execPath, ['-e', script, String(n)], { stdio: 'ignore' }).on('close', done))))
      expect(codes).toEqual([0, 0, 0, 0])

      const ids = [...readFileSync(join(root, 'DECISIONS.md'), 'utf8').matchAll(/^### .*?`(FJS-D\d+)` — Question \d/gm)].map(m => m[1])
      expect(ids.length).toBe(4)
      expect(new Set(ids).size).toBe(4)
      expect(readDecisions(root).filter(q => q.id.startsWith('race:')).every(q => q.state === 'ruled')).toBe(true)
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
    for (const dir of ['IDEAS', join('IDEAS', 'shipped')]) {
      for (const name of readdirSync(join(REPO, dir)).filter(n => n.endsWith('.md'))) {
        readFileSync(join(REPO, dir, name), 'utf8').split('\n').forEach((line, i) => {
          if (answers.has(line.trim())) return
          if (/^##\s/.test(line) && /\bopen questions?\b/i.test(line) && !QUESTIONS_HEADING.test(line)) {
            missed.push(`${dir}/${name}:${i + 1} ${line}`)
          }
        })
      }
    }
    expect(missed).toEqual([])
  })

  test('the queue is read, and it is not empty', () => {
    const { decidable, open, ruled } = openDecisions(REPO)
    expect(decidable.length + open.length).toBeGreaterThan(50)
    expect(ruled).toBeGreaterThan(0)
  })
})
