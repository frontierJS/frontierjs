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
 * The source index.html keeps its ../packages/css/index.css link on purpose,
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
const cssPkg  = normalize(join(here, '..', 'packages', 'css'))
const dist    = join(here, 'dist')

const SRC_HREF = '../packages/css/index.css'
const OUT_HREF = './css/index.css'

const kb = n => `${(n / 1024).toFixed(1)} kB`

// ─── 1. Clean ────────────────────────────────────────────────────────────────

rmSync(dist, { recursive: true, force: true })
mkdirSync(join(dist, 'css'), { recursive: true })

// ─── 2. Vendor the design system ─────────────────────────────────────────────
// Every .css file in the package root, flat — index.css @imports its siblings
// by bare relative path, so the layout has to be preserved exactly.

const sheets = readdirSync(cssPkg).filter(f => f.endsWith('.css'))
if (!sheets.includes('index.css')) {
  console.error(`\n  ✗ No index.css in ${cssPkg} — is @frontierjs/css still there?\n`)
  process.exit(1)
}

let cssBytes = 0
for (const name of sheets) {
  const src = join(cssPkg, name)
  cssBytes += statSync(src).size
  await write(join(dist, 'css', name), file(src))
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
// Root-level .js/.css the pages load directly. The build tooling itself
// (build.js, serve.js) is excluded — it never ships.

const TOOLING = new Set(['build.js', 'serve.js'])
const shared = readdirSync(here)
  .filter(f => (f.endsWith('.js') || f.endsWith('.css')) && !TOOLING.has(f))

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
