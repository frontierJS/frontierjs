/**
 * scripts/stage-repl.mjs — the Mesa REPL, published at /packages/mesa/repl/.
 *
 *   node scripts/stage-repl.mjs        (bun run build runs it first)
 *
 * The REPL is `packages/mesa/example/` and has no build: it imports the compiler
 * and runtime it documents by relative path, and reaches two siblings the same
 * way — `../../css/dist/frontier.css` and `../../ui/components/…`, which the UI
 * Library example fetches as source and compiles in the page. At
 * /packages/mesa/repl/ those paths land on /packages/mesa/src/, /packages/css/
 * and /packages/ui/, which is the repository's own layout. So this copies the
 * files it reaches to the same relative places under content/public/ and
 * rewrites nothing; a path that has to be rewritten here is a page that works
 * on the site and not in the repo, or the other way round.
 *
 * Copied over a clean directory each run, so a file deleted upstream does not
 * keep shipping. The output is gitignored.
 */

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE     = dirname(fileURLToPath(import.meta.url))
const REPO     = resolve(HERE, '..', '..')
const PACKAGES = join(REPO, 'packages')
const OUT      = resolve(HERE, '..', 'site', 'content', 'public', 'packages')

// A UI component imports its package's root modules (`../../utils.js`), so the
// whole of packages/ui ships but for what no page loads.
const UI_SKIP = new Set(['node_modules', 'test', 'docs'])
const isDir   = (f) => statSync(f).isDirectory()
const jsOnly  = (f) => isDir(f) || f.endsWith('.js')
const uiPage  = (f) => isDir(f) ? !UI_SKIP.has(basename(f)) : /\.(js|mesa)$/.test(f)

// [source under packages/, published path under /packages/, keep(file)]
const COPIES = [
  ['mesa/example/index.html',  'mesa/repl/index.html'],
  ['mesa/example/examples.js', 'mesa/repl/examples.js'],
  ['mesa/example/vendor',      'mesa/repl/vendor'],
  ['mesa/src',                 'mesa/src', jsOnly],
  // The importmap names these under the package's own node_modules, which is
  // where a workspace install links @frontierjs/toolbelt.
  ['toolbelt/src/share/share.js', 'mesa/node_modules/@frontierjs/toolbelt/src/share/share.js'],
  ['toolbelt/src/tty/tty.js',     'mesa/node_modules/@frontierjs/toolbelt/src/tty/tty.js'],
  ['css/dist/frontier.css',    'css/dist/frontier.css'],
  ['ui',                       'ui', uiPage],
]

stageRepl()

function stageRepl() {
  const missing = COPIES.filter(([from]) => !existsSync(join(PACKAGES, from)))
  if (missing.length) refuse(missing.map(([from]) => from))

  rmSync(OUT, { recursive: true, force: true })
  for (const [from, to, keep] of COPIES) {
    const dest = join(OUT, to)
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(join(PACKAGES, from), dest, { recursive: true, filter: keep })
  }
  console.log(`stage-repl: /packages/mesa/repl/ → ${relative(process.cwd(), OUT)}`)
}

// css/dist is a build output; a clone that never built @frontierjs/css would
// ship a REPL whose UI examples render unstyled, which looks like a working page.
function refuse(paths) {
  console.error('stage-repl: the REPL reaches files that are not there:')
  for (const p of paths) console.error(`  packages/${p}`)
  if (paths.some((p) => p.startsWith('css/dist')))
    console.error('Build the stylesheet first: cd packages/css && bun run build')
  process.exit(1)
}
