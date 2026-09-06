/*
 * tests/prune-unreachable.test.js — what a static build publishes.
 *
 * A `target: 'static'` build produces the SPA client and then prerenders over
 * it, so the entry, the route table and one chunk per route are published and
 * loadable by no page in the directory (`FJS-904`). This grades the pass that
 * takes them back out.
 *
 * Every removal here is PAIRED with a file one edge away that must survive,
 * because a pass that emptied `assets/` would satisfy any test that only asked
 * whether the dead chunk is gone.
 */

import { describe, test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { pruneUnreachable } from '../src/build/prune-unreachable.js'

/** A published directory: pages at `files`, scripts at `assets`. */
function site(files, assets) {
  const dir = mkdtempSync(join(tmpdir(), 'sierra-prune-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), body)
  }
  for (const [name, body] of Object.entries(assets)) writeFileSync(join(dir, 'assets', name), body)
  return dir
}

const js = (name) => readdirSync(join(name, 'assets')).sort()

describe('a script no page can reach is not published', () => {
  test('the SPA entry goes and the island entry stays', async () => {
    const dir = site(
      { 'index.html': '<script type="module" src="/assets/islands-aaa.js"></script>' },
      { 'islands-aaa.js': 'console.log(1)', 'index-bbb.js': 'console.log(2)' },
    )
    const out = await pruneUnreachable({ outDir: dir })
    expect(out.removed).toEqual(['index-bbb.js'])
    expect(js(dir)).toEqual(['islands-aaa.js'])
    rmSync(dir, { recursive: true })
  })

  test('a chunk the entry lazy-loads by name is reached, and its sibling is not', async () => {
    // Vite writes a dynamic import as a literal filename, which is the whole
    // reason the walk can be a text walk. The sibling is the control: both are
    // one hop from the root in the directory listing and only one is in the code.
    const dir = site(
      { 'index.html': '<script src="/assets/islands-aaa.js"></script>' },
      {
        'islands-aaa.js':      'import("./island-BuyBox-ccc.js")',
        'island-BuyBox-ccc.js': 'export const x = 1',
        'island-Gone-ddd.js':   'export const y = 2',
      },
    )
    const out = await pruneUnreachable({ outDir: dir })
    expect(out.removed).toEqual(['island-Gone-ddd.js'])
    expect(js(dir)).toEqual(['island-BuyBox-ccc.js', 'islands-aaa.js'])
    rmSync(dir, { recursive: true })
  })

  test('a page nested in its own directory is a root like any other', async () => {
    // Every page but the home page lives at `<route>/index.html` under
    // `trailingSlash: 'always'`, so a walk that read only the top level would
    // find one root and delete the site.
    const dir = site(
      {
        'index.html':               '<h1>home</h1>',
        'products/tee/index.html':  '<script src="/assets/islands-aaa.js"></script>',
      },
      { 'islands-aaa.js': 'x', 'index-bbb.js': 'y' },
    )
    const out = await pruneUnreachable({ outDir: dir })
    expect(out.removed).toEqual(['index-bbb.js'])
    rmSync(dir, { recursive: true })
  })

  test('an SPA shell that survived prerendering keeps its whole graph', async () => {
    // A static build with no route at `/` leaves Vite's own index.html in place.
    // Nothing about that is special-cased: the shell references the entry, so
    // the walk reaches it, which is what stops the pass assuming what the
    // prerenderer wrote.
    const dir = site(
      { 'index.html': '<script src="/assets/index-bbb.js"></script>' },
      { 'index-bbb.js': 'import("./routes-ccc.js")', 'routes-ccc.js': 'z' },
    )
    const out = await pruneUnreachable({ outDir: dir })
    expect(out.removed).toEqual([])
    expect(js(dir)).toEqual(['index-bbb.js', 'routes-ccc.js'])
    rmSync(dir, { recursive: true })
  })

  test('only JavaScript is considered — the stylesheet every page links is untouched', async () => {
    const dir = site(
      { 'index.html': '<link rel="stylesheet" href="/assets/style-eee.css">' },
      { 'style-eee.css': 'body{}', 'index-bbb.js': 'x' },
    )
    await pruneUnreachable({ outDir: dir })
    expect(js(dir)).toEqual(['style-eee.css'])
    rmSync(dir, { recursive: true })
  })
})

describe('the refusal is on the walk, never on a file', () => {
  test('scripts and no page at all is refused rather than emptied', async () => {
    // An empty root set reads as "nothing is reachable", so the permissive pass
    // becomes the destructive one exactly where it has the least to go on.
    const dir = site({}, { 'index-bbb.js': 'x' })
    await expect(pruneUnreachable({ outDir: dir })).rejects.toThrow(/nothing to walk reachability FROM/)
    expect(js(dir)).toEqual(['index-bbb.js'])
    rmSync(dir, { recursive: true })
  })

  test('a page and no assets directory is not an error', async () => {
    // A site whose every page ships zero JavaScript is the target working, not
    // a build that lost its output.
    const dir = mkdtempSync(join(tmpdir(), 'sierra-prune-'))
    writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>')
    await expect(pruneUnreachable({ outDir: dir })).resolves.toEqual({ removed: [], kept: [], bytes: 0 })
    rmSync(dir, { recursive: true })
  })
})
