// ─── assets.js ────────────────────────────────────────────────────────────────
//
// What a browser gets from a sibling package: the styling language every page
// here is written in (Invariant 13), and the highlighter that marks a code
// block up for it. One owner, because the generated pages (`ws:map`,
// `ws:atlas`) and the Web GUI must be styled by the same bytes.
//
// ── Why build rather than read `dist/` ────────────────────────────────────────
//
// `dist/` is gitignored and built on demand. Reading it when present and
// linking when absent would make the OUTPUT depend on whether somebody had run
// `bun run build` — and the map pages are committed snapshots the `snapshots`
// CI phase regenerates and diffs, so two machines would disagree about a file
// neither of them changed.
//
// `src/index.css` is 48 `@import … layer(name)` lines and the `@layer a, b, c;`
// declaration, which is the whole of it: each import becomes an `@layer name {
// … }` block. That is what `bun build` does for the package's own bundle, so
// the shape is the one the published file already has.
//
// The declaration is carried over VERBATIM and first. It is the line that
// declares layer ORDER, and without it order falls back to first appearance —
// which agrees with the declaration today only because index.css happens to
// import in order. `packages/css/build.js` refuses to write a bundle without it
// for the same reason: move the utilities import up and `.btn.text-lg` goes
// 16px → 14px in the bundle while the source stays 16px.

import { readFileSync } from 'fs'
import { join, dirname, parse } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const __dir   = dirname(fileURLToPath(import.meta.url))

// The published bundle, for the one caller that has no package to read at all.
// It carries NO version range on purpose: below 1.0 a caret pins the MINOR, so
// a range derived from the local version (`^0.16` from 0.16.0) excludes every
// copy the registry has. Measured the day css went 0.15 → 0.16 in the tree:
// `@^0.16` 404, no range 302.
export const CDN_STYLESHEET = 'https://unpkg.com/@frontierjs/css/dist/frontier.min.css'

// ── Whose copy ────────────────────────────────────────────────────────────────
//
// Two questions, and they are not the same one.
//
// A page ABOUT a tree is styled by THAT tree: `ws:map` and `ws:atlas` describe
// a workspace, and a stylesheet that came from somewhere else describes
// nothing (`FJS-256`). So the tree is the only place looked, and finding
// nothing is an answer — the caller links the published bundle and says so.
//
// The Web GUI is the other question. It is not about a tree at all; it is
// `fli` drawing its own interface, so the copy it wants is the one `fli` was
// installed with, wherever the installer put it.

function treeDirs(pkg, root) {
  return [
    join(root, 'packages', pkg, 'src'),
    join(root, 'node_modules', '@frontierjs', pkg, 'src'),
  ]
}

// Nearest checkout above this module first, then every install above it, then
// whatever node resolves — a hoisted root, a nested tree, a pnpm store, where
// asking node beats guessing at the layout.
//
// The two passes are not one interleaved walk, and that is the whole of it:
// `bun install` resolves a `workspace:*` dependency to a COPY under
// `node_modules/`, so a nearer install would beat the checkout it was copied
// from and style the page with whatever was true at the last install.
function ownDirs(pkg) {
  const up = []

  let dir = __dir
  const { root: fsRoot } = parse(dir)

  while (true) {
    up.push(dir)
    if (dir === fsRoot) break
    dir = dirname(dir)
  }

  const dirs = [
    ...up.map(d => join(d, 'packages', pkg, 'src')),
    ...up.map(d => join(d, 'node_modules', '@frontierjs', pkg, 'src')),
  ]

  try { dirs.push(join(dirname(require.resolve(`@frontierjs/${pkg}/package.json`)), 'src')) } catch {}
  return dirs
}

/** The styling language as the tree at `root` holds it. `null` where that tree
 *  cannot be read, which is the caller's cue to link the published bundle. */
export function styleBundle(root) {
  for (const dir of treeDirs('css', root)) {
    const index = read(join(dir, 'index.css'))
    if (index) {
      const bundled = bundleCss(index, dir)
      if (bundled) return bundled
    }
  }

  return null
}

/** The styling language as THIS `fli` holds it — what the Web GUI is drawn in. */
export function ownStyleBundle() {
  for (const dir of ownDirs('css')) {
    const index = read(join(dir, 'index.css'))
    if (index) {
      const bundled = bundleCss(index, dir)
      if (bundled) return bundled
    }
  }

  return null
}

function bundleCss(index, dir) {
  const order = index.match(/^@layer\s+[^;]+;/m)
  // No order declaration is not a bundle worth writing — see above.
  if (!order) return null

  const imports = [...index.matchAll(/@import\s+'([^']+)'(?:\s+layer\(([^)]+)\))?\s*;/g)]
  if (!imports.length) return null

  const out = [order[0]]

  for (const [, rel, layer] of imports) {
    const src = read(join(dir, rel))
    // Every import must resolve. A partial bundle is the worst outcome
    // available — the page renders, looks nearly right, and is missing
    // whichever layer went absent. Stated as "all of them" rather than as a
    // floor: a count is a guess that a small tree fails and a truncated big
    // one passes.
    if (src === null || src === undefined) return null
    const body = stripCssComments(src).trim()
    out.push(layer ? `@layer ${layer.trim()} {\n${body}\n}` : body)
  }

  return out.join('\n')
}

// Comments are 60% of this package's source — 242KB of `src/` becomes 90KB
// without them — and none of it is being read here. Quote-aware because a
// comment opener inside a string is legal CSS (`content: "/*"`), even though
// this package has none: a stripper that is right by luck is one nobody can
// safely edit.

function stripCssComments(src) {
  let out = ''
  let quote = null

  for (let i = 0; i < src.length; i++) {
    const c = src[i]

    if (quote) {
      out += c
      if (c === '\\') { out += src[++i] ?? ''; continue }
      if (c === quote) quote = null
      continue
    }

    if (c === '"' || c === "'") { quote = c; out += c; continue }

    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) break            // unterminated: the rest is comment
      i = end + 1
      continue
    }

    out += c
  }

  return out
}

// ─── the highlighter ─────────────────────────────────────────────────────────
//
// `@frontierjs/toolbelt/glow` — source → HTML marked with the ELEMENT that
// means each token, which is what lets `code[language] em { … }` in the
// stylesheet above theme it with no class contract between the two. Handed to
// the browser as the module it already is: it imports nothing, which is what
// makes that possible.

export function glowSource() {
  for (const dir of ownDirs('toolbelt')) {
    const src = read(join(dir, 'glow', 'glow.js'))
    if (src) return src
  }

  return null
}

function read(path) { try { return readFileSync(path, 'utf8') } catch { return null } }
