/*
 * terminal-tree.js — compile a `.mesa` file and everything it imports with
 * `target: 'terminal'`, into a directory of modules that run against this
 * tree's `src/`. Two callers: the terminal drive (`test/terminal/run.mjs`)
 * and `bun run tui` (`scripts/tui.mjs`).
 *
 * Traps:
 * - The two runtime specifiers are rewritten to file URLs of `src/`, and each
 *   relative `.mesa` import is compiled the same way and pointed at, so the
 *   whole tree shares one runtime instance and one signal graph. The
 *   `@frontierjs/mesa` package name would resolve to the copy under
 *   `node_modules/.bun/`, a stale snapshot of this tree.
 * - Every other relative import becomes an absolute file URL: the compiled
 *   module is written under `outDir`, where `../../utils.js` names nothing.
 * - Each output is acorn-parsed before it is written (Invariant 15).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as acorn from 'acorn'
import { compile } from '../src/compiler.js'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const RUNTIME = {
  "'@frontierjs/mesa/runtime.js'":          pathToFileURL(join(SRC, 'runtime.js')).href,
  "'@frontierjs/mesa/runtime/terminal.js'": pathToFileURL(join(SRC, 'runtime-terminal.js')).href,
}

/** Compile `entry` and its relative `.mesa` imports, children first; answer
 *  the file URL of the entry's module. `done` caches per path across calls. */
export async function compileTree(entry, outDir, done = new Map()) {
  const path = resolve(entry)
  if (done.has(path)) return done.get(path)
  const ctx = await compile(readFileSync(path, 'utf8'), { target: 'terminal', filename: basename(path) })
  let code = ctx.result
  for (const [spec, url] of Object.entries(RUNTIME)) code = code.replace(spec, JSON.stringify(url))
  for (const m of [...code.matchAll(/from '(\.\.?\/[^']+)'/g)]) {
    const abs = resolve(dirname(path), m[1])
    const to = abs.endsWith('.mesa') ? await compileTree(abs, outDir, done) : pathToFileURL(abs).href
    code = code.replace(m[0], `from ${JSON.stringify(to)}`)
  }
  acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' })
  const out = join(outDir, `${basename(path, '.mesa')}.${done.size}.${Date.now()}.mjs`)
  writeFileSync(out, code)
  const url = pathToFileURL(out).href
  done.set(path, url)
  return url
}
