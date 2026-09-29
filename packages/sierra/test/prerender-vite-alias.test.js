/**
 * test/prerender-vite-alias.test.js — a prerendered page resolves what Vite does
 *
 * The ksite engine, moved into a package, names the client's content as
 * `@content/…` (an alias it adds to Vite) and lists a collection with a root
 * glob, `/content/…`. Both rendered in `vite dev` and both failed the static
 * build: the prerender knew only `@` (FJS-1551) and only a file-relative glob
 * (FJS-1553).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile, readFile, rm } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { build } from 'vite'

import { createSierraViteConfig, pathAliases } from '../src/build/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, 'tmp-prerender-vite-alias')

const files = {
  'index.html':
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>t</title></head>\n' +
    '<body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>\n',
  'src/main.js': '// SPA entry\n',
  'src/routes/index.md': '---\ntitle: Home\nrender: static\n---\n\n<Footer />\n',
  'src/blocks/Footer.mesa':
    '<script module>\n' +
    "  import { site } from '@content/settings/site.js'\n" +
    "  import Hours from '@content/settings/hours.md'\n" +
    "  const features = Object.values(import.meta.glob('/content/features/*.md', { eager: true }))\n" +
    '</script>\n' +
    '<footer><b>{site.name}</b><Hours />{#each features as f}<i>{f.frontmatter.name}</i>{/each}</footer>\n',
  'content/settings/site.js': "export const site = { name: 'Acme Plumbing' }\n",
  'content/settings/hours.md': 'Open *every* day.\n',
  'content/features/a.md': '---\nname: Fast\n---\n',
  'content/features/b.md': '---\nname: Clean\n---\n',
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

describe('pathAliases', () => {
  test('keeps a string key naming a path, and nothing else', () => {
    expect(pathAliases([
      { find: '@content', replacement: '/site/content' },
      { find: /^\/?@vite\/env/, replacement: '/x' },
      { find: 'react', replacement: 'preact/compat' },
    ])).toEqual({ '@content': '/site/content' })
    expect(pathAliases({ '@c': '/c', lib: 'lib-b' })).toEqual({ '@c': '/c' })
    expect(pathAliases(undefined)).toEqual({})
  })
})

describe('a static build of a page naming an app alias and a root glob', () => {
  test('prerenders what vite dev renders', async () => {
    const config = createSierraViteConfig({
      target: 'static',
      routesDir: 'src/routes',
      outDir: 'dist',
      autoImport: { components: ['src/blocks'] },
    })
    await build({
      ...config,
      root: TMP,
      logLevel: 'silent',
      resolve: { ...(config.resolve ?? {}), alias: { '@content': join(TMP, 'content') } },
    })

    const html = await readFile(join(TMP, 'dist/index.html'), 'utf8')
    expect(html).toContain('<b>Acme Plumbing</b>')
    expect(html).toContain('<em>every</em>')
    expect([...html.matchAll(/<i>([^<]*)<\/i>/g)].map((m) => m[1])).toEqual(['Fast', 'Clean'])
  }, 60_000)
})
