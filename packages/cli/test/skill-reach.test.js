// skill-reach.test.js — the report that says whether a `Detail:` pointer is followed.
//
// What can be WRONG: a reach counted from a tool RESULT (a file's text quoting a
// path is not an agent opening it), a reference file opened in a session that
// never loaded the skill credited to the pointer, and a file that exists but is
// missing from the report because nobody opened it.

import { describe, test, expect } from 'bun:test'

import { catalog, reachOf, readSession, tally } from '../../../scripts/skill-reach.mjs'

const call = (name, input) => JSON.stringify({ message: { content: [{ type: 'tool_use', name, input }] } })

describe('reachOf', () => {
  test('a Read of a reference file reaches it', () => {
    const r = reachOf({ name: 'Read', input: { file_path: '/x/.claude/skills/api-hazards/references/sockets.md' } })
    expect(r.refs).toEqual(['api-hazards/sockets.md'])
    expect(r.loaded).toEqual([])
  })

  test('a Bash or rg naming the path reaches it', () => {
    expect(reachOf({ name: 'Bash', input: { command: 'cat .claude/skills/data-hazards/references/tenancy.md' } }).refs)
      .toEqual(['data-hazards/tenancy.md'])
  })

  test('the Skill tool and a Read of SKILL.md load a skill', () => {
    expect(reachOf({ name: 'Skill', input: { skill: 'ui-hazards' } }).loaded).toEqual(['ui-hazards'])
    expect(reachOf({ name: 'Read', input: { file_path: '.claude/skills/bridge-index/SKILL.md' } }).loaded).toEqual(['bridge-index'])
  })
})

describe('readSession', () => {
  test('counts tool calls and ignores a path quoted in other text', () => {
    const quoted = JSON.stringify({ message: { content: [{ type: 'text', text: 'see skills/api-hazards/references/sockets.md' }] } })
    const s = readSession([quoted, call('Skill', { skill: 'api-hazards' }), call('Read', { file_path: 'skills/api-hazards/references/sockets.md' }), 'not json'].join('\n'))
    expect([...s.loaded]).toEqual(['api-hazards'])
    expect([...s.refs]).toEqual(['api-hazards/sockets.md'])
  })
})

describe('tally', () => {
  const cat = { 'api-hazards': ['sockets.md', 'the-hook-pipeline.md'] }
  const session = (loaded, refs) => ({ loaded: new Set(loaded), refs: new Set(refs) })

  test('an unopened file is reported at zero, and a reach without the skill loaded is not credited to the pointer', () => {
    const out = tally([
      session(['api-hazards'], ['api-hazards/sockets.md']),
      session([], ['api-hazards/sockets.md']),
      session(['api-hazards'], []),
    ], cat)
    expect(out['api-hazards'].loaded).toBe(2)
    expect(out['api-hazards'].files['sockets.md']).toEqual({ opened: 2, afterLoad: 1 })
    expect(out['api-hazards'].files['the-hook-pipeline.md']).toEqual({ opened: 0, afterLoad: 0 })
  })
})

describe('catalog', () => {
  test('lists the reference files the skills carry today', () => {
    const cat = catalog()
    expect(cat['bridge-index']).toContain('data-api.md')
    expect(Object.keys(cat)).toEqual(expect.arrayContaining(['api-hazards', 'data-hazards', 'ui-hazards']))
  })
})
