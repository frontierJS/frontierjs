// test/cat.test.js — core/cat.js and `fli cat`
//
// The renderer is Bun's; what is graded here is what this hands it. A fence
// rewritten inside a code block, or a link rewritten inside one, prints the
// reader a file that is not the file — so each rewrite is paired with the case
// it must leave alone.

import { test, expect, describe, afterAll } from 'bun:test'
import { spawnSync }              from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir }                 from 'node:os'
import { join, resolve }          from 'node:path'
import { prepare, render, section, titleOf, folderIndex } from '../core/cat.js'

const FLI = resolve(import.meta.dir, '../bin/fli.js')

describe('prepare', () => {
  test('frontmatter becomes a yaml fence', () => {
    const out = prepare('---\ntitle: x\nalias: y\n---\n\n# H\n')
    expect(out).toBe('```yaml\ntitle: x\nalias: y\n```\n\n\n# H\n')
  })

  test('a column-0 script block becomes a js fence; one inside a fence is left alone', () => {
    const src = '<script>\nimport a from \'b\'\n</script>\n\n```html\n<script>\nx()\n</script>\n```\n'
    const out = prepare(src)
    expect(out.startsWith('```js\nimport a from \'b\'\n```\n')).toBe(true)
    expect(out).toContain('```html\n<script>\nx()\n</script>\n```')
  })

  test('a relative link becomes a file URL beside the file, keeping its anchor', () => {
    const out = prepare('[a](./b.md#sec) [c](https://x.y) [d](#top) [e](/abs.md)', { file: '/repo/docs/a.md' })
    expect(out).toBe('[a](file:///repo/docs/b.md#sec) [c](https://x.y) [d](#top) [e](/abs.md)')
  })

  test('a link inside a code fence is not rewritten', () => {
    const src = '```md\n[a](./b.md)\n```\n'
    expect(prepare(src, { file: '/repo/a.md' })).toBe(src)
  })
})

test('render without color is plain text with the frontmatter shown as a block', () => {
  const out = render('---\ntitle: x\n---\n\n# Head\n\nbody\n', { color: false })
  expect(out).not.toContain('\x1b[')
  expect(out).toContain('title: x')
  expect(out).toContain('Head')
  expect(out).not.toMatch(/^-{20,}/m)
})

describe('section', () => {
  const doc = '# Top\n\nintro\n\n## One\n\nfirst\n\n## Two\n\nsecond\n'
  test('a heading names its section, through to the next sibling', () => {
    expect(section(doc, 'One').text).toBe('## One\n\nfirst')
  })
  test('a line names the innermost section holding it', () => {
    expect(section(doc, '11').text).toBe('## Two\n\nsecond')
  })
  test('none refuses by name', () => {
    expect(section(doc, 'Nine').refused).toBe('no section matches Nine')
  })
})

describe('titleOf', () => {
  test('frontmatter title first', () => expect(titleOf('---\ntitle: T\n---\n# H\n')).toBe('T'))
  test('else the first # heading outside a fence', () => expect(titleOf('```\n# not\n```\n# Yes\n')).toBe('Yes'))
  test('else null', () => expect(titleOf('plain')).toBe(null))
})

describe('a folder and the command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fli-cat-'))
  mkdirSync(join(dir, 'sub'))
  mkdirSync(join(dir, 'node_modules'))
  writeFileSync(join(dir, 'a.md'), '# Alpha\n\n## Part\n\ntext\n')
  writeFileSync(join(dir, 'sub', 'b.md'), '---\ntitle: Beta\n---\nbody\n')
  writeFileSync(join(dir, 'node_modules', 'c.md'), '# skipped\n')

  const fli = (...args) => {
    const env = { ...process.env, NO_COLOR: '1' }
    delete env.FORCE_COLOR
    return spawnSync(process.execPath, [FLI, 'cat', ...args], { cwd: dir, encoding: 'utf8', env })
  }

  test('folderIndex lists markdown with titles, skipping node_modules', () => {
    expect(folderIndex(dir).map(f => [f.rel, f.title, f.lines])).toEqual([['a.md', 'Alpha', 6], ['sub/b.md', 'Beta', 5]])
  })

  test('piped, a file is its source byte for byte', () => {
    const r = fli('a.md')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('# Alpha\n\n## Part\n\ntext\n')
  })

  test('a word after one file is a section', () => {
    expect(fli('a.md', 'Part').stdout).toBe('## Part\n\ntext\n')
  })

  test('a word after a folder is a missing file', () => {
    const r = fli('.', 'Part')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('no such file or folder: Part')
  })

  test('--all renders each file under a banner', () => {
    const r = fli('.', '--all')
    expect(r.stdout).toContain('==> ./a.md <==')
    expect(r.stdout).toContain('==> ./sub/b.md <==')
    expect(r.stdout).not.toContain('skipped')
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))
})
