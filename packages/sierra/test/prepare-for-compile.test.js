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
import { prepareForCompile } from '../src/build/mesa-plugin.js'

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
