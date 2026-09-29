/**
 * test/static-layout-page.test.js — a prerendered layout reading `page`
 *
 * A layout that imported `page` from `@frontierjs/sierra/router` failed every
 * static page with *Unexpected #key*: the router re-exported RouterView.mesa,
 * and the prerender loads the router natively, with no Mesa loader to compile
 * it. Had the import loaded, `page` was never filled, so every page would have
 * read `pathname: '/'` and an empty `meta` where `vite dev` read the real route
 * (`FJS-1530`). The ksite stressor's shell reads both: the path for the active
 * menu item and the page's classes, and the frontmatter for its hero.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile, readFile, rm } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { build } from 'vite'

import { createSierraViteConfig } from '../src/build/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, 'tmp-static-layout-page')

const shell =
  '---\nrender: static\n---\n' +
  "<script>\n  import { page } from '@frontierjs/sierra/router'\n" +
  '  $: path = page.pathname\n  $: meta = page.meta\n</script>\n' +
  '<header data-path={path} data-title={meta.title} data-section={meta.section ?? \'none\'} ' +
  "data-hero={meta.hero ?? 'none'}></header>\n<main><slot /></main>\n"

const files = {
  'index.html':
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>t</title></head>\n' +
    '<body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>\n',
  'src/main.js': '// SPA entry — the static target still runs a normal Vite build first.\n',
  'src/routes/_module.mesa': shell,
  'src/routes/index.md': '---\ntitle: Home\n---\n\nHome page.\n',
  'src/routes/about.md': '---\ntitle: About\nhero: media\n---\n\nAbout page.\n',
  'src/routes/blog/_module.mesa': '---\nsection: Blog\n---\n<slot />\n',
  'src/routes/blog/post.md': '---\ntitle: Post\n---\n\nA post.\n',
}

beforeAll(async () => {
  await rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(TMP, path)), { recursive: true })
    await writeFile(join(TMP, path), content, 'utf8')
  }
  const config = createSierraViteConfig({ target: 'static', routesDir: 'src/routes', outDir: 'dist' })
  await build({ ...config, root: TMP, logLevel: 'silent' })
}, 120_000)

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const header = async (file) => {
  const html = await readFile(join(TMP, 'dist', file), 'utf8')
  return html.match(/<header[^>]*>/)?.[0] ?? ''
}

describe('a prerendered layout reads the route it is rendering', () => {
  test('the path and frontmatter of each page, not the initial /', async () => {
    expect(await header('index.html')).toMatch(/data-path="\/"[^>]*data-title="Home"/)
    expect(await header('about/index.html')).toMatch(/data-path="\/about\/"[^>]*data-title="About"/)
  })

  test("a parent layout's frontmatter is merged in, as a navigation merges it", async () => {
    expect(await header('blog/post/index.html')).toMatch(/data-title="Post" data-section="Blog"/)
  })

  // One process renders every route in turn, so a key one route set must not
  // survive into the next: /about/'s `hero` is absent from the pages after it.
  test("no page sees the frontmatter of the route rendered before it", async () => {
    expect(await header('about/index.html')).toMatch(/data-hero="media"/)
    expect(await header('blog/post/index.html')).toMatch(/data-hero="none"/)
    expect(await header('index.html')).toMatch(/data-section="none"[^>]*data-hero="none"/)
  })
})
