/**
 * test/static-omit.test.js — what a static build leaves out, and says so
 *
 * A `status: draft` page was prerendered and published at its URL, while the
 * route table, the sitemap and llms.txt all left it out (`FJS-1533`). A route
 * declaring `redirect:` was prerendered too and listed in sitemap.xml and
 * llms.txt beside the `_redirects` line that moves it (`FJS-1534`). And a
 * `plugins` entry's `closeBundle`, the post-build hook, was also handed to
 * Vite, which called it first with no context (`FJS-1535`). Found by the ksite
 * stressor, whose template writes drafts and a `_redirects` of its own.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdir, writeFile, readFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { build } from 'vite'

import { createSierraViteConfig } from '../src/build/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, 'tmp-static-omit')

const files = {
  'index.html':
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>t</title></head>\n' +
    '<body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>\n',
  'src/main.js': '// SPA entry — the static target still runs a normal Vite build first.\n',
  'src/routes/_module.mesa': '---\nrender: static\n---\n<main><slot /></main>\n',
  'src/routes/index.md': '---\ntitle: Home\n---\n\nHome.\n',
  'src/routes/about.md': '---\ntitle: About\n---\n\nAbout.\n',
  'src/routes/secret.md': '---\ntitle: Secret\nstatus: draft\n---\n\nNot yet.\n',
  'src/routes/old-about.md': '---\ntitle: Old About\nredirect: /about/\n---\n\nThe old page.\n',
}

const calls = []
const log = vi.spyOn(console, 'log')
// Read inside beforeAll: vitest clears every spy's calls before each test.
let logged = ''

beforeAll(async () => {
  await rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(TMP, path)), { recursive: true })
    await writeFile(join(TMP, path), content, 'utf8')
  }
  const config = createSierraViteConfig({
    target: 'static', routesDir: 'src/routes', outDir: 'dist',
    siteUrl: 'https://example.test', llms: true,
    // Written as the README shows it: the context destructured in the signature.
    plugins: [{ name: 'app:post', closeBundle({ outDir }) { calls.push(outDir) } }],
  })
  await build({ ...config, root: TMP, logLevel: 'silent' })
  logged = log.mock.calls.flat().join('\n')
}, 120_000)

afterAll(async () => {
  log.mockRestore()
  await rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const dist = (f) => join(TMP, 'dist', f)

describe('a draft is not published', () => {
  test('no file at its URL, and not in sitemap.xml or llms.txt', async () => {
    expect(existsSync(dist('secret/index.html'))).toBe(false)
    expect(await readFile(dist('sitemap.xml'), 'utf8')).not.toContain('/secret/')
    expect(await readFile(dist('llms.txt'), 'utf8')).not.toContain('/secret/')
  })
})

describe('a redirect is the host\'s, not a page', () => {
  test('_redirects moves it, and no file shadows the move', async () => {
    expect(await readFile(dist('_redirects'), 'utf8')).toMatch(/\/old-about\/\s+\/about\/\s+301/)
    expect(existsSync(dist('old-about/index.html'))).toBe(false)
  })

  test('neither sitemap.xml nor llms.txt lists the old URL', async () => {
    const sitemap = await readFile(dist('sitemap.xml'), 'utf8')
    const llms = await readFile(dist('llms.txt'), 'utf8')
    expect(sitemap).toContain('https://example.test/about/')
    expect(sitemap).not.toContain('/old-about/')
    expect(llms).toContain('[About](/about/)')
    expect(llms).not.toContain('/old-about/')
  })
})

test('the build names what it left out, and why', () => {
  expect(logged).toMatch(/Not prerendered, by their frontmatter/)
  expect(logged).toMatch(/\/secret\/ — a draft/)
  expect(logged).toMatch(/\/old-about\/ — redirects to \/about\//)
})

test('a post-build plugin is called once, with the output directory', () => {
  expect(calls).toEqual([join(TMP, 'dist')])
})
