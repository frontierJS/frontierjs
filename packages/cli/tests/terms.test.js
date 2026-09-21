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

import { collectTerms, architectVocabulary, authoredVocabulary, renderPage } from '../core/terms.js'

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

  test('candidates are proposed from the prose, and a sentence is not one', () => {
    const { audit } = collectTerms({ root: REPO })
    const terms = audit.phraseCandidates.map(r => r.term)

    // `Data` alone is too generic to be vocabulary and `Data realm` is not.
    expect(terms).toContain('Data realm')
    expect(terms).toContain('Data boundary')
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
})
