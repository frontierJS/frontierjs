// register-atlas.test.js — the registers as one page, for a project that is not
// this workspace.
//
// The page's failure is silence: a record the model drops renders as a smaller
// register, and a link resolved against the wrong directory is a chip that
// opens nothing. So every record in the fixture is asserted present by id, and
// every link is asserted to name a file that EXISTS — against a fixture whose
// registers sit under `.project/` with a non-FJS prefix, the shape a reader
// keyed to the workspace root reads as empty. The browser half is
// `test/browser/register-atlas.mjs`.

import { describe, test, expect } from 'bun:test'
import { existsSync }    from 'fs'
import { join, dirname } from 'path'

import { collectRegisterAtlas, renderRegisterAtlas, TABS } from '../core/register-atlas.js'
import { registerProject } from './fixtures/register-project.mjs'

const collect = (root, opts = {}) => collectRegisterAtlas(root, { touched: new Set(), ...opts })

describe('the model', () => {

  test('every record in every register is in it, by id', () => {
    const { root, cleanup } = registerProject()
    try {
      const m = collect(root)
      expect(m.prefix).toBe('ACME')
      expect(m.dir).toBe('.project')
      expect(m.issues.map(r => r.id).sort()).toEqual(['ACME-000', 'ACME-001', 'ACME-002', 'ACME-D2'])
      expect(m.issues.find(r => r.id === 'ACME-000').closed).toBe(true)
      expect(m.rulings.map(r => r.id)).toEqual(['ACME-D1'])
      expect(m.ideas.map(r => r.id)).toEqual(['texting'])
      expect(m.questions.map(q => q.id).sort()).toEqual(['ACME-D2', 'texting:what-may-leave-for-the-provider', 'texting:where-does-the-call-run'])
      expect(m.unparsed).toEqual([])
    } finally { cleanup() }
  })

  test('the ranking splits ready from blocked, and a blocked row names its blocker', () => {
    const { root, cleanup } = registerProject()
    try {
      const m = collect(root)
      expect(m.ready).toEqual(['ACME-001'])
      expect(m.blocked).toEqual(['ACME-002'])
      expect(m.issues.find(r => r.id === 'ACME-002').blockedBy).toEqual(['ACME-001'])
      expect(m.issues.find(r => r.id === 'ACME-001').rank.n).toBe(1)
    } finally { cleanup() }
  })

  test('a question is counted on its paper, and a ruled one would not be', () => {
    const { root, cleanup } = registerProject()
    try {
      const m = collect(root)
      expect(m.ideas[0].questions).toBe(2)
      const q = m.questions.find(x => x.id === 'texting:where-does-the-call-run')
      expect(q.state).toBe('decidable')
      expect(q.recommend.letter).toBe('A')
      expect(m.sections).toEqual(['Data & schema', 'Repo conventions'])
    } finally { cleanup() }
  })

  // A register link is relative to the file it is written in. Resolved against
  // the project root instead, `../api/src/texts.js` points outside it.
  test('every link resolves from where the page is written, to a file that exists', () => {
    const { root, cleanup } = registerProject()
    try {
      for (const outDir of [join(root, '.project'), root, join(root, 'web')]) {
        const m = collect(root, { outDir })
        const links = [...m.issues, ...m.rulings, ...m.ideas].flatMap(r => r.links)
        expect(links.length).toBe(3)
        for (const l of links) expect(existsSync(join(outDir, l.href))).toBe(true)
        for (const r of [...m.issues, ...m.rulings, ...m.ideas, ...m.questions])
          expect(existsSync(join(outDir, r.at.href))).toBe(true)
      }
    } finally { cleanup() }
  })

  test('the editor link is absolute and carries the line', () => {
    const { root, cleanup } = registerProject()
    try {
      const r = collect(root).issues.find(x => x.id === 'ACME-001')
      expect(r.at.edit).toBe(`vscode://file${join(root, '.project', 'ISSUES.md')}:${r.at.line}`)
      expect(r.at.line).toBeGreaterThan(0)
      expect(r.links[0].edit).toBe(`vscode://file${join(root, 'api', 'src', 'texts.js')}`)
    } finally { cleanup() }
  })
})

describe('the page', () => {

  test('it embeds the model whole, and a `<` in a register cannot close the script', () => {
    const { root, cleanup } = registerProject()
    try {
      const m    = collect(root)
      m.issues[0].body += ' </script><b>'
      const html = renderRegisterAtlas(m)
      const json = html.match(/<script type="application\/json" id="model">([\s\S]*?)<\/script>/)[1]
      expect(JSON.parse(json)).toEqual(m)
    } finally { cleanup() }
  })

  // Invariant 15: the script is built from a template string, and a clean
  // render is not proof it parses.
  test('every script block on it parses', () => {
    const { root, cleanup } = registerProject()
    try {
      const html    = renderRegisterAtlas(collect(root))
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1])
      expect(scripts.length).toBe(2)
      for (const s of scripts) expect(() => new Function(s)).not.toThrow()
    } finally { cleanup() }
  })

  test('it names itself as not a snapshot, so the snapshots phase never adopts it', () => {
    const { root, cleanup } = registerProject()
    try {
      const html = renderRegisterAtlas(collect(root))
      expect(html).not.toMatch(/generated by:/)
      expect(html).toMatch(/fli register:atlas · not a snapshot/)
      for (const [key] of TABS) expect(html).toContain(`data-tab="${key}"`)
    } finally { cleanup() }
  })

  test('with no stylesheet handed in, it links the published one', () => {
    const { root, cleanup } = registerProject()
    try {
      expect(renderRegisterAtlas(collect(root))).toMatch(/<link rel="stylesheet" href="https:/)
      expect(renderRegisterAtlas(collect(root), '.x{}')).toMatch(/<style id="fjs-css">\.x\{\}<\/style>/)
    } finally { cleanup() }
  })
})

// The workspace keeps its registers at the root under FJS — the other shape,
// asserted against the real tree so a reader change that drops a register
// shows here too.
describe('this workspace', () => {
  test('reads all three registers at the root', () => {
    const repo = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..')
    const m    = collect(repo)
    expect(m.prefix).toBe('FJS')
    expect(m.dir).toBe('.')
    expect(m.issues.some(r => !r.closed)).toBe(true)
    expect(m.rulings.length).toBeGreaterThan(0)
    expect(m.ideas.length).toBeGreaterThan(0)
  })
})
