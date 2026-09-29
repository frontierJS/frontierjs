/**
 * test/static-autoimport-build.test.js — a `target: 'static'` build over a
 * Markdown page that imports nothing
 *
 * `autoImport` was the Vite plugin's alone. The prerender compiles every page
 * through Mesa's `renderComponent`, which reads each file from disk, so a page
 * that rendered in `vite dev` failed the only build a site ships with
 * *Hero is not defined* (`FJS-1491`). And the plugin stripped a `.md` file's
 * frontmatter before Mesa could turn it into props, so the two builds disagreed
 * about those too (`FJS-1492`).
 *
 * The shape is the ksite stressor's `index.md`: a route written in Markdown,
 * naming a block that is itself Markdown, which names a `.mesa` component whose
 * doc comment shows its own tag (`FJS-1499`), plus a site setting read bare in
 * prose. The block names its wrapper with `layout:`, and the route sits under a
 * `_module.mesa` whose `<slot />` the build rewrites, so a layout handed
 * element children it cannot render would warn (`FJS-1493`, `FJS-1491`).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdir, writeFile, readFile, rm } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { build } from 'vite'

import { createSierraViteConfig } from '../src/build/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, 'tmp-static-autoimport')

const files = {
  'index.html':
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>t</title></head>\n' +
    '<body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>\n',
  'src/main.js': '// SPA entry — the static target still runs a normal Vite build first.\n',
  'src/settings.js': "export const company_name = 'Acme Cleaning'\n",
  'src/routes/index.md': '---\ntitle: Home\nrender: static\n---\n\n<Hero />\n',
  'src/routes/_module.mesa': '<main class="shell"><slot /></main>\n',
  'src/layouts/Block.mesa':
    "<script>\n  export let classes = ''\n</script>\n<section class=\"block {classes}\"><slot /></section>\n",
  'content/blocks/Hero.md':
    '---\nlayout: Block\nclasses: bg-block\n---\n\n# Welcome to {company_name}\n\n<Badge label={classes} />\n',
  'src/blocks/Badge.mesa':
    '<!--\n  Used as <Badge label="new" />.\n-->\n<script>\n  export let label = \'\'\n</script>\n' +
    '<span class="badge">{label}</span>\n',
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

describe('a static build of a Markdown page with nothing imported', () => {
  test('prerenders the block, its component, its frontmatter prop and the setting', async () => {
    const config = createSierraViteConfig({
      target: 'static',
      routesDir: 'src/routes',
      outDir: 'dist',
      autoImport: {
        components: ['content/blocks', 'src/blocks'],
        modules: { '@/settings.js': ['company_name'] },
      },
      markdownLayouts: ['src/layouts'],
    })
    const warn = vi.spyOn(console, 'warn')
    try {
      await build({ ...config, root: TMP, logLevel: 'silent' })
      expect(warn.mock.calls.flat().join('\n')).not.toMatch(/was given children/)
    } finally {
      warn.mockRestore()
    }

    const html = await readFile(join(TMP, 'dist/index.html'), 'utf8')
    expect(html).toContain('Welcome to Acme Cleaning')
    expect(html).toContain('<span class="badge')
    expect(html).toMatch(/<span class="badge[^"]*">bg-block<\/span>/)
    // Wrapped by the layout, inside the route's own layout.
    expect(html).toMatch(/<main class="shell[^"]*"><section class="block bg-block[^"]*"><h1[^>]*>Welcome to Acme Cleaning<\/h1>/)
  }, 180_000)
})
