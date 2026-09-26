// test/outline.test.js — core/outline.js and `fli outline`
//
// A range that is off by a line is worse than no outline: the reader trusts it
// and reads the wrong function. So the fixtures pin every boundary by line, and
// the real files are graded against their own source — each row's range must
// hold the declaration it names.

import { test, expect, describe } from 'bun:test'
import { spawnSync }             from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir }                  from 'node:os'
import { join, resolve }           from 'node:path'
import { typeScriptAt }            from '../core/functions.js'
import {
  outlineCode, outlineMarkdown, outlineLite, outlineMesa, renderOutline, findRows, renderBody, pathOf, typeScriptFor,
  wideRead, outlineHint, HINT_AT,
} from '../core/outline.js'

const REPO = resolve(import.meta.dir, '../../..')
const ts   = await typeScriptAt(REPO)

const CODE = `import { x } from 'y'

// ─── section banner ───

// what parse refuses
// and why
export function parse(input) {
  if (!input) return null
  return input
}

export const helper = (a) => {
  return a + 1
}

const one = () => 1

class Store {
  constructor() {
    this.rows = []
  }
  get size() {
    return this.rows.length
  }
}

export function factory() {
  return function factory() {
    return 1
  }
}

const table = {
  find() {
    return 1
  },
}

describe('parse', () => {
  test('refuses nothing', () => {
    expect(parse('a')).toBe('a')
  })
})
`

const rows  = outlineCode(ts, 'fixture.js', CODE)
const byName = name => findRows(rows, name)[0]

describe('outlineCode', () => {
  test('a row starts at its attached comment, and a banner a blank line above is not attached', () => {
    expect(byName('parse')).toMatchObject({ kind: 'function', start: 5, end: 10 })
  })

  test('an arrow is named by its binding and spans its statement', () => {
    expect(byName('helper')).toMatchObject({ start: 12, end: 14 })
  })

  test('a one-liner is no row', () => {
    expect(findRows(rows, 'one')).toEqual([])
  })

  test('a class holds its members, accessors included', () => {
    const store = byName('Store')
    expect(store).toMatchObject({ kind: 'class', start: 18, end: 25 })
    expect(store.children.map(r => [r.name, r.kind])).toEqual([['constructor', 'method'], ['size', 'get']])
  })

  test('a factory returning its namesake is one row', () => {
    const f = findRows(rows, 'factory')
    expect(f).toHaveLength(1)
    expect(f[0].children).toEqual([])
  })

  test('an object literal holds its methods', () => {
    expect(byName('table').children.map(r => r.name)).toEqual(['find'])
  })

  test('a suite callback is named by its title', () => {
    const suite = byName("describe('parse')")
    expect(suite).toMatchObject({ start: 39, end: 43 })
    expect(suite.children.map(r => r.name)).toEqual(["test('refuses nothing')"])
  })
})

const MD = `---
title: x
# not a heading
---

# Top

intro

## First

\`\`\`sh
# not a heading either
\`\`\`

### Inner

text


## Second

last
`

describe('outlineMarkdown', () => {
  const md = outlineMarkdown(MD)

  test('front matter and fences hold no headings', () => {
    expect(md).toHaveLength(1)
    expect(md[0].children.map(r => r.name)).toEqual(['First', 'Second'])
  })

  test('a section runs to the next heading at its level, trailing blanks trimmed', () => {
    expect(md[0]).toMatchObject({ name: 'Top', kind: '#', start: 6, end: 23 })
    expect(md[0].children[0]).toMatchObject({ start: 10, end: 18 })
    expect(md[0].children[0].children[0]).toMatchObject({ name: 'Inner', start: 16, end: 18 })
  })

  test('an anchor tag is not part of the name', () => {
    expect(outlineMarkdown('### <a id="d1"></a>D1 — ruled\n')[0].name).toBe('D1 — ruled')
  })
})

const LITE = `import "./auth.lite"

// ─── banner ───

/// a lead is a person
// not yet a customer
model Lead {
  id    Int    @id
  note  String @default("{ not a brace }")
  // }
}

extend model User {
  leads Lead[]
  x     Int
}

tenancy { strategy row }

function slug(text: String): String {
  lower(text)
}
`

describe('outlineLite', () => {
  const lite = outlineLite(LITE)

  test('a block is the words before its brace, a comment above it included', () => {
    expect(lite.map(r => [r.kind, r.name, r.start, r.end])).toEqual([
      ['model', 'Lead', 5, 11], ['extend model', 'User', 13, 16], ['function', 'slug', 20, 22],
    ])
  })

  test('a brace in a string or a comment is no brace, and a one-line block is no row', () => {
    expect(findRows(lite, 'tenancy')).toEqual([])
    expect(findRows(lite, 'Lead')[0].end).toBe(11)
  })
})

const MESA = `---
title: X
---
<script module>
  export const rows = []
</script>

<script>
  import { x } from 'y'

  // why load waits
  function load() {
    return x
  }
</script>

<div>
  {#each rows as r}
    <p>{r}</p>
  {/each}
</div>

<style>
  div { color: red }
  p { margin: 0 }
</style>
`

describe('outlineMesa', () => {
  const mesa = outlineMesa(ts, 'X.mesa', MESA)

  test('its blocks, the markup between them, and its front matter', () => {
    expect(mesa.map(r => [r.name, r.start, r.end])).toEqual([
      ['front matter', 1, 3], ['script module', 4, 6], ['script', 8, 15], ['markup', 17, 21], ['style', 23, 26],
    ])
  })

  test("a script's functions sit at the file's own lines", () => {
    expect(findRows(mesa, 'load')[0]).toMatchObject({ start: 11, end: 14 })
    expect(pathOf(findRows(mesa, 'load')[0])).toBe('script.load')
  })

  test('with no parser, the blocks alone', () => {
    expect(outlineMesa(null, 'X.mesa', MESA).flatMap(r => r.children)).toEqual([])
  })
})

describe('renderOutline', () => {
  const leaf = (name, start, end) => ({ name, kind: 'function', start, end, children: [] })

  test('a short row stays shut and says how many rows it hides', () => {
    const out = renderOutline([{ ...leaf('small', 1, 20), children: [leaf('a', 2, 10)] }])
    expect(out).toEqual([' 1-20  small (20) +1 inside'])
  })

  test('a long row opens onto children worth listing', () => {
    const out = renderOutline([{ ...leaf('big', 1, 200), children: [leaf('a', 2, 100), leaf('b', 101, 199)] }])
    expect(out).toEqual(['  1-200  big (200)', '  2-100    a (99)', '101-199    b (99)'])
  })

  test('a long row over a LIST stays shut, unless it is the row asked for', () => {
    const list = Array.from({ length: 40 }, (_, i) => leaf(`r${i}`, 2 + i * 5, 6 + i * 5))
    const row  = { ...leaf('rulings', 1, 202), children: list }
    expect(renderOutline([row])).toEqual(['  1-202  rulings (202) +40 inside'])
    expect(renderOutline([row], { open: row })).toHaveLength(41)
  })
})

describe('findRows', () => {
  const tree = [
    { name: 'makeTable', kind: 'function', start: 1, end: 100, children: [
      { name: 'update', kind: 'method', start: 10, end: 50, children: [
        { name: '_upBody', kind: 'function', start: 20, end: 40, children: [] },
      ] },
    ] },
    { name: 'createClient', kind: 'function', start: 101, end: 200, children: [
      { name: 'update', kind: 'method', start: 110, end: 120, children: [] },
    ] },
  ]

  test('two rows of one name are both returned, each with its path', () => {
    expect(findRows(tree, 'update').map(pathOf)).toEqual(['makeTable.update', 'createClient.update'])
  })

  test('a dotted path names ancestors in order, not every step', () => {
    expect(findRows(tree, 'makeTable._upBody').map(pathOf)).toEqual(['makeTable.update._upBody'])
    expect(findRows(tree, 'createClient._upBody')).toEqual([])
  })

  test('with no exact name, a case-insensitive substring', () => {
    expect(findRows(tree, 'UPBODY').map(pathOf)).toEqual(['makeTable.update._upBody'])
  })

  test('a line number is the innermost row holding it', () => {
    expect(findRows(tree, '30').map(pathOf)).toEqual(['makeTable.update._upBody'])
    expect(findRows(tree, '60').map(pathOf)).toEqual(['makeTable'])
    expect(findRows(tree, '999')).toEqual([])
  })

  test('a body is numbered as cat -n numbers it', () => {
    expect(renderBody(['a', 'b', 'c'], { start: 2, end: 3 })).toEqual(['2\tb', '3\tc'])
  })
})

describe('the hint in front of a wide read', () => {
  test('a Read with no limit, and a guessed sed window, are wide reads', () => {
    expect(wideRead({ tool_name: 'Read', tool_input: { file_path: 'a/b.ts' } })).toBe('a/b.ts')
    expect(wideRead({ tool_name: 'Read', tool_input: { file_path: 'a/b.ts', offset: 3000 } })).toBe('a/b.ts')
    expect(wideRead({ tool_name: 'Bash', tool_input: { command: 'sed -n 3801,4060p a/b.ts' } })).toBe('a/b.ts')
    expect(wideRead({ tool_name: 'Bash', tool_input: { command: "sed -n '10,20p' 'DECISIONS.md' | head" } })).toBe('DECISIONS.md')
  })

  test('a limited Read, a file with no outline, and any other tool are not', () => {
    expect(wideRead({ tool_name: 'Read', tool_input: { file_path: 'a/b.ts', limit: 80 } })).toBe(null)
    expect(wideRead({ tool_name: 'Read', tool_input: { file_path: 'a/b.json' } })).toBe(null)
    expect(wideRead({ tool_name: 'Bash', tool_input: { command: 'sed -i s/a/b/ a/b.ts' } })).toBe(null)
    expect(wideRead({ tool_name: 'Edit', tool_input: { file_path: 'a/b.ts' } })).toBe(null)
  })

  test('the hint names the file and both spellings, and only at HINT_AT lines', () => {
    expect(outlineHint('a.ts', HINT_AT - 1)).toBe(null)
    expect(outlineHint('a.ts', HINT_AT)).toContain('fli outline a.ts <name|a.b|line>')
  })
})

// The fixtures pin the rules; these pin that the rules hold on the files the
// command exists for.
describe('real files', () => {
  for (const rel of ['packages/junction/src/core/litestone.ts', 'packages/litestone/src/core/client.js']) {
    test(`every row of ${rel} holds the declaration it names`, () => {
      const text  = readFileSync(join(REPO, rel), 'utf8')
      const lines = text.split('\n')
      const flat  = []
      const walk  = list => { for (const r of list) { flat.push(r); walk(r.children) } }
      walk(outlineCode(ts, rel, text))
      expect(flat.length).toBeGreaterThan(50)
      for (const r of flat) {
        const body = lines.slice(r.start - 1, r.end).join('\n')
        const bare = r.name.replace(/\(.*$/s, '')
        expect(body.includes(bare), `${r.name} ${r.start}-${r.end}`).toBe(true)
        expect(r.end).toBeGreaterThanOrEqual(r.start + 2)
        expect(r.end).toBeLessThanOrEqual(lines.length)
      }
    })
  }

  const tracked = glob => spawnSync('git', ['ls-files', glob], { cwd: REPO, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)

  test("every tracked .lite's rows open on the words they are named by", () => {
    const files = tracked('*.lite')
    expect(files.length).toBeGreaterThan(20)
    for (const rel of files) {
      const lines = readFileSync(join(REPO, rel), 'utf8').split('\n')
      for (const r of outlineLite(lines.join('\n'))) {
        const head = lines.slice(r.start - 1, r.end).find(l => !l.trimStart().startsWith('//'))
        expect(head.startsWith(`${r.kind} ${r.name}`.trim()), `${rel} ${r.start}`).toBe(true)
        expect(lines[r.end - 1].trim().startsWith('}'), `${rel} ${r.end}`).toBe(true)
      }
    }
  })

  test("every tracked .mesa's script rows open and close on their tags, with functions inside", () => {
    const files = tracked('*.mesa')
    expect(files.length).toBeGreaterThan(300)
    let functions = 0
    for (const rel of files) {
      const lines = readFileSync(join(REPO, rel), 'utf8').split('\n')
      for (const r of outlineMesa(ts, rel, lines.join('\n')).filter(r => r.name.startsWith('script'))) {
        expect(lines[r.start - 1].startsWith('<script'), `${rel} ${r.start}`).toBe(true)
        expect(lines[r.end - 1].includes('</script>'), `${rel} ${r.end}`).toBe(true)
        for (const c of r.children) {
          expect(c.start > r.start && c.end < r.end, `${rel} ${c.name}`).toBe(true)
          functions++
        }
      }
    }
    expect(functions).toBeGreaterThan(500)
  })

  test('the parser is found from a file several directories down', async () => {
    expect(await typeScriptFor(join(REPO, 'packages/junction/src/core/litestone.ts'))).toBeTruthy()
  })
})

describe('fli outline', () => {
  const dir  = mkdtempSync(join(tmpdir(), 'fli-outline-'))
  const file = join(dir, 'fixture.md')
  writeFileSync(file, '# One\n\na\n\n## Two\n\nb\n\n## Two\n\nc\n')
  const fli = (...args) => spawnSync(process.execPath, [join(import.meta.dir, '../bin/fli.js'), 'outline', ...args], { cwd: dir, encoding: 'utf8' })

  test('prints the outline', () => {
    const r = fli('fixture.md')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('1-11  # One (11)')
  })

  test('prints a body by line number', () => {
    const r = fli('fixture.md', '7')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('5\t## Two')
    expect(r.stdout).toContain('7\tb')
    expect(r.stdout).not.toContain('\tc')
  })

  test('two matches name both and exit 1', () => {
    const r = fli('fixture.md', 'Two')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('2 rows match Two')
  })

  test('a file it cannot read is refused by name', () => {
    writeFileSync(join(dir, 'x.json'), '{}')
    const r = fli('x.json')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('no outline for')
    rmSync(dir, { recursive: true, force: true })
  })
})
