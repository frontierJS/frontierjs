#!/usr/bin/env bun
/*
 * build.js — produce a deployable dist/.
 *
 * There is no bundler here and there should not be one. The site is one HTML
 * file and one design system, and @frontierjs/css is plain CSS with no build
 * step. "Building" means exactly two things:
 *
 *   1. Vendor the design system into dist/css/ so the deployed page does not
 *      depend on a path outside its own directory.
 *   2. Rewrite the one stylesheet href to point at the vendored copy.
 *
 * The source index.html keeps its ../packages/css/src/index.css link on purpose,
 * so opening the file straight from the repo renders correctly and the page
 * always authors against the real stylesheet rather than a stale copy. The
 * rewrite happens on the way into dist/ and never touches the source — the
 * same reason css/demo serves the package root instead of copying it.
 */

import { file, write } from 'bun'
import { readdirSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { join, normalize, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here    = dirname(fileURLToPath(import.meta.url))
/* The stylesheets live under src/ as of @frontierjs/css v0.11. */
const cssPkg  = normalize(join(here, '..', 'packages', 'css', 'src'))
const dist    = join(here, 'dist')

const SRC_HREF = '../packages/css/src/index.css'
const OUT_HREF = './css/index.css'

const kb = n => `${(n / 1024).toFixed(1)} kB`

// ─── 1. Clean ────────────────────────────────────────────────────────────────

rmSync(dist, { recursive: true, force: true })
mkdirSync(join(dist, 'css'), { recursive: true })

// ─── 2. Vendor the design system ─────────────────────────────────────────────
// index.css @imports its siblings by relative path, so the tree has to be
// copied with its shape intact — the package groups its files into
// foundation/ themes/ components/ patterns/ a11y/ as of v0.11.
//
// This used to be a flat readdirSync of the package root. After the grouping
// that returned index.css and utilities.css and nothing else, and the
// `includes('index.css')` guard below still passed — so the build would have
// succeeded and deployed a site whose every @import 404s. Hence the count
// check: a design system is never two files.

function collectCss(dir, base = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      // Skip the package's own tooling — guide/, demo/, test/ are not shipped.
      if (['guide', 'demo', 'test', 'node_modules'].includes(entry.name)) continue
      out.push(...collectCss(join(dir, entry.name), rel))
    } else if (entry.name.endsWith('.css')) {
      out.push(rel)
    }
  }
  return out
}

const sheets = collectCss(cssPkg)
if (!sheets.includes('index.css')) {
  console.error(`\n  ✗ No index.css in ${cssPkg} — is @frontierjs/css still there?\n`)
  process.exit(1)
}
if (sheets.length < 20) {
  console.error(
    `\n  ✗ Only ${sheets.length} stylesheet(s) found under ${cssPkg}.\n` +
    `    The package ships 40+. Did its directory layout change?\n`
  )
  process.exit(1)
}

let cssBytes = 0
for (const rel of sheets) {
  const src = join(cssPkg, rel)
  cssBytes += statSync(src).size
  await write(join(dist, 'css', rel), file(src))
}

// ─── 3. Rewrite the stylesheet href on every page ────────────────────────────
// Every .html in the website root is a page. Adding one needs no build change.

const pages = readdirSync(here).filter(f => f.endsWith('.html'))
if (!pages.length) {
  console.error(`\n  ✗ No .html files in ${here}.\n`)
  process.exit(1)
}

const built = []
for (const name of pages) {
  let html = await file(join(here, name)).text()

  // A literal </script> inside a script block silently terminates it — the rest
  // of the page becomes text and every listener dies, with no console error to
  // find. It has happened three times authoring these pages, always in a code
  // sample. Write it as <\/script>. Checked here because the failure is silent
  // in a browser and obvious only in a DOM dump.
  const scriptBodies = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? []
  const closers = (html.match(/<\/script>/g) ?? []).length
  if (closers !== scriptBodies.length) {
    console.error(
      `\n  ✗ ${name}: ${closers} </script> tags but ${scriptBodies.length} script block(s).` +
      `\n    A code sample almost certainly contains a literal </script>.` +
      `\n    Write it as <\\/script> so it does not close the real one.\n`
    )
    process.exit(1)
  }

  if (!html.includes(SRC_HREF)) {
    // Fail loudly. A silent miss here ships a page with no stylesheet, and a
    // missing stylesheet is not an error in a browser — just an unstyled page.
    console.error(
      `\n  ✗ Expected '${SRC_HREF}' in ${name} and did not find it.` +
      `\n    The stylesheet link changed; update SRC_HREF in build.js.\n`
    )
    process.exit(1)
  }

  html = html.replaceAll(SRC_HREF, OUT_HREF)
  await write(join(dist, name), html)
  built.push([name, Buffer.byteLength(html)])
}

// ─── 3b. Copy shared front-end assets ────────────────────────────────────────
// Root-level .js/.css/.json the pages load directly. The build tooling itself
// (build.js, serve.js) and the workspace manifest never ship.
//
// .json is here because landscape.html fetches projects.json at runtime rather
// than inlining it — one source of truth, edited as data. A page that fetches a
// file the build does not copy is an empty page in dist/ and a working one in
// dev, which is the worst way to find out.

const TOOLING = new Set(['build.js', 'serve.js', 'package.json'])
const shared = readdirSync(here)
  .filter(f => (f.endsWith('.js') || f.endsWith('.css') || f.endsWith('.json')) && !TOOLING.has(f))

for (const name of shared) await write(join(dist, name), file(join(here, name)))

// ─── 4. Copy any other static assets ─────────────────────────────────────────
// public/ is optional — favicons, og images, robots.txt land here when they exist.

const publicDir = join(here, 'public')
let assets = 0
try {
  for (const name of readdirSync(publicDir)) {
    await write(join(dist, name), file(join(publicDir, name)))
    assets++
  }
} catch { /* no public/ yet — fine */ }

// ─── Report ──────────────────────────────────────────────────────────────────

console.log(`\n  @frontierjs/website → dist/\n`)
for (const [name, size] of built) console.log(`  ${name.padEnd(16)} ${kb(size)}`)
console.log(`  ${'shared'.padEnd(16)} ${shared.length} file${shared.length === 1 ? '' : 's'}  (${shared.join(', ')})`)
console.log(`  ${'css/'.padEnd(16)} ${kb(cssBytes)}  (${sheets.length} files)`)
if (assets) console.log(`  public/      ${assets} asset${assets === 1 ? '' : 's'}`)
console.log(`\n  preview → bun run preview\n`)
