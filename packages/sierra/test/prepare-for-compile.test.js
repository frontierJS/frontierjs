/**
 * test/prepare-for-compile.test.js — the one preparation both builds share
 *
 * The Vite transform and the `static` prerender each compile every Mesa file,
 * and they used to prepare it separately: only the transform injected
 * auto-imports, so `<Hero />` rendered in dev and failed the build
 * (`FJS-1491`); and the transform stripped a `.md` file's frontmatter, so its
 * keys were props in the build and undeclared names in dev (`FJS-1492`).
 */

import { describe, test, expect } from 'vitest'
import { locLines, prepareForCompile } from '../src/build/mesa-plugin.js'

const map = new Map([
  ['Hero', { kind: 'default', from: '/app/content/blocks/Hero.md', imported: null }],
  ['company_name', { kind: 'named', from: '@/settings.js', imported: 'company_name' }],
])

describe('prepareForCompile — a .md file', () => {
  const md = '---\nlayout: Block\nclasses: bg-block\n---\n\n<Hero />\n\nBy {company_name}.\n'

  test('keeps its frontmatter at the top, where compileMd reads it', () => {
    expect(prepareForCompile(md, '/app/src/routes/index.md', map)).toMatch(/^---\nlayout: Block\nclasses: bg-block\n---\n/)
  })

  test('puts the injected script directly after the frontmatter', () => {
    const out = prepareForCompile(md, '/app/src/routes/index.md', map)
    const body = out.slice(out.indexOf('\n---\n') + 5)
    expect(body).toMatch(/^<script>\n/)
    expect(body).toContain("import Hero from '/app/content/blocks/Hero.md'")
    expect(body).toContain("import { company_name } from '@/settings.js'")
  })

  test('with no auto-imports, the file is handed over whole', () => {
    expect(prepareForCompile(md, '/app/src/routes/index.md', new Map())).toBe(md)
  })

  test('leaves fenced code to compileMd, which owns fences in Markdown', () => {
    const fenced = '---\ntitle: T\n---\n\n```js\nconst a = {b: 1}\n```\n'
    expect(prepareForCompile(fenced, '/app/src/routes/doc.md', new Map())).toBe(fenced)
  })

  test('a redirect-only route is still never compiled', () => {
    expect(prepareForCompile('---\nredirect: /elsewhere/\n---\n', '/app/src/routes/old.md', map)).toBe(null)
  })
})

describe('prepareForCompile — a .mesa file', () => {
  // The negative control: a .mesa route's frontmatter is build metadata and is
  // still removed before Mesa sees the file.
  test('its frontmatter is still stripped', () => {
    const out = prepareForCompile('---\nrender: static\n---\n<Hero />\n', '/app/src/routes/index.mesa', map)
    expect(out).not.toContain('render: static')
    expect(out).toContain("import Hero from '/app/content/blocks/Hero.md'")
  })
})

// The compiler stamps `data-fjs-loc` from what it was handed, and preparation
// inserts and drops lines: every element below an auto-import opened its source
// a line off, and below a frontmatter block three lines the other way.
describe('locLines — each prepared line back to the file\'s', () => {
  const line = (orig, prep, text) => locLines(orig, prep)[prep.split('\n').findIndex(l => l.includes(text))]

  test('nothing moved: no map', () => {
    expect(locLines('<p>a</p>\n', '<p>a</p>\n')).toBeNull()
  })

  test('an auto-import and a slot prop, inserted after the script tag', () => {
    const src = '<script>\n  let a = 1\n</script>\n\n<main>\n  <slot />\n  <p>after</p>\n</main>\n'
    const prepared = prepareForCompile(src, '/app/content/routes/_module.mesa', map)
    expect(prepared).not.toBe(src)
    expect(line(src, prepared, '<p>after</p>')).toBe(7)
    expect(line(src, prepared, '<main>')).toBe(5)
  })

  test('a frontmatter block stripped from a .mesa route', () => {
    const src = '---\ntitle: Home\n---\n<h1>Hi</h1>\n<p>there</p>\n'
    const prepared = prepareForCompile(src, '/app/content/routes/index.mesa', null)
    expect(line(src, prepared, '<h1>')).toBe(4)
    expect(line(src, prepared, '<p>there')).toBe(5)
  })

  test('a script block synthesized above markup that had none', () => {
    const src = '<div>\n  <Hero />\n</div>\n'
    const prepared = prepareForCompile(src, '/app/content/routes/index.mesa', map)
    expect(prepared.startsWith('<script>')).toBe(true)
    expect(line(src, prepared, '<div>')).toBe(1)
    expect(line(src, prepared, '<Hero')).toBe(2)
  })
})
