/**
 * md-loc.test.js
 *
 * `data-fjs-loc` on a `.md` file's elements names a line of the FILE. The
 * Markdown compiles to a Mesa template whose lines are not the file's, so an
 * 11-line file stamped its heading `x.md:12:1` and alt-click opened the wrong
 * line (FJS-1711).
 */

import { describe, it, expect } from 'vitest'
import { compileMd } from '../src/compiler-md.js'

const locs = (ctx) => [...ctx.result.matchAll(/<(\w+)[^>]* data-fjs-loc="([^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`)

const SRC =
  '---\ntitle: T\n---\n<script>\n  let n = 1\n</script>\n\n# Head\n\nPara one\nstill one.\n\n- a\n- b\n\n{#if n}\nyes **bold**\n{/if}\n'

describe('data-fjs-loc on Markdown', () => {
  it('names the line of the file, past frontmatter and the script block', async () => {
    const ctx = await compileMd(SRC, { filename: '/r/x.md', locRoot: '/r', loc: true })
    expect(locs(ctx)).toEqual([
      'h1 x.md:8:1',
      'p x.md:10:1',
      'ul x.md:13:1',
      'li x.md:13:1',
      'li x.md:14:1',
      'p x.md:17:1',
      'strong x.md:17:5',
    ])
  })

  it('counts from the top of a file with no frontmatter and no script', async () => {
    const ctx = await compileMd('# One\n\ntwo\n', { filename: '/r/y.md', locRoot: '/r', loc: true })
    expect(locs(ctx)).toEqual(['h1 y.md:1:1', 'p y.md:3:1'])
  })

  it('stamps nothing when loc is off', async () => {
    const ctx = await compileMd(SRC, { filename: '/r/x.md', locRoot: '/r', loc: false })
    expect(ctx.result).not.toContain('data-fjs-loc')
    expect(ctx.markdownHTML).not.toContain('data-fjs-loc')
  })
})

// FJS-2117: raw HTML in prose is text to remark, so it is stamped in the raw.
describe('data-fjs-loc on raw HTML in Markdown', () => {
  const RAW =
    '# Head\n\nSome <span class="a">raw</span> and <Counter start={1} /> here.\n\n<div class="box" title="a > b">\nblock\n  <em>x</em>\n</div>\n'

  it('names the file line and column of each raw tag', async () => {
    const ctx = await compileMd(RAW, { filename: '/r/x.md', locRoot: '/r', loc: true })
    expect(locs(ctx)).toEqual([
      'h1 x.md:1:1',
      'p x.md:3:1',
      'span x.md:3:11',
      'div x.md:5:1',
      'em x.md:7:3',
    ])
  })

  it('counts past frontmatter and the script block', async () => {
    const src = '---\ntitle: T\n---\n<script>\n  let n = 1\n</script>\n\nhi <b>there</b>\n'
    const ctx = await compileMd(src, { filename: '/r/x.md', locRoot: '/r', loc: true })
    expect(locs(ctx)).toEqual(['p x.md:8:1', 'b x.md:8:4'])
  })
})
