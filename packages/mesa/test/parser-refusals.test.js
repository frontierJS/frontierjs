/**
 * The template parser's refusals, and what it SAYS when it refuses.
 *
 * Six rows of the Mesa audit, all of the same shape: the parser accepted
 * something it could not honour and produced a component that was wrong with
 * nothing said. What each assertion pins is therefore the DIAGNOSTIC as much as
 * the behavior — a refusal nobody can act on is the defect one layer up.
 *
 * The compiler under test is resolved through `MESA_COMPILER`, so the same file
 * can be run against a pre-fix copy to measure that every row here was red.
 */

import { describe, it, expect } from 'vitest'

const COMPILER = process.env.MESA_COMPILER ?? '../src/compiler.js'
const { compile, parseText, parseHTML } = await import(COMPILER)

/** The thrown message, or null when the compile succeeded. */
const refusal = async (src) => {
  try {
    await compile(src)
    return null
  } catch (e) {
    return e.message
  }
}

const warningsOf = async (src) => (await compile(src, { warning: () => {} })).analysis.warnings
const errorsOf   = async (src) => (await compile(src, { warning: () => {} })).analysis.errors

// ─── FJS-839 — a duplicate branch ─────────────────────────────────────────────

describe('a block has one else branch (FJS-839)', () => {
  it('refuses a second {:else} in {#if} by name', async () => {
    const msg = await refusal('{#if a}A{:else}B{:else}C{/if}')
    expect(msg).toMatch(/second \{:else\}/)
  })

  // The branch that vanished is the one nothing reported: `B` was silently
  // replaced by `C` and the compile was clean.
  it('does not silently discard the first branch', async () => {
    const msg = await refusal('{#if a}A{:else}B{:else}C{/if}')
    expect(msg).not.toBeNull()
  })

  it('refuses {:else if} after {:else}', async () => {
    // Accepted and REORDERED before this, emitting a selector whose body was
    // empty — so the block could never choose any branch at all.
    const msg = await refusal('{#if a}A{:else}B{:else if b}C{/if}')
    expect(msg).toMatch(/after \{:else\}/)
  })

  it('refuses a second {:then} in {#await}', async () => {
    const msg = await refusal('{#await p}L{:then v}A{:then w}B{/await}')
    expect(msg).toMatch(/second \{:then\}/)
  })

  it('refuses a second {:catch} in {#await}', async () => {
    const msg = await refusal('{#await p}L{:catch e}A{:catch f}B{/await}')
    expect(msg).toMatch(/second \{:catch\}/)
  })

  it('refuses a second {:else} in {#each}, naming it', async () => {
    // This one already threw — with no message at all, so the author got
    // `AssertionError`.
    const msg = await refusal('{#each xs as x}A{:else}B{:else}C{/each}')
    expect(msg).toMatch(/second \{:else\}/)
  })

  it('still accepts the ordinary ladder', async () => {
    expect(await refusal('{#if a}A{:else if b}B{:else}C{/if}')).toBeNull()
    expect(await refusal('{#await p}L{:then v}A{:catch e}B{/await}')).toBeNull()
    expect(await refusal('{#each xs as x}A{:else}B{/each}')).toBeNull()
  })
})

// ─── FJS-840 — one rule for a backslash ───────────────────────────────────────

describe('a mustache is delimited by one rule (FJS-840)', () => {
  it('accepts an escaped quote inside a string', async () => {
    expect(await refusal('<div>{"\\""}</div>')).toBeNull()
  })

  it('accepts an escaped backslash', async () => {
    // Both delimiters tested *the previous character was not a backslash*, so
    // an escaped backslash hid the quote after it and the scan ran to EOF.
    expect(await refusal('<div>{"\\\\"}</div>')).toBeNull()
  })

  it('accepts an escaped quote in a single-quoted string', async () => {
    expect(await refusal("<div>{'it\\'s'}</div>")).toBeNull()
  })

  // parseText re-split the same span parseBinding had already delimited, so the
  // two could disagree about where the expression ended. One scanner now.
  it('parseText and parseBinding agree on where the expression ends', async () => {
    for (const src of ['{"\\""}', '{"\\\\"}', "{'it\\'s'}", '{ {a: "}"} }']) {
      const viaText = parseText(src).parts
      expect(viaText).toHaveLength(1)
      expect(viaText[0].type).toBe('exp')
      expect(parseHTML(src).body[0].value).toBe(src)
    }
  })

  it('emits JavaScript that parses', async () => {
    // Invariant 15 — a clean compile is not proof of valid JS.
    const { compile: c } = await import(COMPILER)
    const acorn = await import('acorn')
    const out = (await c('<div>{"\\""}</div>')).result
    expect(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
  })
})

// ─── FJS-841 — a component name is not truncated ──────────────────────────────

describe('a component tag name keeps all of itself (FJS-841)', () => {
  it('keeps a dotted name whole', async () => {
    const node = parseHTML('<Icons.Star />').body[0]
    expect(node.name).toBe('Icons.Star')
    expect(node.attributes).toHaveLength(0)
  })

  it('calls the namespaced component rather than its first segment', async () => {
    // `Icons.Star` used to compile to `Icons(anchor, { '.Star': true })`.
    const out = (await compile('<Icons.Star size={2} />')).result
    expect(out).toMatch(/Icons\.Star\(/)
  })

  it('keeps an underscore and a dollar', async () => {
    expect(parseHTML('<My_Comp />').body[0].name).toBe('My_Comp')
    expect(parseHTML('<My$Comp />').body[0].name).toBe('My$Comp')
    expect(parseHTML('<My_Comp />').body[0].attributes).toHaveLength(0)
  })

  it('names the real fault for the lowercase form', async () => {
    // It used to die as a close-tag mismatch, which sends the author to the
    // wrong line entirely.
    const errs = await errorsOf('<icons.star />')
    expect(errs.join('\n')).toMatch(/must be capitalized/)
  })

  it('leaves an ordinary tag alone', async () => {
    expect(parseHTML('<my-element a="1" />').body[0].name).toBe('my-element')
    expect(parseHTML('<div class="x">y</div>').body[0].name).toBe('div')
  })
})

// ─── FJS-842 — a nested <script> is reported ──────────────────────────────────

describe('a nested <script> is reported (FJS-842)', () => {
  it('names one inside an element', async () => {
    const w = await warningsOf('<div><script>let q = 5<\/script>{q}</div>')
    expect(w.join('\n')).toMatch(/<script> must be at the top level/)
  })

  it('names one inside a block', async () => {
    const w = await warningsOf('{#if a}<script>let z = 1<\/script>{/if}')
    expect(w.join('\n')).toMatch(/<script> must be at the top level/)
  })

  it('names one inside {#each}', async () => {
    const w = await warningsOf('{#each xs as x}<script>let z = 1<\/script>{/each}')
    expect(w.join('\n')).toMatch(/<script> must be at the top level/)
  })

  it('names a non-JS block, which is the shape an author means to ship', async () => {
    const w = await warningsOf('<div><script type="application/ld+json">{"a":1}<\/script></div>')
    expect(w.join('\n')).toMatch(/<script> must be at the top level/)
  })

  it('says nothing about a top-level script', async () => {
    const w = await warningsOf('<script>let q = 5<\/script><div>{q}</div>')
    expect(w.join('\n')).not.toMatch(/<script> must be at the top level/)
  })
})

// ─── FJS-843 — whitespace where whitespace is the content ─────────────────────

describe('<pre> and <textarea> keep their whitespace (FJS-843)', () => {
  const textOf = (node) => {
    if (node.type === 'text') return node.value
    return (node.body ?? []).map(textOf).join('')
  }

  it('keeps newlines and indentation in <pre>', async () => {
    const dom = (await compile('<pre>a\n  b\n    c</pre>')).DOM
    expect(textOf(dom.body[0])).toBe('a\n  b\n    c')
  })

  it('keeps them inside a <code> nested in <pre>', async () => {
    const dom = (await compile('<pre><code>x\n  y</code></pre>')).DOM
    expect(textOf(dom.body[0])).toBe('x\n  y')
  })

  it("keeps a <textarea>'s declared initial value", async () => {
    const dom = (await compile('<textarea>l1\n  l2</textarea>')).DOM
    expect(textOf(dom.body[0])).toBe('l1\n  l2')
  })

  // The negative control: collapsing everywhere else is correct and must stay,
  // or this fix is a different bug.
  it('still collapses everywhere else', async () => {
    const dom = (await compile('<div>a\n  b</div>')).DOM
    expect(textOf(dom.body[0])).toBe('a b')
  })
})

// ─── FJS-844 — a diagnostic names a place and the right construct ─────────────

describe('a compile error names a file, a line and a column (FJS-844)', () => {
  const broken = [
    ['an unclosed {#if}',        '<div>\n  {#if a}\n    x\n</div>'],
    ['an unclosed element',      '<div>\n  <span>x\n'],
    ['an unterminated mustache', '<div>\n  {foo\n</div>'],
    ['an unterminated tag',      '<div\n  class="x"\n'],
    ['a stray {/if}',            '<div>\n  {/if}\n</div>'],
    ['a stray {:else}',          '<div>\n  {:else}\n</div>'],
    ['a stray {/each}',          '<div>\n  {/each}\n</div>'],
    ['a duplicate {:else}',      '{#if a}A\n{:else}B\n{:else}C{/if}'],
  ]

  for (const [label, src] of broken) {
    it(`${label} names the file, line and column`, async () => {
      let msg = null
      try {
        await compile(src, { filename: 'Broken.mesa' })
      } catch (e) {
        msg = e.message
      }
      expect(msg, 'it must be refused at all').not.toBeNull()
      expect(msg).toMatch(/Broken\.mesa:\d+:\d+/)
    })
  }

  it('names the construct that is OPEN, not the close tag it wanted', async () => {
    // `Wrong close-tag: expected </undefined> got </div>` named a close tag,
    // which is not the problem, and interpolated `undefined` because the open
    // construct was a block with no `name`.
    let msg = null
    try {
      await compile('<div>{#if a}x</div>', { filename: 'Broken.mesa' })
    } catch (e) { msg = e.message }
    expect(msg).toMatch(/\{#if a\}/)
    expect(msg).not.toMatch(/undefined/)
  })

  it('says what is unclosed rather than the single word EOF', async () => {
    let msg = null
    try {
      await compile('<div>\n  <span>x\n', { filename: 'Broken.mesa' })
    } catch (e) { msg = e.message }
    // The vite surface pins `Unexpected EOF`, so it stays — what is added is
    // which construct never closed.
    expect(msg).toMatch(/Unexpected EOF/)
    expect(msg).toMatch(/<div>|<span>/)
  })

  it('never reports a bare AssertionError', async () => {
    for (const [, src] of broken) {
      let msg = ''
      try { await compile(src, { filename: 'Broken.mesa' }) } catch (e) { msg = e.message }
      expect(msg).not.toBe('AssertionError')
    }
  })

  it('reports the line the fault is on', async () => {
    let msg = null
    try {
      await compile('<div>\n  <p>ok</p>\n  {foo\n</div>', { filename: 'Broken.mesa' })
    } catch (e) { msg = e.message }
    expect(msg).toMatch(/Broken\.mesa:3:/)
  })
})
