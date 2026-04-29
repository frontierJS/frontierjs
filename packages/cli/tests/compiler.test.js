import { describe, test, expect } from 'bun:test'
import { extractFrontmatter, transformMarkdown, compileCli, extractSegments } from '../core/compiler.js'

// ─── extractFrontmatter ───────────────────────────────────────────────────────

describe('extractFrontmatter', () => {

  test('parses simple string values', () => {
    const fm = extractFrontmatter(`---
title: hello:greet
description: A greeting command
alias: greet
---`)
    expect(fm.title).toBe('hello:greet')
    expect(fm.description).toBe('A greeting command')
    expect(fm.alias).toBe('greet')
  })

  test('coerces boolean true/false', () => {
    const fm = extractFrontmatter(`---
title: test:cmd
required: true
optional: false
---`)
    expect(fm.required).toBe(true)
    expect(fm.optional).toBe(false)
  })

  test('coerces numbers', () => {
    const fm = extractFrontmatter(`---
title: test:cmd
defaultValue: 3
port: 3141
---`)
    expect(fm.defaultValue).toBe(3)
    expect(fm.port).toBe(3141)
  })

  test('strips surrounding quotes from strings', () => {
    const fm = extractFrontmatter(`---
title: "hello:greet"
description: 'A quoted description'
---`)
    expect(fm.title).toBe('hello:greet')
    expect(fm.description).toBe('A quoted description')
  })

  test('parses inline array values (examples)', () => {
    const fm = extractFrontmatter(`---
title: test:cmd
examples:
  - fli test:cmd foo
  - fli test:cmd bar --dry
---`)
    expect(fm.examples).toEqual(['fli test:cmd foo', 'fli test:cmd bar --dry'])
  })

  test('parses args as array of objects', () => {
    const fm = extractFrontmatter(`---
title: test:cmd
args:
  -
    name: path
    description: The path
    required: true
  -
    name: method
    description: HTTP method
---`)
    expect(fm.args).toHaveLength(2)
    expect(fm.args[0].name).toBe('path')
    expect(fm.args[0].required).toBe(true)
    expect(fm.args[1].name).toBe('method')
    expect(fm.args[1].required).toBeUndefined()
  })

  test('parses flags as nested objects', () => {
    const fm = extractFrontmatter(`---
title: test:cmd
flags:
  dry:
    type: boolean
    char: d
    description: Dry run
    defaultValue: false
  count:
    type: number
    char: c
    defaultValue: 1
---`)
    expect(fm.flags.dry.type).toBe('boolean')
    expect(fm.flags.dry.char).toBe('d')
    expect(fm.flags.dry.defaultValue).toBe(false)
    expect(fm.flags.count.type).toBe('number')
    expect(fm.flags.count.defaultValue).toBe(1)
  })

  test('returns empty object if no frontmatter present', () => {
    expect(extractFrontmatter('just some markdown')).toEqual({})
  })

  test('returns empty object for empty frontmatter block', () => {
    expect(extractFrontmatter('---\n---')).toEqual({})
  })

})

// ─── transformMarkdown ────────────────────────────────────────────────────────

describe('transformMarkdown', () => {

  test('comments out plain prose lines', () => {
    const result = transformMarkdown('---\ntitle: t\n---\nThis is prose.\n')
    expect(result).toContain('// This is prose.')
  })

  test('passes ```js block through as raw code', () => {
    const result = transformMarkdown(`---
title: t
---

\`\`\`js
const x = 1
echo(x)
\`\`\`
`)
    expect(result).toContain('const x = 1')
    expect(result).toContain('echo(x)')
    expect(result).not.toContain('```')
  })

  test('wraps ```bash blocks in ZX await $`...`', () => {
    const result = transformMarkdown(`---
title: t
---

\`\`\`bash
git push origin main
\`\`\`
`)
    expect(result).toContain('await $`')
    expect(result).toContain('git push origin main')
    expect(result).toContain('`')
  })

  test('comments out non-js/bash fenced blocks', () => {
    const result = transformMarkdown(`---
title: t
---

\`\`\`yaml
key: value
\`\`\`
`)
    expect(result).toContain('// key: value')
  })

  test('strips frontmatter before transforming', () => {
    const result = transformMarkdown(`---
title: hello:greet
description: A command
---

\`\`\`js
echo('hi')
\`\`\`
`)
    // frontmatter fields should NOT appear as commented lines
    expect(result).not.toContain('// title: hello:greet')
    expect(result).toContain("echo('hi')")
  })

  test('does NOT strip <script> blocks — that is compileCli job', () => {
    // transformMarkdown is a lower-level fn; it sees the raw template.
    // Script stripping happens in compileCli before calling transformMarkdown.
    const result = transformMarkdown(`---
title: t
---

<script>
const x = 1
</script>

\`\`\`js
echo('main')
\`\`\`
`)
    // prose/script lines get commented out — that's correct behaviour here
    expect(result).toContain('// <script>')
    expect(result).toContain("echo('main')")
  })

})

// ─── compileCli ───────────────────────────────────────────────────────────────

describe('compileCli', () => {

  test('produces valid ESM with metadata and run exports', () => {
    const src = compileCli(`---
title: test:hello
description: A test command
---

\`\`\`js
echo('hi')
\`\`\`
`)
    expect(src).toContain('export const metadata =')
    expect(src).toContain('export async function run(context)')
    expect(src).toContain("import 'zx/globals'")
  })

  test('metadata export contains correct title', () => {
    const src = compileCli(`---
title: test:hello
description: A test command
---
`)
    const match = src.match(/export const metadata = (.+)/)
    expect(match).toBeTruthy()
    const meta = JSON.parse(match[1])
    expect(meta.title).toBe('test:hello')
    expect(meta.description).toBe('A test command')
  })

  test('script block content appears at top level (not inside run)', () => {
    const src = compileCli(`---
title: test:cmd
---

<script>
const helper = () => 'helped'
</script>

\`\`\`js
echo(helper())
\`\`\`
`)
    const lines = src.split('\n')
    const helperLine  = lines.findIndex(l => l.includes("const helper = () => 'helped'"))
    const runLine     = lines.findIndex(l => l.includes('export async function run'))
    // helper must be defined BEFORE run()
    expect(helperLine).toBeGreaterThan(-1)
    expect(runLine).toBeGreaterThan(-1)
    expect(helperLine).toBeLessThan(runLine)
  })

  test('main block code appears inside run()', () => {
    const src = compileCli(`---
title: test:cmd
---

\`\`\`js
const result = doSomething()
\`\`\`
`)
    const lines = src.split('\n')
    const runLine    = lines.findIndex(l => l.includes('export async function run'))
    const resultLine = lines.findIndex(l => l.includes('const result = doSomething()'))
    expect(resultLine).toBeGreaterThan(runLine)
  })

  test('script block indented code does not leak into run() body', () => {
    // The real bug we fixed: indented lines inside <script> were being
    // picked up by transformMarkdown's tab-state and landing inside run()
    const src = compileCli(`---
title: test:cmd
---

<script>
const writeFile = (path, content) => {
  const parts = [
    '---',
    content,
    '---',
  ]
  return parts.join('\\n')
}
</script>

\`\`\`js
echo(writeFile('a', 'b'))
\`\`\`
`)
    const lines = src.split('\n')
    const runIdx = lines.findIndex(l => l.includes('export async function run'))
    const partsIdx = lines.findIndex(l => l.includes("const parts = ["))
    // parts must be BEFORE run() (inside writeFile helper, not leaked into run body)
    expect(partsIdx).toBeGreaterThan(-1)
    expect(partsIdx).toBeLessThan(runIdx)
  })

  test('script block imports are preserved at top level', () => {
    const src = compileCli(`---
title: test:cmd
---

<script>
import { readFileSync } from 'fs'
</script>

\`\`\`js
echo('hi')
\`\`\`
`)
    expect(src).toContain("import { readFileSync } from 'fs'")
    // Must appear before the run() function
    const lines = src.split('\n')
    const importLine = lines.findIndex(l => l.includes("import { readFileSync }"))
    const runLine    = lines.findIndex(l => l.includes('export async function run'))
    expect(importLine).toBeLessThan(runLine)
  })

})

// ─── echo context shadowing ──────────────────────────────────────────────────

describe('compileCli — echo context shadowing', () => {

  test('compiled run() uses context.echo when provided', async () => {
    const md = `---
title: test:echo
description: echo test
---

\`\`\`js
echo('hello from command')
\`\`\`
`
    const source = compileCli(md)

    // Write to temp file so zx/globals resolves correctly
    const { writeFileSync, unlinkSync } = await import('fs')
    const { resolve } = await import('path')
    const { pathToFileURL } = await import('url')

    const tmp = resolve(global.fliRoot || '.', '__echo_test__.mjs')
    writeFileSync(tmp, source)
    let mod
    try {
      mod = await import(pathToFileURL(tmp))
    } finally {
      setTimeout(() => { try { unlinkSync(tmp) } catch {} }, 200)
    }

    // Run with context.echo set — should call our function, not globalThis.echo
    const captured = []
    const ctx = {
      echo:    (...args) => captured.push(args.join(' ')),
      flag:    {},
      arg:     {},
      log:     { info: () => {}, success: () => {}, warn: () => {}, error: () => {}, dry: () => {}, debug: () => {} },
      paths:   {},
      env:     {},
      exec:    () => {},
      execute: () => {},
      config:  {},
    }

    await mod.run(ctx)
    expect(captured.some(t => t.includes('hello from command'))).toBe(true)
  })

  test('compiled run() falls back to globalThis.echo when context.echo is undefined', async () => {
    const md = `---
title: test:echo2
description: echo fallback test
---

\`\`\`js
echo('fallback echo')
\`\`\`
`
    const source = compileCli(md)

    const { writeFileSync: wf2, unlinkSync: ul2 } = await import('fs')
    const { resolve: res2 } = await import('path')
    const { pathToFileURL: p2url } = await import('url')

    const tmp = res2(global.fliRoot || '.', '__echo_test2__.mjs')
    wf2(tmp, source)
    let mod
    try {
      mod = await import(p2url(tmp))
    } finally {
      setTimeout(() => { try { ul2(tmp) } catch {} }, 200)
    }

    // Run without context.echo — globalThis.echo (ZX) should handle it
    const globalCaptured = []
    const prevEcho = globalThis.echo
    globalThis.echo = (...args) => globalCaptured.push(args.join(' '))
    try {
      const ctx = {
        echo:    undefined,
        flag:    {},
        arg:     {},
        log:     { info: () => {}, success: () => {}, warn: () => {}, error: () => {}, dry: () => {}, debug: () => {} },
        paths:   {},
        env:     {},
        exec:    () => {},
        execute: () => {},
        config:  {},
      }
      await mod.run(ctx)
      expect(globalCaptured.some(t => t.includes('fallback echo'))).toBe(true)
    } finally {
      if (prevEcho !== undefined) globalThis.echo = prevEcho
      else delete globalThis.echo
    }
  })

})

// ─── extractSegments ──────────────────────────────────────────────────────────

describe('extractSegments', () => {

  test('extracts script + single prose + single code block', () => {
    const out = extractSegments(`---
title: foo
---

<script>
const helper = () => 1
</script>

This is the prose.

\`\`\`js
log.info(helper())
\`\`\`
`)
    expect(out.script).toBe('const helper = () => 1')
    expect(out.segments).toHaveLength(2)
    expect(out.segments[0]).toEqual({ type: 'prose', content: 'This is the prose.' })
    expect(out.segments[1]).toEqual({ type: 'code', lang: 'js', content: 'log.info(helper())' })
  })

  test('preserves order of interleaved prose/code (literate style)', () => {
    const out = extractSegments(`---
title: literate
---

Intro paragraph.

\`\`\`js
const x = 1
\`\`\`

## A heading

More prose here.

\`\`\`js
const y = x + 1
\`\`\`

Final notes.
`)
    expect(out.segments).toHaveLength(5)
    expect(out.segments.map(s => s.type)).toEqual(['prose', 'code', 'prose', 'code', 'prose'])
    expect(out.segments[2].content).toContain('## A heading')
    expect(out.segments[2].content).toContain('More prose here.')
    expect(out.segments[4].content).toBe('Final notes.')
  })

  test('returns null script when none present', () => {
    const out = extractSegments(`---
title: no-script
---

Just prose.

\`\`\`js
log.info('hi')
\`\`\`
`)
    expect(out.script).toBeNull()
    expect(out.segments).toHaveLength(2)
  })

  test('handles pure prose with no code blocks', () => {
    const out = extractSegments(`---
title: pure-prose
---

Para 1.

Para 2.
`)
    expect(out.segments).toHaveLength(1)
    expect(out.segments[0].type).toBe('prose')
    expect(out.segments[0].content).toContain('Para 1.')
    expect(out.segments[0].content).toContain('Para 2.')
  })

  test('combines consecutive prose paragraphs into single segment', () => {
    const out = extractSegments(`---
title: x
---

Para 1.

Para 2.

\`\`\`js
log.info('go')
\`\`\`
`)
    expect(out.segments).toHaveLength(2)
    expect(out.segments[0].content).toContain('Para 1.')
    expect(out.segments[0].content).toContain('Para 2.')
  })

  test('detects bash language', () => {
    const out = extractSegments(`---
title: x
---

\`\`\`bash
ls -la
\`\`\`
`)
    expect(out.segments[0].lang).toBe('bash')
    expect(out.segments[0].content).toBe('ls -la')
  })

  test('drops empty prose between adjacent code blocks', () => {
    const out = extractSegments(`---
title: x
---

\`\`\`js
const a = 1
\`\`\`

\`\`\`js
const b = 2
\`\`\`
`)
    expect(out.segments).toHaveLength(2)
    expect(out.segments.every(s => s.type === 'code')).toBe(true)
  })

  test('captures unterminated code block at EOF', () => {
    const out = extractSegments(`---
title: x
---

\`\`\`js
const x = 1
// no closing fence
`)
    expect(out.segments).toHaveLength(1)
    expect(out.segments[0].type).toBe('code')
    expect(out.segments[0].content).toContain('const x = 1')
  })

  test('preserves HTML tags in prose verbatim', () => {
    const out = extractSegments(`---
title: x
---

Here is <RandomComponent /> embedded.
`)
    expect(out.segments[0].content).toContain('<RandomComponent />')
  })

  test('handles empty body', () => {
    const out = extractSegments(`---
title: empty
---
`)
    expect(out.script).toBeNull()
    expect(out.segments).toHaveLength(0)
  })

  test('handles tilde fences', () => {
    const out = extractSegments(`---
title: x
---

~~~js
log.info('tilde')
~~~
`)
    expect(out.segments).toHaveLength(1)
    expect(out.segments[0].type).toBe('code')
    expect(out.segments[0].lang).toBe('js')
  })

  test('full literate flow: script + 3 prose + 3 code blocks', () => {
    const out = extractSegments(`---
title: fli:update
---

<script>
const helper = () => 'h'
</script>

Update fli to the latest version.

\`\`\`js
const fliRoot = global.fliRoot
\`\`\`

## Pre-flight

This is a paragraph between blocks.

\`\`\`js
const dirty = context.git.status(fliRoot)
\`\`\`

## Final step

\`\`\`js
log.success('done')
\`\`\`
`)
    expect(out.script).toBe("const helper = () => 'h'")
    expect(out.segments).toHaveLength(6)
    expect(out.segments.map(s => s.type)).toEqual(
      ['prose', 'code', 'prose', 'code', 'prose', 'code']
    )
    expect(out.segments[2].content).toContain('## Pre-flight')
    expect(out.segments[1].content).toContain('global.fliRoot')
    expect(out.segments[3].content).toContain('git.status')
    expect(out.segments[5].content).toContain('log.success')
  })

})
