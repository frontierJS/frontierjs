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
import { dirname, join, resolve } from 'node:path'
import { prepare, render, prettify, formatJson, blockCommentLines, section, titleOf, folderIndex } from '../core/cat.js'

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
  test('a heading names its section, through to the next sibling', async () => {
    expect((await section('a.md', doc, 'One')).text).toBe('## One\n\nfirst')
  })
  test('a line names the innermost section holding it', async () => {
    expect((await section('a.md', doc, '11')).text).toBe('## Two\n\nsecond')
  })
  test('none refuses by name', async () => {
    expect((await section('a.md', doc, 'Nine')).refused).toBe('no section matches Nine')
  })

  const json = '{"scripts":{"test":"bun test","a.b":{"c":1}},"list":[10,20]}'
  test('a JSON section is a key path, and a key may hold a dot', async () => {
    expect((await section('p.json', json, 'scripts.test')).text).toBe('"bun test"')
    expect((await section('p.json', json, 'scripts.a.b.c')).text).toBe('1')
    expect((await section('p.json', json, 'list.1')).text).toBe('20')
  })
  test('a missing key refuses with the top-level keys', async () => {
    const got = await section('p.json', json, 'nope')
    expect(got.refused).toBe('no key nope — the top-level keys:')
    expect(got.rows).toEqual(['  scripts', '  list'])
  })
  test('a file with no reading refuses by name', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'fli-cat-')), 'notes.txt')
    writeFileSync(file, 'x')
    expect((await section(file, 'x', 'y')).refused).toContain(`no outline for ${file}`)
    rmSync(dirname(file), { recursive: true, force: true })
  })
})

describe('prettify', () => {
  test('valid JSON is laid out from its tokens, so a number prints as written', () => {
    expect(formatJson('{"a":[],"b":{"c":1.0,"d":[12345678901234567890,true]},"e":{}}', { color: false }))
      .toBe('{\n  "a": [],\n  "b": {\n    "c": 1.0,\n    "d": [\n      12345678901234567890,\n      true\n    ]\n  },\n  "e": {}\n}\n')
  })
  test('JSON that does not parse keeps its layout and comments', () => {
    const src = '{\n  // why\n  "a": 1,\n}\n'
    expect(formatJson(src, { color: false })).toBe(src)
  })
  test('a key and a string value color differently', () => {
    const out = formatJson('{"k":"v"}')
    expect(out).toContain('\x1b[36m"k"\x1b[0m')
    expect(out).toContain('\x1b[32m"v"\x1b[0m')
  })
  test('code is highlighted with no box around it, and a backtick run cannot close the fence', () => {
    const src = 'const a = 1\nconst t = `x`\nconst f = "```"\n'
    const out = prettify(src, 'a.ts', { color: true })
    expect(out).toContain('\x1b[35mconst')
    expect(out).not.toContain('│')
    expect(out).not.toContain('┌')
    expect(out.replace(/\x1b\[[0-9;]*m/g, '')).toBe(src)
  })
  test('anything else prints as it is', () => {
    expect(prettify('a\tb', 'notes.txt')).toBe('a\tb\n')
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

  test('a JSON file and its key path, piped', () => {
    writeFileSync(join(dir, 'p.json'), '{"scripts":{"test":"bun test"}}')
    expect(fli('p.json').stdout).toBe('{"scripts":{"test":"bun test"}}\n')
    expect(fli('p.json', 'scripts').stdout).toBe('{\n  "test": "bun test"\n}\n')
  })

  test('a binary file is named, not printed', () => {
    writeFileSync(join(dir, 'x.bin'), Buffer.from([1, 0, 2]))
    expect(fli('x.bin').stdout).toBe('x.bin: binary, 3 bytes — not printed\n')
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

describe('blockCommentLines', () => {
  const lines = src => [...blockCommentLines(src)].sort((a, b) => a - b)
  test('a JSDoc block is every line of it', () => {
    expect(lines('/**\n * a\n */\nconst x = 1\n')).toEqual([0, 1, 2])
  })
  test('code before an opening or after a close keeps its line', () => {
    expect(lines('x() /* a\n b\n c */ y()\n')).toEqual([1])
  })
  test('a string or a regex holding comment marks opens nothing', () => {
    expect(lines("const a = '/*'\nconst r = /`+/g\nconst b = 2\n")).toEqual([])
  })
})
