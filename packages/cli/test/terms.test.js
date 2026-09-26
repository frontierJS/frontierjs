// terms.test.js — the vocabulary scan, over a fixture and over this repo.
//
// Every failure this module can have is SILENT. A reader that stops matching
// ARCHITECT.md's table reports an empty doctrine and every term as unnamed; a
// classifier that stops firing reports `Vite` as a concept; a plural that stops
// folding splits one term into two and halves its spread. None of those throw,
// and all of them look like a finding rather than a bug — so each is asserted
// against text whose right answer is written out beside it.
//
// The repo pass is here for the same reason `decisions.test.js` has one: a
// fixture proves the parse, and only the real files prove the parse still
// matches what this repo writes.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join }          from 'path'
import { tmpdir }        from 'os'
import { fileURLToPath } from 'url'

import { collectTerms, architectVocabulary, authoredVocabulary, packageVocabularies, placed, renderPage } from '../core/terms.js'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))

function fixture(docs = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fli-terms-'))
  mkdirSync(join(root, 'packages', 'alpha'), { recursive: true })
  mkdirSync(join(root, 'packages', 'beta'),  { recursive: true })

  writeFileSync(join(root, 'ARCHITECT.md'), [
    '## 2. Vocabulary — Non-Negotiable',
    '',
    '| Use | Not |',
    '| --- | --- |',
    '| **Widget** | gadget, doohickey |',
    '| **Gate ladder** | roles |',
    '',
    '- **Signal** is the reactive cell.',
    '',
    '### Not yet named',
    '',
    '- **Envelope** for the result shape.',
    '',
    '## 3. Next',
  ].join('\n'))

  for (const [rel, text] of Object.entries(docs)) {
    writeFileSync(join(root, rel), text)
  }
  return root
}

describe('ARCHITECT.md § 2', () => {
  test('both columns, the clarifications and the unnamed are read apart', () => {
    const root = fixture()
    const vocab = architectVocabulary(root)

    expect(vocab.found).toBe(true)
    expect(vocab.blessed).toEqual(['Widget', 'Gate ladder'])
    expect(vocab.forbidden).toEqual(['gadget', 'doohickey', 'roles'])
    expect(vocab.clarified).toEqual(['Signal'])
    expect(vocab.notYetNamed).toEqual(['Envelope'])
    rmSync(root, { recursive: true, force: true })
  })

  test('a repo with no ARCHITECT.md answers empty rather than throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-terms-bare-'))
    expect(architectVocabulary(root).found).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('the prose scan', () => {
  test('a term is counted mid-sentence and not at a sentence start', () => {
    const root = fixture({
      'a.md': 'The Widget is a thing. Widget starts this one.',
    })
    const { concepts } = collectTerms({ root })
    const widget = concepts.find(r => r.term === 'Widget')

    // Two occurrences, one of them sentence-initial and therefore grammar.
    expect(widget.count).toBe(1)
    rmSync(root, { recursive: true, force: true })
  })

  test('a word after a dash, colon or semicolon opens a clause and is not a term', () => {
    const root = fixture({ 'a.md': 'it fails — Whether it fails loudly: Nothing says so; Because.' })
    const { concepts } = collectTerms({ root })

    expect(concepts.find(r => r.term === 'Whether')).toBeUndefined()
    expect(concepts.find(r => r.term === 'Nothing')).toBeUndefined()
    rmSync(root, { recursive: true, force: true })
  })

  test('code spans, fences and link targets are not prose', () => {
    const root = fixture({
      'a.md': [
        'a call to `createWidget` and a [link](packages/Widget/index.js).',
        '',
        '```js',
        'const Widget = 1',
        '```',
      ].join('\n'),
    })
    const { concepts } = collectTerms({ root })
    expect(concepts.find(r => r.term === 'Widget')).toBeUndefined()
    rmSync(root, { recursive: true, force: true })
  })

  test('SHOUTED emphasis is not vocabulary', () => {
    const root = fixture({ 'a.md': 'this is NEVER a term.' })
    const { concepts } = collectTerms({ root })
    expect(concepts.find(r => r.term === 'NEVER')).toBeUndefined()
    rmSync(root, { recursive: true, force: true })
  })

  test('a generated snapshot is not corpus — it is the repo quoting itself', () => {
    const root = fixture({ 'a.snapshot.md': 'the Widget and the Widget and the Widget.' })
    const { concepts } = collectTerms({ root })
    expect(concepts.find(r => r.term === 'Widget')).toBeUndefined()
    rmSync(root, { recursive: true, force: true })
  })
})

describe('an identifier is not a coined word', () => {
  test('a Mesa component is an api identifier, and the condition it renders is the term', () => {
    const model = collectTerms({ root: REPO })
    const classOf = t => model.concepts.find(r => r.term === t)?.class

    // The FILE is the declaration for a component — nothing writes it as an
    // export — so without that pass these reach the prose scan looking coined.
    expect(model.api.find(r => r.term === 'EmptyState')?.owners).toContain('ui')
    expect(classOf('EmptyState')).toBe('api')
    expect(classOf('StatCard')).toBe('api')

    // `Empty state` is the condition a screen is in; `EmptyState` renders it.
    const term = model.concepts.find(r => r.term === 'Empty state')
    expect(term.spread).toBeGreaterThan(3)
    expect(term.label).toBeTruthy()
  })

  test('a one-word identifier stays a concept, because it is also English', () => {
    const model = collectTerms({ root: REPO })
    const classOf = t => model.concepts.find(r => r.term === t)?.class

    // § 2 rules two of these, and a compound is what separates a name somebody
    // typed from a word somebody coined.
    for (const term of ['Plugin', 'Channel', 'Store']) {
      expect(classOf(term)).toBe('concept')
    }
  })
})

describe('somebody else\'s nouns', () => {
  test('a product, a person and a place are external, so the concepts tab is this framework\'s', () => {
    const model = collectTerms({ root: REPO })
    const classOf = term => model.concepts.find(r => r.term === term)?.class

    // Every one of these read as a concept of this framework until it was
    // named: a web server, a meta-framework, the author of cron, an ORM, a
    // vendor, an orchestrator, a citation and a time zone.
    for (const term of ['Apache', 'SvelteKit', 'Vixie', 'Kysely', 'Shopify', 'Kubernetes', 'Fowler', 'Berlin']) {
      expect(classOf(term)).toBe('external')
    }
    // And the blessed vocabulary is untouched by the sweep.
    for (const term of ['Resource', 'Release', 'Service', 'Gate', 'Signal', 'Realm']) {
      expect(classOf(term)).toBe('concept')
    }
  })
})

describe('dropped English', () => {
  test('a stop word and its plural are gone from every class, not classed out', () => {
    const root = fixture({ 'a.md': 'we keep the Everything and the Requests and the Widget.' })
    const model = collectTerms({ root })

    // Classed out is a row somebody reads past; these are removed before the
    // classifier, so the only place they may appear is the dropped count.
    for (const term of ['Everything', 'Requests']) {
      expect(model.concepts.find(r => r.term === term)).toBeUndefined()
    }
    expect(model.concepts.find(r => r.term === 'Widget')).toBeDefined()
    expect(model.counts.dropped).toBe(2)
    expect(model.counts.droppedHits).toBe(2)
    rmSync(root, { recursive: true, force: true })
  })

  test('a word § 2 rules is never dropped, whatever else the list holds', () => {
    const model = collectTerms({ root: REPO })
    const status = term => model.concepts.find(r => r.term === term)?.status

    // Dropping a BLESSED word hides dead doctrine, and dropping a FORBIDDEN one
    // takes the drift column with it — the two audits that read this table.
    for (const term of ['Context', 'Event', 'Signal', 'Target']) {
      expect(status(term)).toBe('blessed')
    }
    for (const term of ['State', 'Store', 'Flow', 'Payload', 'Pipeline']) {
      expect(model.concepts.find(r => r.term === term)).toBeDefined()
    }
    // And generic programming English is gone.
    for (const term of ['Async', 'Await', 'Variable', 'Method', 'Interface']) {
      expect(model.concepts.find(r => r.term === term)).toBeUndefined()
    }
  })

  test('the drop is reported rather than silent, so a list eating a term is findable', () => {
    const model = collectTerms({ root: REPO })
    expect(model.counts.dropped).toBeGreaterThan(50)
    expect(model.counts.droppedHits).toBeGreaterThan(model.counts.dropped)
  })
})

describe('phrases', () => {
  test('a multiword term is scanned and lands in the table beside the words', () => {
    const root = fixture({
      'packages/alpha/a.md': 'the Gate ladder here, and the Gate ladder again.',
      'packages/beta/b.md':  'a Gate ladder there.',
    })
    const ladder = collectTerms({ root }).concepts.find(r => r.term === 'Gate ladder')

    expect(ladder.count).toBe(3)
    expect(ladder.spread).toBe(2)
    expect(ladder.status).toBe('blessed')
    expect(ladder.class).toBe('concept')
    rmSync(root, { recursive: true, force: true })
  })

  test('VOCABULARY.md may name one too, so a phrase is not § 2\'s alone', () => {
    const root = fixture({ 'packages/alpha/a.md': 'the Data realm and the Data realm.' })
    writeFileSync(join(root, 'VOCABULARY.md'), [
      '| Term | Status | Means | Note |',
      '| --- | --- | --- | --- |',
      '| Data realm | blessed | the first of the three |  |',
    ].join('\n'))

    const row = collectTerms({ root }).concepts.find(r => r.term === 'Data realm')
    expect(row.count).toBe(2)
    expect(row.label.means).toBe('the first of the three')
    rmSync(root, { recursive: true, force: true })
  })

  test('naming a phrase takes it off the candidate list and puts it in the table', () => {
    const model = collectTerms({ root: REPO })
    const named = t => model.concepts.find(r => r.term === t)

    // `data` alone is 19 packages of nothing anybody could define; the terms
    // under it are these two, so they are rows and the bare word is dropped.
    expect(named('Data realm').count).toBeGreaterThan(50)
    expect(named('Data boundary').count).toBeGreaterThan(300)
    expect(named('Data')).toBeUndefined()
    expect(model.audit.phraseCandidates.map(r => r.term)).not.toContain('Data realm')
  })

  test('a definition the scan cannot match is reported, not left to rot', () => {
    const root = fixture({ 'a.md': 'the Widget here.' })
    writeFileSync(join(root, 'VOCABULARY.md'), [
      '| Term | Status | Means | Note |',
      '| --- | --- | --- | --- |',
      '| Widget | blessed | the thing itself |  |',
      '| Async | refused | say nothing, it is generic |  |',
    ].join('\n'))

    // `async` is on the drop list, so its row defines a word nothing measures —
    // the failure authored-plus-generated exists to make impossible.
    const orphans = collectTerms({ root }).audit.definedUnseen
    expect(orphans.map(r => r.term)).toEqual(['Async'])
    rmSync(root, { recursive: true, force: true })
  })

  test('candidates are proposed from the prose, and a sentence is not one', () => {
    const { audit } = collectTerms({ root: REPO })
    const terms = audit.phraseCandidates.map(r => r.term)

    expect(terms).toContain('Litestone client')
    expect(terms).toContain('Junction app')
    // A participle in front or a verb behind is a sentence wearing a term's
    // clothes, which is most of what an unfiltered pair scan answers.
    expect(terms.some(t => /\b(emits|injects|answers)$/.test(t))).toBe(false)
    // Named already — a candidate list holding what is settled is noise.
    expect(terms).not.toContain('Gate ladder')
  })
})

describe('classification', () => {
  test('a tool, a package name and ordinary English are classed, never dropped', () => {
    const root = fixture({
      'packages/alpha/a.md': 'we run the Vite build, the Alpha package, and Always one of them.',
    })
    const { concepts } = collectTerms({ root })
    const classOf = term => concepts.find(r => r.term === term)?.class

    expect(classOf('Vite')).toBe('external')
    expect(classOf('Alpha')).toBe('product')
    expect(classOf('Always')).toBe('common')
    rmSync(root, { recursive: true, force: true })
  })
})

describe('plural folding', () => {
  test('a plural merges into its singular, keeping both spreads', () => {
    const root = fixture({
      'packages/alpha/a.md': 'the Widget here.',
      'packages/beta/b.md':  'the Widgets there.',
    })
    const { concepts } = collectTerms({ root })
    const widget = concepts.find(r => r.term === 'Widget')

    expect(concepts.find(r => r.term === 'Widgets')).toBeUndefined()
    expect(widget.count).toBe(2)
    expect(widget.spread).toBe(2)
    rmSync(root, { recursive: true, force: true })
  })

  test('a word merely ending in s, with no singular seen, is left alone', () => {
    const root = fixture({ 'a.md': 'the Prometheus thing and the Prometheus thing.' })
    const { concepts } = collectTerms({ root })
    expect(concepts.find(r => r.term === 'Prometheus')).toBeDefined()
    rmSync(root, { recursive: true, force: true })
  })
})

describe('VOCABULARY.md', () => {
  test('only the four statuses are rows, so the file\'s own status table is not read as terms', () => {
    const root = fixture()
    writeFileSync(join(root, 'VOCABULARY.md'), [
      '| Status | Means |',
      '| --- | --- |',
      '| `blessed` | use this word |',
      '',
      '| Term | Status | Means | Note |',
      '| --- | --- | --- | --- |',
      '| Widget | blessed | the thing itself |  |',
      '| Gadget | refused | say Widget |  |',
    ].join('\n'))

    const authored = authoredVocabulary(root)
    expect([...authored.keys()].sort()).toEqual(['gadget', 'widget'])
    expect(authored.get('widget').means).toBe('the thing itself')
    rmSync(root, { recursive: true, force: true })
  })

  test('§ 2 outranks the file, and a term § 2 does not rule takes the file\'s status', () => {
    const root = fixture({ 'a.md': 'the Widget and the Gadget.' })
    writeFileSync(join(root, 'VOCABULARY.md'), [
      '| Term | Status | Means | Note |',
      '| --- | --- | --- | --- |',
      '| Widget | refused | wrong, and § 2 says otherwise |  |',
      '| Gadget | refused | say Widget |  |',
    ].join('\n'))

    const { concepts } = collectTerms({ root })
    expect(concepts.find(r => r.term === 'Widget').status).toBe('blessed')
    expect(concepts.find(r => r.term === 'Gadget').status).toBe('refused')
    rmSync(root, { recursive: true, force: true })
  })
})

describe('sources', () => {
  test('a row carries where its count came from, so the page can drop a source', () => {
    const root = fixture({
      'packages/alpha/a.md': 'the Widget here and the Widget again.',
      'packages/beta/b.md':  'the Widget there.',
    })
    const { concepts, sources } = collectTerms({ root })
    const widget = concepts.find(r => r.term === 'Widget')

    expect(widget.byOwner).toEqual({ alpha: 2, beta: 1 })
    expect(sources.map(s => s.name)).toEqual(['alpha', 'beta'])
    rmSync(root, { recursive: true, force: true })
  })

  test('VOCABULARY.md is not its own corpus — labelling a term cannot raise its count', () => {
    const root = fixture({ 'a.md': 'the Widget here.' })
    writeFileSync(join(root, 'VOCABULARY.md'), [
      '| Term | Status | Means | Note |',
      '| --- | --- | --- | --- |',
      '| Widget | blessed | a Widget is the Widget of the Widget |  |',
    ].join('\n'))

    const { concepts } = collectTerms({ root })
    expect(concepts.find(r => r.term === 'Widget').count).toBe(1)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('the page', () => {
  test('a source is counted per lens, because the same chip means different amounts', () => {
    const model = collectTerms({ root: REPO })
    const ideas = model.sources.find(s => s.name === 'IDEAS')

    // Design records for work not started: a fifth of the prose and not one
    // source file. A single number would be wrong on two tabs out of three.
    expect(ideas.concept).toBeGreaterThan(1000)
    expect(ideas.api).toBe(0)
    expect(ideas.language).toBe(0)
  })

  test('a language word declares the package that ships it, so the toggles reach that tab', () => {
    const model = collectTerms({ root: REPO })
    const lite = model.language.filter(r => r.lens === 'lite')
    const mesa = model.language.filter(r => r.lens === 'mesa')

    expect(lite.every(r => r.owner === 'litestone')).toBe(true)
    // Every mesa-lens word but `mesa:slot`, which Sierra owns and declares.
    expect(mesa.every(r => ['mesa', 'sierra'].includes(r.owner))).toBe(true)
    expect(mesa.filter(r => r.owner === 'sierra').map(r => r.term)).toEqual(['mesa:slot'])
    expect(model.language.every(r => r.spread === 1)).toBe(true)
  })

  test('class is a column of its own, beside status, on every row', () => {
    const html = renderPage(collectTerms({ root: REPO }))
    const pane = t => html.split(`data-tab="${t}"`)[1].split('</section>')[0]

    expect(html.includes('<th>status</th><th>class</th>')).toBe(true)
    expect(pane('concept').includes('<span class="badge">concept</span>')).toBe(true)
    expect(pane('other').includes('<span class="badge">external</span>')).toBe(true)
    expect(pane('other').includes('<span class="badge">product</span>')).toBe(true)
  })

  test('the mesa namespace is DECLARED, so the compiler\'s counter-example is not a word', () => {
    const model = collectTerms({ root: REPO })
    const mesa  = model.language.filter(r => r.lens === 'mesa')

    expect(mesa.every(r => r.confidence === 'declared')).toBe(true)
    // `mesa:frobnicate` is the compiler's own example of a name that does not
    // exist and `mesa:line` is a source location — both are what a grep answers.
    for (const word of ['mesa:frobnicate', 'mesa:line']) {
      expect(mesa.find(r => r.term === word)).toBeUndefined()
    }
    for (const word of ['mesa:boundary', 'mesa:window', 'mesa:portal']) {
      expect(mesa.find(r => r.term === word)?.owner).toBe('mesa')
    }
  })

  test('the namespace has two owners — mesa:slot is Sierra\'s and is used there', () => {
    const slot = collectTerms({ root: REPO }).language.find(r => r.term === 'mesa:slot')

    // Sierra rewrites the tag away before the compiler sees it, so mesa's own
    // list cannot carry it and a reader of that list alone is short one word.
    expect(slot.owner).toBe('sierra')
    expect(slot.confidence).toBe('declared')
    // Its uses live under `src/build/`, a source directory whose NAME is on the
    // output-directory skip list — the count is what proves the walk reaches it.
    expect(slot.count).toBeGreaterThan(5)
  })

  test('the script holds no backtick — it lives inside a template literal', () => {
    const source = readFileSync(new URL('../core/terms.js', import.meta.url), 'utf8')
    const script = source.slice(source.indexOf('const SCRIPT = `') + 'const SCRIPT = `'.length)
    // One backtick closes the literal and the file stops PARSING somewhere else
    // entirely, which is the trap the root CLAUDE.md records twice.
    expect(script.slice(0, script.indexOf('\n`')).includes('`')).toBe(false)
  })

  test('every path it prints is a vscode link that resolves to a file that exists', () => {
    const model = collectTerms({ root: REPO })
    const html  = renderPage(model)
    const links = [...html.matchAll(/href="vscode:\/\/file([^"]+)"/g)].map(m => m[1])

    expect(links.length).toBeGreaterThan(100)
    // The absolute path is baked in, so a link that does not resolve is a page
    // that silently opens nothing — the one failure this cannot show on screen.
    const missing = [...new Set(links)].filter(path => !existsSync(path))
    expect(missing).toEqual([])
  })
})

// A package register, written where the declared table expects one. The reader
// is keyed on the PATH rather than on a glob, so a fixture has to put the file
// exactly where the row names it — which is the property being relied on.
function cssRegister(root, { terms = [], notATerm = {} } = {}) {
  mkdirSync(join(root, 'packages', 'css'), { recursive: true })
  writeFileSync(join(root, 'packages', 'css', 'vocabulary.json'),
    JSON.stringify({ terms, notATerm }))
}

describe('a package register', () => {
  test('a term the root file never names is named by the package that defines it', () => {
    const root = fixture({ 'packages/alpha/a.md': 'a Sprocket, another Sprocket, and a Sprocket.' })
    cssRegister(root, { terms: [{ term: 'Sprocket', element: '<span>', meaning: 'a toothed wheel' }] })

    const row = collectTerms({ root }).concepts.find(r => r.term === 'Sprocket')
    expect(row.status).toBe('blessed')
    expect(row.label.means).toBe('a toothed wheel')
    // Who named it, which is the field that only had one possible answer while
    // there was one register — and the whole of what makes the row auditable.
    expect(row.label.source).toBe('packages/css/vocabulary.json')
    rmSync(root, { recursive: true, force: true })
  })

  test('an axis is vocabulary too — Invariant 13 is written in those words', () => {
    const root = fixture({ 'packages/alpha/a.md': 'a Treatment, and a second Treatment.' })
    cssRegister(root, { terms: [], notATerm: { treatment: ['outlined', 'ghost'] } })

    const row = collectTerms({ root }).concepts.find(r => r.term === 'Treatment')
    expect(row.status).toBe('blessed')
    expect(row.label.note).toBe('axis')
    rmSync(root, { recursive: true, force: true })
  })

  test('a term wins over the axis of the same name, so Heading keeps its definition', () => {
    const root = fixture({ 'packages/alpha/a.md': 'a Heading and a Heading.' })
    cssRegister(root, {
      terms:    [{ term: 'Heading', element: '<h1>', meaning: 'level is outline, not size' }],
      notATerm: { heading: ['h1', 'h2'] },
    })

    const row = collectTerms({ root }).concepts.find(r => r.term === 'Heading')
    expect(row.label.means).toBe('level is outline, not size')
    expect(row.label.note).not.toBe('axis')
    rmSync(root, { recursive: true, force: true })
  })

  // The fold and the lookup are two different spellings of one word, and only a
  // PLURAL term shows it — every singular one matched, so the gap was invisible
  // from the terms that worked. css ships three: Steps, Tabs, Facts.
  test('a plural term is found under the singular the corpus folded it into', () => {
    const root = fixture({ 'packages/alpha/a.md': 'one Sprocket, then Sprockets, then more Sprockets.' })
    cssRegister(root, { terms: [{ term: 'Sprockets', meaning: 'where the Sprockets go' }] })

    const { concepts } = collectTerms({ root })
    // The fold ran, so there is no `Sprockets` row to match exactly.
    expect(concepts.find(r => r.term === 'Sprockets')).toBeUndefined()
    const row = concepts.find(r => r.term === 'Sprocket')
    expect(row.status).toBe('blessed')
    expect(row.label.term).toBe('Sprockets')
    rmSync(root, { recursive: true, force: true })
  })

  // Paired with it: the alias must not overwrite a term the register names in
  // its own right, or `Item` would take `Items`' definition.
  test('a singular the register names itself is not overwritten by a plural alias', () => {
    const root = fixture({ 'packages/alpha/a.md': 'one Sprocket and some Sprockets here.' })
    cssRegister(root, {
      terms: [
        { term: 'Sprocket',  meaning: 'the thing itself' },
        { term: 'Sprockets', meaning: 'where they go' },
      ],
    })

    const row = collectTerms({ root }).concepts.find(r => r.term === 'Sprocket')
    expect(row.label.means).toBe('the thing itself')
    rmSync(root, { recursive: true, force: true })
  })

  test('the root register outranks it where the root has DECIDED', () => {
    const root = fixture({ 'packages/alpha/a.md': 'a Sprocket and a Sprocket.' })
    cssRegister(root, { terms: [{ term: 'Sprocket', meaning: 'a toothed wheel' }] })
    writeFileSync(join(root, 'VOCABULARY.md'), [
      '| Term | Status | Means | Note |',
      '| --- | --- | --- | --- |',
      '| Sprocket | refused | say Cog |  |',
    ].join('\n'))

    const row = collectTerms({ root }).concepts.find(r => r.term === 'Sprocket')
    expect(row.status).toBe('refused')
    expect(row.label.source).toBeUndefined()
    rmSync(root, { recursive: true, force: true })
  })

  // Paired with the row above, because the precedence is the same line of code
  // and only the two together say it is reading the STATUS rather than the
  // presence of a root row.
  test('an open root row still wins, and is reported as answered elsewhere', () => {
    const root = fixture({ 'packages/alpha/a.md': 'a Sprocket and a Sprocket.' })
    cssRegister(root, { terms: [{ term: 'Sprocket', meaning: 'a toothed wheel' }] })
    writeFileSync(join(root, 'VOCABULARY.md'), [
      '| Term | Status | Means | Note |',
      '| --- | --- | --- | --- |',
      '| Sprocket | open |  |  |',
    ].join('\n'))

    const model = collectTerms({ root })
    expect(model.concepts.find(r => r.term === 'Sprocket').status).toBe('open')
    const answered = model.audit.undecidedButDefined.find(r => r.term === 'Sprocket')
    expect(answered.owner).toBe('css')
    expect(answered.means).toBe('a toothed wheel')
    rmSync(root, { recursive: true, force: true })
  })

  // The command is exploratory and ungated (`FJS-1211`), so a register it cannot
  // read must not stop it. What it must not do is fall silent: every term goes
  // back to `unnamed`, which is what a package that named nothing also looks
  // like, so the two are separated by the row this asserts.
  test('an unreadable register degrades to unnamed and SAYS it was unreadable', () => {
    const root = fixture({ 'packages/alpha/a.md': 'a Sprocket and a Sprocket.' })
    mkdirSync(join(root, 'packages', 'css'), { recursive: true })
    writeFileSync(join(root, 'packages', 'css', 'vocabulary.json'), '{ not json')

    const model = collectTerms({ root })
    expect(model.concepts.find(r => r.term === 'Sprocket').status).toBe('unnamed')
    expect(model.registers[0].found).toBe(false)
    expect(model.registers[0].terms).toBe(0)
    rmSync(root, { recursive: true, force: true })
  })

  test('a register that is simply absent reads the same way and does not throw', () => {
    const root = fixture({ 'packages/alpha/a.md': 'a Sprocket and a Sprocket.' })
    const model = collectTerms({ root })
    expect(model.concepts.find(r => r.term === 'Sprocket').status).toBe('unnamed')
    expect(model.registers[0].found).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('file kinds', () => {
  test('a source file is read WHOLE, and its terms carry the code kind', () => {
    const root = fixture({
      'packages/alpha/a.md': 'the Sprocket is explained here.',
      'packages/alpha/a.js': 'const x = 1 // a Sprocket in a comment\nclass Sprocket {}',
    })

    const row = collectTerms({ root }).concepts.find(r => r.term === 'Sprocket')
    // Two from the .js file: the comment AND the class declaration, which is
    // the trade `whole file` makes and the reason the kind can be switched off.
    expect(row.byKind.markdown).toBe(1)
    expect(row.byKind.code).toBe(2)
    rmSync(root, { recursive: true, force: true })
  })

  test('the breakdown is JOINT, so a kind can be subtracted from spread', () => {
    const root = fixture({
      'packages/alpha/a.md': 'the Sprocket here.',
      'packages/beta/b.js':  '// the Sprocket there',
    })

    const row = collectTerms({ root }).concepts.find(r => r.term === 'Sprocket')
    expect(row.spread).toBe(2)
    // Dropping markdown must leave ONE package, which is only decidable from
    // the pair — an owner tally and a kind tally cannot answer it together.
    expect(row.byCell['alpha|markdown']).toBe(1)
    expect(row.byCell['beta|code']).toBe(1)
    rmSync(root, { recursive: true, force: true })
  })

  test('the corpus counts each kind, so an empty one is visible', () => {
    const root = fixture({
      'packages/alpha/a.md':    'a Sprocket.',
      'packages/alpha/a.mesa':  '<!-- a Sprocket -->',
      'packages/alpha/a.css':   '/* a Sprocket */',
    })

    const { corpus } = collectTerms({ root })
    expect(corpus.byKind.framework).toBe(1)
    expect(corpus.byKind.web).toBe(1)
    expect(corpus.byKind.code).toBe(0)
    rmSync(root, { recursive: true, force: true })
  })

  // Reading what this workspace generated is the measurement grading its own
  // input, which is already why VOCABULARY.md is out. Each exclusion is PAIRED
  // with the same bytes under a name or without a header that does not trip it,
  // because a reader that excluded everything would satisfy the absence alone.
  test('generated output is not corpus, by name, by header and by this page', () => {
    const root = fixture({
      'packages/alpha/keep.md':     'a Sprocket.',
      'packages/alpha/x.snapshot.md': 'a Sprocket.',
      'packages/alpha/gen.md':      '<!-- generated by: fli ws:atlas -->\na Sprocket.',
      'repo-terms.html':            'a Sprocket.',
    })

    const row = collectTerms({ root }).concepts.find(r => r.term === 'Sprocket')
    expect(row.count).toBe(1)
    rmSync(root, { recursive: true, force: true })
  })

  test('…and an ordinary file of the same bytes IS counted', () => {
    const root = fixture({
      'packages/alpha/keep.md':  'a Sprocket.',
      'packages/alpha/other.md': 'a Sprocket.',
      'packages/alpha/page.html': 'a Sprocket.',
    })

    const row = collectTerms({ root }).concepts.find(r => r.term === 'Sprocket')
    expect(row.count).toBe(3)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('over this repo', () => {
  const model = collectTerms({ root: REPO })

  test('ARCHITECT.md § 2 still parses — the doctrine is not silently empty', () => {
    expect(model.architect.found).toBe(true)
    expect(model.architect.blessed.length).toBeGreaterThan(15)
    expect(model.architect.forbidden.length).toBeGreaterThan(20)
  })

  test('the three vocabularies are all non-empty', () => {
    expect(model.counts.concept).toBeGreaterThan(100)
    expect(model.counts.language).toBeGreaterThan(50)
    expect(model.counts.api).toBeGreaterThan(500)
  })

  test('the blessed words this repo uses most are classed as concepts', () => {
    for (const term of ['Resource', 'Release', 'Service']) {
      const row = model.concepts.find(r => r.term === term)
      expect(row?.class).toBe('concept')
      expect(row?.status).toBe('blessed')
    }
  })

  test('VOCABULARY.md is read and every row it holds resolves to a term', () => {
    expect(model.counts.authored).toBeGreaterThan(50)
    expect(model.counts.labelled).toBeGreaterThan(50)
  })

  // The control, and the only thing standing between a register that moved and
  // a package that never named anything: both read as every css term `unnamed`,
  // and only the COUNT separates them.
  test('@frontierjs/css\'s own register resolves and contributes its terms', () => {
    const { read } = packageVocabularies(REPO)
    const css = read.find(r => r.owner === 'css')
    expect(css.found).toBe(true)
    expect(css.terms).toBeGreaterThan(50)
  })

  test('all four kinds are in the corpus, and none of them is empty', () => {
    for (const kind of ['markdown', 'code', 'framework', 'web'])
      expect(model.corpus.byKind[kind]).toBeGreaterThan(10)
  })

  // The audit reads the authored registers, which are prose. Asking it of the
  // widened corpus changes what every row MEANS with nothing saying so — the
  // first run over code took `unlabelled` from 0 to 123 by counting identifiers
  // as spread. The number is small because the question is the same one.
  test('the audit stays on the prose it was calibrated on', () => {
    expect(model.audit.unlabelled.length).toBeLessThan(10)
    expect(model.audit.unnamedCommon.length).toBeLessThan(10)
  })

  test('the words that prompted this are named by css rather than reading unnamed', () => {
    const row = model.concepts.find(r => r.term === 'Treatment')
    expect(row?.status).toBe('blessed')
    expect(row?.label?.owner).toBe('css')
  })

  // Surface is spelled by both registers. The root row names the app's
  // directory, and outranks css's block shape, so the css sense cannot
  // silently become the framework's.
  test('a word both registers name is the root file\'s', () => {
    const row = model.concepts.find(r => r.term === 'Surface')
    expect(row?.status).toBe('blessed')
    expect(row?.label?.owner).toBeUndefined()
    expect(row?.label?.home).toBe('Framework')
    expect(row?.label?.under).toBe('')
  })

  // The container half of the UI tree is css's tiers. A root row that leaves
  // Under blank takes css's; one that states an Under keeps it, and a row in
  // another Home is another sense and takes nothing.
  test('a UI row with no Under of its own is placed by css\'s tier', () => {
    const card = model.concepts.find(r => r.term === 'Card')
    expect(card?.label?.under).toBe('Block tier')
    expect(card?.label?.underFrom).toBe('css')
  })
})

describe('placed', () => {
  const css = { home: 'UI', under: 'Inline tier', owner: 'css' }

  test('an authored Under outranks the tier', () => {
    expect(placed({ home: 'UI', under: 'Select task' }, css).under).toBe('Select task')
  })

  test('a row in another Home is another sense', () => {
    expect(placed({ home: 'Data', under: '' }, css).under).toBe('')
  })

  test('a word only css names is css\'s row, tier and all', () => {
    expect(placed(undefined, css)).toBe(css)
  })
})
