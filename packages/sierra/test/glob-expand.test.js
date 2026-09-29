/**
 * test/glob-expand.test.js — `import.meta.glob` in a prerendered page
 *
 * The prerender compiles through Mesa's `renderComponent` and Bun imports the
 * result, and Bun has no `import.meta.glob`, so a block listing a content
 * collection rendered in `vite dev` and failed `site:build` (the ksite stressor,
 * Q2). `expandGlobs` turns an eager glob into the static imports it stands for,
 * keyed and ordered as Vite's own glob keys and orders them.
 *
 * The second half is a real static build: a Markdown page whose block lists a
 * collection, reading each item's body and its frontmatter.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile, readFile, rm } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { build } from 'vite'

import { expandGlobs } from '../src/build/glob-expand.js'
import { createSierraViteConfig } from '../src/build/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, 'tmp-glob-expand')

const files = {
  'index.html':
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>t</title></head>\n' +
    '<body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>\n',
  'src/main.js': '// SPA entry — the static target still runs a normal Vite build first.\n',
  'src/routes/index.md': '---\ntitle: Home\nrender: static\n---\n\n<Reviews />\n',
  // Written in the house style: indented imports in a module script, which the
  // render followed only the first of (mesa's IMPORT_RE).
  'src/blocks/Reviews.mesa':
    '<script module>\n' +
    "  const reviews = Object.values(import.meta.glob('../../content/reviews/*.md', { eager: true }))\n" +
    '    .map((m) => ({ ...m.frontmatter, Body: m.default }))\n' +
    '</script>\n' +
    '<ol>{#each reviews as { reviewer, rating, Body }}<li><cite>{reviewer} {rating}</cite><Body /></li>{/each}</ol>\n',
  // Sorted by path, so 10- comes before 2- — Vite's order, kept.
  'content/reviews/1-stacy.md': '---\nreviewer: Stacy\nrating: 5\n---\n\nThe best in town.\n',
  'content/reviews/2-jimmy.md': '---\nreviewer: Jimmy\nrating: 4\n---\n\nOn time, every time.\n',
  'content/reviews/10-karl.md': '---\nreviewer: Karl\nrating: 3\n---\n\nFine.\n',
  'content/reviews/notes.txt': 'not a review\n',
}

beforeAll(async () => {
  await rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(TMP, path)), { recursive: true })
    await writeFile(join(TMP, path), content, 'utf8')
  }
}, 60_000)

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const block = () => join(TMP, 'src/blocks/Reviews.mesa')

describe('expandGlobs', () => {
  test('an eager glob becomes static imports, keyed and sorted as Vite does', async () => {
    const out = expandGlobs(await readFile(block(), 'utf8'), block())
    expect(out).not.toContain('import.meta.glob')
    const keys = [...out.matchAll(/"(\.\.\/\.\.\/content\/reviews\/[^"]+)": __sierra_glob_/g)].map((m) => m[1])
    expect(keys).toEqual([
      '../../content/reviews/1-stacy.md',
      '../../content/reviews/10-karl.md',
      '../../content/reviews/2-jimmy.md',
    ])
    expect(out).toMatch(/import \* as __sierra_glob_0 from "\.\.\/\.\.\/content\/reviews\/1-stacy\.md"/)
  })

  test('`import:` narrows each value to that export', () => {
    const src = "<script>\n  const fm = import.meta.glob('../../content/reviews/*.md', { eager: true, import: 'frontmatter' })\n</script>\n"
    const out = expandGlobs(src, block())
    expect(out).toMatch(/import \{ frontmatter as __sierra_glob_0 \} from/)
  })

  test('a glob never lists the file it is written in', () => {
    const src = "<script>\n  const all = import.meta.glob('./*.mesa', { eager: true })\n</script>\n"
    const out = expandGlobs(src, block())
    expect(out).not.toContain('Reviews.mesa')
  })

  test('a lazy glob throws only when evaluated, naming the fix', () => {
    const src = "<script>\n  const later = () => import.meta.glob('../../content/reviews/*.md')\n</script>\n"
    const out = expandGlobs(src, block())
    expect(out).toContain('const later = () => (() => { throw')
    const thunk = out.match(/\(\(\) => \{ throw [\s\S]*?\}\)\(\)/)[0]
    expect(() => new Function(thunk)()).toThrow(/is lazy.*eager: true/)
  })

  test('an option it cannot honour is refused by name', () => {
    const src = "<script>\n  const raw = import.meta.glob('../../content/reviews/*.md', { eager: true, query: '?raw' })\n</script>\n"
    expect(() => expandGlobs(src, block())).toThrow(/cannot be prerendered/)
  })

  // Vite resolves a leading / against its root, which is the only way a
  // component in a package can list the app's files (FJS-1553).
  test('a root glob resolves against the root, keyed as Vite keys it', () => {
    const src = "<script>\n  const all = import.meta.glob('/content/reviews/*.md', { eager: true })\n</script>\n"
    const out = expandGlobs(src, '/elsewhere/node_modules/kit/Block.mesa', TMP)
    const keys = [...out.matchAll(/"([^"]+)": __sierra_glob_/g)].map((m) => m[1])
    expect(keys).toEqual(['/content/reviews/1-stacy.md', '/content/reviews/10-karl.md', '/content/reviews/2-jimmy.md'])
    expect(out).toContain(`from ${JSON.stringify(join(TMP, 'content/reviews/1-stacy.md'))}`)
  })

  test('a root glob with no root to resolve against is refused', () => {
    const src = "<script>\n  const all = import.meta.glob('/content/reviews/*.md', { eager: true })\n</script>\n"
    expect(() => expandGlobs(src, block())).toThrow(/relative to the file/)
  })

  test('a file with no glob is returned as it was', () => {
    const src = '<script>\n  let x = 1\n</script>\n<p>{x}</p>\n'
    expect(expandGlobs(src, block())).toBe(src)
  })
})

describe('a static build of a page that lists a collection', () => {
  test('prerenders every item, its body and its frontmatter, in order', async () => {
    const config = createSierraViteConfig({
      target: 'static',
      routesDir: 'src/routes',
      outDir: 'dist',
      autoImport: { components: ['src/blocks'] },
    })
    await build({ ...config, root: TMP, logLevel: 'silent' })

    const html = await readFile(join(TMP, 'dist/index.html'), 'utf8')
    const cites = [...html.matchAll(/<cite>([^<]*)<\/cite>/g)].map((m) => m[1])
    expect(cites).toEqual(['Stacy 5', 'Karl 3', 'Jimmy 4'])
    expect(html).toContain('The best in town.')
    expect(html).toContain('On time, every time.')
    expect(html).not.toContain('not a review')
  }, 60_000)
})
