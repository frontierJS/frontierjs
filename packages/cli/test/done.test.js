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

import { layoutNamed, moduleNamed, collectChanges, runDone, stopVerdict, itemKey, editedIn, checkItems, ignoreHides } from '../core/done.js'

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

describe('fli check, asked about the files that changed', () => {
  const app = {
    'db/schema.lite':               'model Lead { id Int @id }\n',
    'web/config/vite.config.js':    'export default { server: { port: 8010 } }\n',
    'widgets/config/vite.config.js':   'export default { server: { port: 8011 } }\n',
    'api/src/app.ts':               "app.get('/orders/:id', h)\n",
  }

  test('a vite config without strictPort and a :id raw route are unfinished, in the changed files only', () => {
    const { root, cleanup } = tree(app)
    try {
      const items = checkItems({ root, changed: ['web/config/vite.config.js', 'api/src/app.ts'] })
      expect(items.every(i => i.check === 'fli-check' && i.ok === false)).toBe(true)
      expect(items.map(i => i.subject).sort()).toEqual(['raw-route-param:api/src/app.ts', 'vite-strict-port:web/config/vite.config.js'])
    } finally { cleanup() }
  })

  test('a finding in a file the change did not touch is not the change\'s, and an unrelated change asks nothing', () => {
    const { root, cleanup } = tree(app)
    try {
      expect(checkItems({ root, changed: ['widgets/config/vite.config.js'] }).map(i => i.subject)).toEqual(['vite-strict-port:widgets/config/vite.config.js'])
      expect(checkItems({ root, changed: ['notes.md'] })).toEqual([])
    } finally { cleanup() }
  })
})

describe('a new ignore rule', () => {
  const repo = files => {
    const t   = tree(files)
    const git = (...a) => execFileSync('git', ['-C', t.root, ...a], { stdio: 'ignore' })
    git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x')
    return { ...t, git }
  }

  test('one that hides a file on disk is unfinished until looked at, and runDone says so', async () => {
    const { root, cleanup } = repo({ '.gitignore': 'dist/\n', 'a.js': '' })
    try {
      mkdirSync(join(root, 'notes'), { recursive: true })
      writeFileSync(join(root, 'notes/plan.md'), 'x')
      writeFileSync(join(root, '.gitignore'), 'dist/\nnotes/\n')
      const items = ignoreHides({ root, changed: ['.gitignore'] })
      expect(items.map(i => [i.check, i.subject, i.ok])).toEqual([['gitignore', '.gitignore:notes/', false]])
      expect(items[0].message).toMatch(/hides notes\//)

      const report = await runDone(root, { changes: { changed: ['.gitignore'], added: [], untracked: [], diff: '' }, engines: false })
      expect(report.unfinished).toBe(1)
    } finally { cleanup() }
  })

  test('one that hides nothing, a comment and a rule already there ask nothing', () => {
    const { root, cleanup } = repo({ '.gitignore': 'dist/\n', 'a.js': '' })
    try {
      writeFileSync(join(root, '.gitignore'), 'dist/\n# a note\nbuild/\n')
      expect(ignoreHides({ root, changed: ['.gitignore'] })).toEqual([])
      expect(ignoreHides({ root, changed: ['a.js'] })).toEqual([])
    } finally { cleanup() }
  })
})

describe('the diff', () => {
  test('an untracked file is changed and added, and a clean tree reports nothing', async () => {
    const { root, cleanup } = tree({ 'a.js': 'one\n' })
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' })
    try {
      git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x')
      expect((await runDone(root, { engines: false })).changed).toBe(0)

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

  test('with the files a session edited, it is held only on its own items', () => {
    const mine   = item('packages/a/core/mine.js')
    const theirs = item('packages/a/core/theirs.js')
    const v = stopVerdict({ state: {}, head: 'h1', fingerprint: 'f1', edited: ['packages/a/core/mine.js'], report: report(mine, theirs) })
    expect(v.block).toBe(true)
    expect(v.reason).toMatch(/mine\.js/)
    expect(v.reason).not.toMatch(/theirs\.js/)
    // Not shown, so a later edit of it by this session still holds it.
    expect(v.state.shown).toEqual([itemKey(mine)])

    expect(stopVerdict({ state: {}, head: 'h1', fingerprint: 'f1', edited: [], report: report(mine) }).block).toBe(false)
  })

  test('a stale snapshot is the session\'s when it edited the snapshot\'s package, and nobody\'s at the root', () => {
    const snap = subject => ({ check: 'snapshots', subject, ok: false, message: `${subject} is stale` })
    const at = (edited, s) => stopVerdict({ state: {}, head: 'h1', fingerprint: 'f1', edited, report: report(snap(s)) }).block
    expect(at(['packages/a/src/x.js'], 'packages/a/surface.snapshot.md')).toBe(true)
    expect(at(['packages/b/src/x.js'], 'packages/a/surface.snapshot.md')).toBe(false)
    expect(at(['ISSUES.md'],           'repo-atlas.snapshot.html')).toBe(false)
    // A new module is never the session's for sharing its package.
    expect(stopVerdict({ state: {}, head: 'h1', fingerprint: 'f1', edited: ['packages/a/core/x.js'], report: report(item('packages/a/core/y.js')) }).block).toBe(false)
  })
})

describe('editedIn', () => {
  const use  = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
  const root = '/r/repo'

  test('the editing tools under the root, repo-relative, and nothing a Read or Bash names', () => {
    const transcript = [
      use('Edit',         { file_path: '/r/repo/packages/a/x.js', old_string: 'a' }),
      use('Write',        { file_path: '/r/repo/ISSUES.md' }),
      use('NotebookEdit', { notebook_path: '/r/repo/n.ipynb' }),
      use('Edit',         { file_path: '/r/repo/packages/a/x.js' }),
      use('Read',         { file_path: '/r/repo/packages/b/y.js' }),
      use('Bash',         { command: 'sed -i s/a/b/ /r/repo/packages/c/z.js' }),
      use('Edit',         { file_path: '/r/repo-other/w.js' }),
      use('Edit',         { file_path: '/elsewhere/v.js' }),
      '{ torn',
      JSON.stringify({ type: 'user', message: { content: 'just "tool_use" said in a prompt' } }),
    ].join('\n')
    expect(editedIn(transcript, root)).toEqual(['ISSUES.md', 'n.ipynb', 'packages/a/x.js'])
  })

  test('no transcript is no edits', () => {
    expect(editedIn('', root)).toEqual([])
    expect(editedIn(undefined, root)).toEqual([])
  })
})
