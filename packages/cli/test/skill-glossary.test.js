// skill-glossary.test.js — the glossary's bar: a term is on it because it recurs.
//
// What can be WRONG: a term kept after the files stopped using it (the line
// then defines nothing anyone meets), a term listed twice (two definitions
// disagree), and a term the glossary was meant to hold used in too few files
// for a shared definition to earn its line.

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const SKILLS = join(import.meta.dir, '../../../.claude/skills')
const GLOSSARY = join(SKILLS, 'bridge-index/references/glossary.md')
const POINTED_FROM = ['data-hazards', 'api-hazards', 'ui-hazards', 'bridge-index']

// `asSystem()` → asSystem, `createApp({ system })` → createApp({ system })
const bare = (term) => term.replace(/\(([^{}]*)\)$/, '')

const entries = () =>
  readFileSync(GLOSSARY, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('- `'))
    .map((l) => {
      const head = l.slice(2, l.indexOf(' — '))
      return { line: l, terms: [...head.matchAll(/`([^`]+)`/g)].map((m) => bare(m[1])), skills: [...l.matchAll(/→ `([a-z-]+)`/g)].map((m) => m[1]) }
    })

// references/ files of every skill except the glossary itself, by skill
const referenceFiles = () => {
  const out = []
  for (const skill of readdirSync(SKILLS)) {
    const dir = join(SKILLS, skill, 'references')
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      const path = join(dir, f)
      if (path !== GLOSSARY) out.push({ skill, text: readFileSync(path, 'utf8') })
    }
  }
  return out
}

describe('the skills glossary', () => {
  const refs = referenceFiles()

  test('has entries, each opening with a backticked term and naming the skill that holds the decision', () => {
    const all = entries()
    expect(all.length).toBeGreaterThan(10)
    for (const e of all) {
      expect(e.terms.length, e.line).toBeGreaterThan(0)
      expect(e.skills.length, e.line).toBeGreaterThan(0)
      for (const s of e.skills) expect(existsSync(join(SKILLS, s, 'SKILL.md')), `${s} in: ${e.line}`).toBe(true)
    }
  })

  test('a term is defined once', () => {
    const seen = entries().flatMap((e) => e.terms)
    expect(seen.filter((t, i) => seen.indexOf(t) !== i)).toEqual([])
  })

  test('every term recurs: three or more reference files across two or more skills', () => {
    for (const { terms, line } of entries()) {
      for (const term of terms) {
        const using = refs.filter((r) => r.text.includes(term))
        const skills = new Set(using.map((r) => r.skill))
        expect(using.length >= 3 && skills.size >= 2, `${term} (${using.length} files, ${skills.size} skills) in: ${line.slice(0, 60)}`).toBe(true)
      }
    }
  })

  test('each realm skill and bridge-index points at the glossary', () => {
    for (const skill of POINTED_FROM) {
      const index = readFileSync(join(SKILLS, skill, 'SKILL.md'), 'utf8')
      expect(index.includes('references/glossary.md'), skill).toBe(true)
    }
  })
})
