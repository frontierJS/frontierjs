/**
 * test/static-unminified.test.js — a bundle no page can reach is not minified
 *
 * A static build renders the SPA bundle for its stylesheet and then deletes
 * every chunk (prune-unreachable.js). Minifying and gzip-measuring those chunks
 * was a third of a 23-page site's build. `bundleUnreachable` decides from the
 * route tree before the bundle, the postbuild plugin's `config` hook acts on
 * it, and the prune refuses if the prediction was wrong.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdir, writeFile, readFile, readdir, rm } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { build } from 'vite'

import { createSierraViteConfig } from '../src/build/index.js'
import { bundleUnreachable } from '../src/build/prune-unreachable.js'
import { scan } from '../src/scanner/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, 'tmp-static-unminified')

async function writeAll(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content, 'utf8')
  }
}

const shell = {
  'index.html':
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>t</title></head>\n' +
    '<body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>\n',
  'src/main.js': "import './style.css'\nexport const answer = 42\nexport function longName(aLongParameter) { return aLongParameter + answer }\n",
  'src/style.css': 'body {\n  margin: 0;\n}\n\nmain {\n  padding: 1rem;\n}\n',
  'src/routes/_module.mesa': '---\nrender: static\n---\n<main><slot /></main>\n',
  'src/routes/index.md': '---\ntitle: Home\n---\n\nHome.\n',
  'src/routes/about.md': '---\ntitle: About\n---\n\nAbout.\n',
}

beforeAll(async () => {
  await rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
afterAll(async () => {
  if (!process.env.KEEP_TMP) await rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('bundleUnreachable reads the tree', () => {
  async function treeOf(name, files) {
    const dir = join(TMP, name)
    await writeAll(dir, files)
    return scan('src/routes', { cwd: dir })
  }

  test('every route static and a published home: nothing can reach the bundle', async () => {
    expect(bundleUnreachable(await treeOf('all', shell))).toBe(true)
  })

  test('a home that is a draft leaves the SPA shell in place', async () => {
    expect(bundleUnreachable(await treeOf('draft', {
      ...shell,
      'src/routes/index.md': '---\ntitle: Home\nstatus: draft\n---\n\nHome.\n',
    }))).toBe(false)
  })

  test('a home that redirects leaves the SPA shell in place', async () => {
    expect(bundleUnreachable(await treeOf('redirect', {
      ...shell,
      'src/routes/index.md': '---\ntitle: Home\nredirect: /about/\n---\n\nHome.\n',
    }))).toBe(false)
  })

  test('one client-routed route keeps the bundle', async () => {
    expect(bundleUnreachable(await treeOf('mixed', {
      ...shell,
      'src/routes/live.mesa': '---\nrender: spa\n---\n<p>live</p>\n',
    }))).toBe(false)
  })

  test('no home route at all keeps the shell', async () => {
    const files = { ...shell }
    delete files['src/routes/index.md']
    expect(bundleUnreachable(await treeOf('nohome', files))).toBe(false)
  })
})

describe('the build acts on it', () => {
  let log, logged = ''
  const dir = join(TMP, 'build')

  beforeAll(async () => {
    log = vi.spyOn(console, 'log')
    await writeAll(dir, shell)
    const config = createSierraViteConfig({ target: 'static', routesDir: 'src/routes', outDir: 'dist' })
    await build({ ...config, root: dir, logLevel: 'silent' })
    logged = log.mock.calls.flat().join('\n')
  }, 120_000)
  afterAll(() => log.mockRestore())

  test('says the chunks were built unminified, and none ship', async () => {
    expect(logged).toContain('built without a minifier')
    const assets = await readdir(join(dir, 'dist/assets'))
    expect(assets.filter((f) => f.endsWith('.js'))).toEqual([])
  })

  test('the stylesheet is still minified', async () => {
    const assets = await readdir(join(dir, 'dist/assets'))
    const css = assets.find((f) => f.endsWith('.css'))
    expect(css).toBeDefined()
    const text = await readFile(join(dir, 'dist/assets', css), 'utf8')
    expect(text).toContain('body{margin:0}main{padding:1rem}')
  })
})

describe('an app that states build.minify keeps its word', () => {
  let log, logged = ''
  const dir = join(TMP, 'stated')

  beforeAll(async () => {
    log = vi.spyOn(console, 'log')
    await writeAll(dir, shell)
    const config = createSierraViteConfig({
      target: 'static', routesDir: 'src/routes', outDir: 'dist',
      vite: { build: { minify: 'oxc' } },
    })
    await build({ ...config, root: dir, logLevel: 'silent' })
    logged = log.mock.calls.flat().join('\n')
  }, 120_000)
  afterAll(() => log.mockRestore())

  test('the prune still runs and the line is absent', () => {
    expect(logged).toContain('Published 0 script(s)')
    expect(logged).not.toContain('built without a minifier')
  })
})
