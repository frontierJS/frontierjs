/**
 * What a parse failure tells the author (`FJS-882`).
 *
 * The parser has known where it is the whole time — one `Reader` runs over the
 * whole source and every node carries `start` — and the failures did not say.
 * Two shapes cost the most:
 *
 *   - a close tag that matches nothing reported the CLOSE tag's line, which is
 *     the line the author wrote correctly. The line to go to is where the
 *     still-open construct was OPENED, and that one is only reachable if the
 *     message says it.
 *   - `<ul><li>a<li>b</ul>` is valid HTML. Mesa refuses it, which is a language
 *     choice, and the refusal said nothing about the choice — so an author who
 *     had written correct HTML was told only that something was still open.
 *
 * Every assertion here is on a POSITION or on the sentence that names the rule.
 * A message that merely mentions the right tag is not the fix: the old one did
 * that too.
 */
import { describe, it, expect } from 'vitest'
import { compileSource } from '../src/compiler.js'

const fails = async (src, filename = 'T.mesa') => {
  try {
    await compileSource(src, { filename, css: false, debug: false, dev: false })
  } catch (e) { return e.message }
  throw new Error('expected a parse failure, got a clean compile')
}

describe('a close tag that matches nothing', () => {
  it('names where the still-open construct was OPENED, not only where it failed', async () => {
    //  1 <script>…      2 <div>      3   <span>hello      4 </div>
    const msg = await fails(`<script>let a = 1</script>\n<div>\n  <span>hello\n</div>`)
    expect(msg, 'the open tag').toContain('opened at T.mesa:3:3')
    expect(msg, 'and the failure itself').toContain('T.mesa:4:1')
  })

  it('does it for a block too, whose line is the one nobody can guess', async () => {
    const msg = await fails(`<div>\n  {#if true}\n    <p>x</p>\n</div>`)
    expect(msg).toContain('{#if true} is still open, opened at T.mesa:2:3')
  })

  it('still names the tag the author actually wrote', async () => {
    // The comparison is on the half before the colon; the message quotes the
    // whole thing, or it names a tag that is in no file.
    const msg = await fails(`<div>\n  <span>x\n</mesa:window>`)
    expect(msg).toContain('</mesa:window> closes nothing here')
  })
})

describe('an end tag HTML lets you omit', () => {
  const OMITTABLE = {
    li: `<ul>\n  <li>a\n  <li>b\n</ul>`,
    p: `<div>\n  <p>a\n  <p>b\n</div>`,
    td: `<table><tr><td>a<td>b</tr></table>`,
    option: `<select>\n  <option>a\n  <option>b\n</select>`,
  }
  for (const [tag, src] of Object.entries(OMITTABLE)) {
    it(`<${tag}> — says which rule was broken, not just that something is open`, async () => {
      const msg = await fails(src)
      expect(msg).toContain(`HTML lets you omit </${tag}>; Mesa does not`)
    })
  }

  it('says it at EOF too, where there is no close tag to report against', async () => {
    const msg = await fails(`<ul>\n  <li>a`)
    expect(msg).toContain('HTML lets you omit </li>; Mesa does not')
  })

  it('does NOT say it for an element HTML requires you to close', async () => {
    // The sentence is for one case only. Under an unclosed `{#if}` or a
    // forgotten `</span>` it is a paragraph about end tags where the author is
    // already reading carefully.
    const span = await fails(`<div>\n  <span>x\n</div>`)
    expect(span).not.toContain('HTML lets you omit')
    const block = await fails(`<div>\n  {#if a}\n</div>`)
    expect(block).not.toContain('HTML lets you omit')
  })
})

describe('a CDATA section', () => {
  // It arrives by copy-paste out of an SVG an exporter wrote, not by choice, so
  // what it needs is not a refusal but instructions for the paste.
  const IN_SVG = `<div>\n  <svg>\n    <![CDATA[ x < y ]]>\n  </svg>\n</div>`

  it('is named, where it used to be thirty raw bytes', async () => {
    const msg = await fails(IN_SVG)
    expect(msg).toContain('<![CDATA[ … ]]> is not supported')
    expect(msg, 'and not the generic failure').not.toContain('Wrong syntax at')
  })

  it('says where it is', async () => {
    expect(await fails(IN_SVG)).toContain('T.mesa:3:5')
  })

  it('says what to write instead, in a spelling that survives the compiler', async () => {
    const msg = await fails(IN_SVG)
    expect(msg).toContain('&lt;')
    expect(msg).toContain('&lbrace;')
    // The advice is only advice if it works. Entities are passed through to the
    // template verbatim and decoded by the browser, so `&lbrace;` reaches the
    // page as `{` without the compiler ever seeing an operator.
    const ctx = await compileSource(`<div>&lbrace;a &lt; b&rbrace;</div>`,
      { filename: 'T.mesa', css: false, dev: false })
    expect(ctx.result).toContain('&lbrace;a &lt; b&rbrace;')
  })

  it('is refused outside a foreign subtree too, where it is not even XML-shaped', async () => {
    expect(await fails(`<div><![CDATA[ a ]]></div>`)).toContain('is not supported')
  })
})

describe('a parse failure with no message of its own', () => {
  // Four different malformed inputs land on one generic reader failure, and
  // none of them carried a position: `Wrong syntax at:` plus thirty raw bytes.
  const GENERIC = {
    'an unterminated close tag': [`<div>\n  x\n</div`, 3],
    'an unterminated comment':   [`<div>\n<!-- never ends and runs on and on and on\n`, 2],
    'a doctype':                 [`<!DOCTYPE html>\n<div>x</div>`, 1],
    'a processing instruction':  [`<div>\n  <?xml version="1.0"?>\n</div>`, 2],
  }
  for (const [what, [src, line]] of Object.entries(GENERIC)) {
    it(`${what} says which line it is on`, async () => {
      expect(await fails(src)).toMatch(new RegExp(`T\\.mesa:${line}:\\d+$`))
    })
  }

  it('quotes one line, not a run of them', async () => {
    // Thirty raw bytes from the offset ran past the newline, so the quoted
    // fragment held source the failure had nothing to do with.
    const msg = await fails(`<div>\n<!-- never ends and runs on and on and on\nsecond line\n`)
    expect(msg.split(' — ')[0]).not.toContain('\n')
    expect(msg).not.toContain('second line')
  })
})

describe('what must still compile', () => {
  it('a void element with no end tag', async () => {
    const ctx = await compileSource(`<div>\n  line<br>\n  more\n</div>`,
      { filename: 'T.mesa', css: false, dev: false })
    expect(ctx.result).toMatch(/<br\s*\/?>/)
  })

  it('a self-closed non-void element', async () => {
    const ctx = await compileSource(`<div>\n  <span />\n</div>`,
      { filename: 'T.mesa', css: false, dev: false })
    expect(ctx.result).toContain('<span>')
  })

  it('a fully closed table, which uses four of the omittable names', async () => {
    const ctx = await compileSource(
      `<table><tbody><tr><td>a</td></tr></tbody></table>`,
      { filename: 'T.mesa', css: false, dev: false })
    expect(ctx.result).toContain('<td>')
  })
})
