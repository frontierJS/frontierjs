/**
 * parser-element-names.test.js — an error names the element that is in the file.
 *
 * `<mesa:window>` is a name and an argument: the parser reads `mesa`, then
 * `:window` separately, and every diagnostic built from the name alone
 * reported `<mesa>` — an element that exists nowhere, so searching the file
 * for it finds nothing. `<mesa:document>`, `<mesa:body>`, `<mesa:head>` and
 * `<mesa:element>` reach it the same way. This is FJS-844's *three of twelve
 * name the wrong construct* one case further along.
 *
 * The compiler under test is resolved through `MESA_COMPILER`, as
 * `parser-refusals.test.js` does, so this file can be run against a pre-fix
 * copy to measure that each row was red.
 */

import { describe, it, expect } from 'vitest'

const COMPILER = process.env.MESA_COMPILER ?? '../src/compiler.js'
const { compile } = await import(COMPILER)

const refusal = async (src) => {
  try {
    await compile(src)
    return null
  } catch (e) {
    return e.message
  }
}

describe('an unclosed <mesa:*> names itself (FJS-844)', () => {
  // A `<mesa:*>` element must be self-closing, so leaving the `/>` off is the
  // ordinary way to arrive here.
  for (const name of ['window', 'document', 'body', 'head', 'element']) {
    it(`says <mesa:${name}> rather than <mesa>`, async () => {
      const msg = await refusal(`<mesa:${name} this="div">\n<p>x</p>`)
      expect(msg).toContain(`<mesa:${name}>`)
      expect(msg).not.toMatch(/<mesa> is never closed/)
    })
  }

  it('still names a plain element by its own name', async () => {
    const msg = await refusal('<div>\n<p>x</p>')
    expect(msg).toContain('<div> is never closed')
  })

  it('names the argument in an unterminated tag too', async () => {
    const msg = await refusal('<mesa:window on:resize={f}\n<p>x</p>')
    expect(msg).toContain('<mesa:window>')
  })

  it('quotes the close tag as it was written', async () => {
    // `</mesa:window>` is compared on the half before the colon, but the
    // message is the author's line and must read back as their line.
    const msg = await refusal('<div><p>x</p></mesa:window></div>')
    expect(msg).toContain('</mesa:window>')
  })
})
