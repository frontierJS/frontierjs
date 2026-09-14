// The schema assistant is a document a chat model follows with nothing else in
// hand, so its failure is silent in the worst direction: a word missing from it
// is a word the model will invent a spelling for, and a section that stopped
// being lifted is judgment the model no longer has. Neither breaks a build.
//
// So the document is asserted against its sources — the catalog, AGENTS.md —
// rather than against a copy of its text, and the paste is asserted to carry
// the files a schema IMPORTS, since a pasted root file alone makes every
// relation to an imported model look dangling.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  renderAssistant, collectSchemaFiles, findPurpose, agentsSections, AGENTS_SECTIONS, PURPOSE_SECTIONS,
} from '../src/tools/assistant.js'
import { CATALOG, TIERS, typed } from '../src/core/catalog.js'
import { RULES, VISIBILITY } from '../src/core/advise.js'
import { OPPORTUNITIES } from '../src/core/opportunities.js'

const doc = renderAssistant({ snapshot: true })

describe('the assistant document', () => {
  test('carries every word the catalog holds, each with its meaning', () => {
    const missing = CATALOG.filter(r => !doc.includes(`#### \`${typed(r)}\``)).map(r => typed(r))
    expect(CATALOG.length).toBeGreaterThan(50)
    expect(missing).toEqual([])
    // A heading with no blurb under it is a word the model can name and not use.
    const blurbless = CATALOG.filter(r => r.blurb && !doc.includes(r.blurb.slice(0, 60))).map(r => typed(r))
    expect(blurbless).toEqual([])
  })

  test('the playbook ranks words by tiers the catalog actually assigns', () => {
    // The playbook is the one hand-written half, and it steers by tier name. A
    // name the catalog never assigns is advice the model can never follow.
    const playbook = doc.slice(doc.indexOf('## Your role'), doc.indexOf('## Judgment'))
    const named    = [...playbook.matchAll(/\*\*(\w+)\*\*/g)].map(m => m[1]).filter(w => /^[a-z]+$/.test(w))
    const tiers    = Object.keys(TIERS)
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter(w => !tiers.includes(w))).toEqual([])
    for (const t of tiers) expect(playbook).toContain(`**${t}**`)
  })

  test('carries the visibility table, every rule and every opportunity', () => {
    expect(VISIBILITY.every(r => doc.includes(r.note))).toBe(true)
    expect(RULES.every(r => doc.includes(r.title))).toBe(true)
    expect(OPPORTUNITIES.every(r => doc.includes(r.title))).toBe(true)
  })

  test('lifts each named AGENTS.md section, and refuses a heading that moved', () => {
    for (const name of AGENTS_SECTIONS) expect(doc).toContain(`### ${name}`)
    // A pair: the real file yields every section, a file missing one is refused
    // by name rather than rendering a document with the judgment quietly gone.
    const agents = readFileSync(resolve(import.meta.dir, '../AGENTS.md'), 'utf8')
    expect(agentsSections(AGENTS_SECTIONS, agents)).toHaveLength(AGENTS_SECTIONS.length)
    const renamed = agents.replace('## Wrong guesses', '## Common mistakes')
    expect(() => agentsSections(AGENTS_SECTIONS, renamed)).toThrow(/Wrong guesses/)
  })

  test('the playbook steps are numbered in order, and "step 2" is the purpose', () => {
    // "Begin at step 2" is written in two places; a step inserted above it
    // silently sends the model into the middle of the interview.
    const steps = [...doc.matchAll(/^(\d+)\. \*\*([^*]+)\*\*/gm)].map(m => [Number(m[1]), m[2]])
    expect(steps.map(s => s[0])).toEqual(steps.map((_, i) => i + 1))
    expect(steps[1][1]).toBe('Settle the purpose.')
  })

  test('the purpose template carries every heading, and the playbook names only real ones', () => {
    const fileSection = doc.slice(doc.indexOf('## The purpose file'), doc.indexOf('## Start'))
    const order       = PURPOSE_SECTIONS.map(([h]) => fileSection.indexOf(`## ${h}\n`))
    expect(order.every(i => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)

    // The playbook steers by italic names — *Out of scope*, *The schema*. Each
    // must be a heading the model can find: a purpose heading, or a section of
    // this document as a paste renders it, since *The schema* exists only there.
    // A pair, so the check is shown to refuse a renamed heading.
    const paste    = renderAssistant({
      schema: { files: [{ label: 'db/schema.lite', text: '' }] },
      purpose: { label: 'PURPOSE.md', text: '' },
    })
    const headings = new Set([
      ...PURPOSE_SECTIONS.map(([h]) => h),
      ...[...paste.matchAll(/^#{2,3} (.+)$/gm)].map(m => m[1]),
    ])
    const unknown  = (text: string) =>
      [...text.matchAll(/(?<![*\w])\*([A-Z][^*\n]+)\*(?!\*)/g)].map(m => m[1]).filter(n => !headings.has(n))
    const playbook = doc.slice(doc.indexOf('## Your role'), doc.indexOf('## The purpose file'))
    expect(unknown(playbook)).toEqual([])
    expect(unknown(playbook.replace('*Out of scope*', '*Not doing*'))).toEqual(['Not doing'])
  })

  test('the snapshot names its generator and carries no schema; a paste carries one', () => {
    expect(doc).toContain('<!-- generated by: litestone assistant --snapshot -->')
    expect(doc).not.toContain('## The schema')

    const pasted = renderAssistant({ schema: { files: [{ label: 'db/schema.lite', text: 'model Lead {\n  id Int @id\n}' }] } })
    expect(pasted).toContain('## The schema')
    expect(pasted).toContain('model Lead {')
    expect(pasted).not.toContain('generated by:')
    expect(pasted).not.toContain('## The purpose\n')

    const both = renderAssistant({
      schema: { files: [{ label: 'db/schema.lite', text: 'model Lead {\n  id Int @id\n}' }] },
      purpose: { label: 'PURPOSE.md', text: '# Quotes — Purpose\n\n## Purpose\n\nA quoting tool.' },
    })
    expect(both.indexOf('## The purpose\n')).toBeGreaterThan(both.indexOf('## The purpose file'))
    expect(both.indexOf('## The purpose\n')).toBeLessThan(both.indexOf('## The schema'))
    expect(both.match(/Begin at step 2 of the playbook/g)).toHaveLength(1)
  })
})

describe('finding the purpose file', () => {
  test('walks up from the schema to the app root, and no further', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-purpose-'))
    try {
      const app = join(dir, 'app')
      mkdirSync(join(app, 'db'), { recursive: true })
      writeFileSync(join(app, 'package.json'), '{}')
      writeFileSync(join(app, 'db', 'schema.lite'), 'model Lead {\n  id Int @id\n}\n')
      // Above the app root: a pair, so the stop is shown to hold.
      writeFileSync(join(dir, 'PURPOSE.md'), '# the repository around it')
      expect(findPurpose(join(app, 'db', 'schema.lite'))).toBeNull()

      writeFileSync(join(app, 'PURPOSE.md'), '# Quotes — Purpose')
      expect(findPurpose(join(app, 'db', 'schema.lite'))?.text).toBe('# Quotes — Purpose')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('collecting the schema to paste', () => {
  test('follows an import, labels each file once, and names one it cannot find', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-assistant-'))
    try {
      writeFileSync(join(dir, 'schema.lite'),
        'import "./user.lite"\nimport "./missing.lite"\nmodel Lead {\n  id Int @id\n  ownerId Int\n}\n')
      writeFileSync(join(dir, 'user.lite'), 'import "./schema.lite"\nmodel User {\n  id Int @id\n}\n')

      const { files } = collectSchemaFiles(join(dir, 'schema.lite'))
      const labels    = files.map(f => f.label)

      expect(files[0].text).toContain('model Lead')
      expect(labels.some(l => l.endsWith('user.lite'))).toBe(true)
      expect(files.find(f => f.label.endsWith('user.lite'))?.text).toContain('model User')
      // The cycle back to schema.lite is not followed twice.
      expect(files.filter(f => f.text.includes('model Lead'))).toHaveLength(1)
      expect(labels.some(l => l.includes('missing.lite') && l.includes('not found'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
