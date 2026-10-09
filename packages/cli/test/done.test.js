// done.test.js — is the change in the working tree finished.
//
// Every check is asserted from both sides, because each fails in silence the
// other way: a check that flags everything is one everybody learns to ignore,
// and one that flags nothing looks exactly like a finished change. The Stop
// hook's verdict is asserted for the case that decides whether it can stay
// installed — an item already shown does not block a second time.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir }        from 'os'
import { execFileSync }  from 'child_process'

import { layoutNamed, moduleNamed, collectChanges, runDone, stopVerdict, itemKey } from '../core/done.js'

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'fli-done-'))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('layout-named', () => {
  const doc   = '# a\n\n```\ncore/\n  one.js\n  two.js\n  three.js\n```\n'
  const files = { 'packages/a/CLAUDE.md': doc, 'packages/a/core/one.js': '', 'packages/a/core/two.js': '', 'packages/a/core/three.js': '', 'packages/a/core/four.js': '', 'packages/a/core/new.js': '' }

  test('a new module is named where the layout names most of its siblings — and not asked for where it names few', () => {
    const { root, cleanup } = tree(files)
    try {
      const unnamed = layoutNamed({ root, added: ['packages/a/core/new.js'] })
      expect(unnamed.map(i => [i.ok, i.subject])).toEqual([[false, 'packages/a/core/new.js']])
      expect(unnamed[0].message).toMatch(/names 3 of the 4 files beside it and not new\.js/)

      writeFileSync(join(root, 'packages/a/CLAUDE.md'), doc.replace('three.js', 'three.js\n  new.js'))
      expect(layoutNamed({ root, added: ['packages/a/core/new.js'] }).map(i => i.ok)).toEqual([true])

      writeFileSync(join(root, 'packages/a/CLAUDE.md'), '# a\n\none.js is the entry.\n')
      expect(layoutNamed({ root, added: ['packages/a/core/new.js'] })).toEqual([])
    } finally { cleanup() }
  })

  test('a new test file is not a module', () => {
    const { root, cleanup } = tree({ ...files, 'packages/a/test/x.test.js': '' })
    try { expect(layoutNamed({ root, added: ['packages/a/test/x.test.js'] })).toEqual([]) }
    finally { cleanup() }
  })
})

describe('module-named', () => {
  const cmd   = (t) => `---\ntitle: ns:${t}\n---\n`
  const files = {
    'packages/cli/commands/ns/_module.md': 'fli ns:one\nfli ns:two\nfli ns:three\n',
    'packages/cli/commands/ns/one.md': cmd('one'), 'packages/cli/commands/ns/two.md': cmd('two'),
    'packages/cli/commands/ns/three.md': cmd('three'), 'packages/cli/commands/ns/new.md': cmd('new'),
  }

  test('a new command is named in its namespace module by its title, from both sides', () => {
    const { root, cleanup } = tree(files)
    try {
      expect(moduleNamed({ root, added: ['packages/cli/commands/ns/new.md'] }).map(i => i.ok)).toEqual([false])
      writeFileSync(join(root, 'packages/cli/commands/ns/_module.md'), 'fli ns:one\nfli ns:two\nfli ns:three\nfli ns:new\n')
      expect(moduleNamed({ root, added: ['packages/cli/commands/ns/new.md'] }).map(i => i.ok)).toEqual([true])
    } finally { cleanup() }
  })
})

describe('the diff', () => {
  test('an untracked file is changed and added, and a clean tree reports nothing', () => {
    const { root, cleanup } = tree({ 'a.js': 'one\n' })
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' })
    try {
      git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x')
      expect(runDone(root, { engines: false }).changed).toBe(0)

      writeFileSync(join(root, 'b.js'), '')
      writeFileSync(join(root, 'a.js'), 'two\n')
      writeFileSync(join(root, 'c.js'), 'const fresh = 1\n')
      const c = collectChanges(root)
      expect(c.changed).toEqual(['a.js', 'b.js', 'c.js'])
      expect(c.added).toEqual(['b.js', 'c.js'])
      // An untracked file's content is in the diff the drives are read from.
      expect(c.diff).toContain('+const fresh = 1')
    } finally { cleanup() }
  })
})

describe('the Stop hook verdict', () => {
  const report = (...items) => ({ items })
  const item   = (subject, ok = false) => ({ check: 'layout-named', subject, ok, message: `${subject} needs an entry` })

  test('an unchanged tree builds nothing, and a changed one asks for the report', () => {
    const state = { head: 'h1', fingerprint: 'f1', shown: [] }
    expect(stopVerdict({ state, head: 'h1', fingerprint: 'f1' }).run).toBe(false)
    expect(stopVerdict({ state, head: 'h1', fingerprint: 'f2' }).run).toBe(true)
  })

  test('an unfinished item blocks once, and the same item shown again does not', () => {
    const first = stopVerdict({ state: {}, head: 'h1', fingerprint: 'f1', report: report(item('packages/a')) })
    expect(first.block).toBe(true)
    expect(first.reason).toMatch(/packages\/a needs an entry/)

    const again = stopVerdict({ state: first.state, head: 'h1', fingerprint: 'f2', report: report(item('packages/a')) })
    expect(again.block).toBe(false)

    // The pair: a NEW item on the same tree still blocks.
    const other = stopVerdict({ state: again.state, head: 'h1', fingerprint: 'f3', report: report(item('packages/a'), item('packages/b')) })
    expect(other.block).toBe(true)
    expect(other.reason).not.toMatch(/packages\/a/)
  })

  test('a finished item never blocks, and moving HEAD forgets what was shown', () => {
    expect(stopVerdict({ state: {}, head: 'h1', fingerprint: 'f1', report: report(item('packages/a', true)) }).block).toBe(false)
    const shown = { head: 'h1', fingerprint: 'f1', shown: [itemKey(item('packages/a'))] }
    expect(stopVerdict({ state: shown, head: 'h2', fingerprint: 'f9', report: report(item('packages/a')) }).block).toBe(true)
  })
})
