/*
 * host-tree.js — compile a `.mesa` file and everything it imports for one of
 * the host targets (`src/host/targets.js`), into a directory of modules that
 * run against this tree's `src/`. Three callers: the terminal drive
 * (`test/terminal/run.mjs`), `bun run tui` (`scripts/tui.mjs`) and the
 * native drive (`test/native/run.mjs`).
 *
 * Traps:
 * - The runtime specifiers are rewritten to file URLs of `src/`, and each
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
  "'@frontierjs/mesa/runtime/native.js'":   pathToFileURL(join(SRC, 'runtime-native.js')).href,
}

/** Compile `entry` and its relative `.mesa` imports for `target`, children
 *  first; answer the file URL of the entry's module. `done` caches per path
 *  across calls, so one map serves one target. Each file's scoped rules are
 *  pushed onto `styles`, once per file: a host engine reads its stylesheet
 *  from the bundle, so the caller writes them where its build takes one. */
export async function compileTree(entry, outDir, { target, styles = [] }, done = new Map()) {
  const path = resolve(entry)
  if (done.has(path)) return done.get(path)
  const ctx = await compile(readFileSync(path, 'utf8'), { target, filename: basename(path) })
  if (ctx.css?.result) styles.push(ctx.css.result)
  let code = ctx.result
  // A component's own script may import the runtime too, the native
  // `measure` and `focus`, so every occurrence is rewritten.
  for (const [spec, url] of Object.entries(RUNTIME)) code = code.replaceAll(spec, JSON.stringify(url))
  for (const m of [...code.matchAll(/from '(\.\.?\/[^']+)'/g)]) {
    const abs = resolve(dirname(path), m[1])
    const to = abs.endsWith('.mesa') ? await compileTree(abs, outDir, { target, styles }, done) : pathToFileURL(abs).href
    code = code.replace(m[0], `from ${JSON.stringify(to)}`)
  }
  acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' })
  const out = join(outDir, `${basename(path, '.mesa')}.${done.size}.${Date.now()}.mjs`)
  writeFileSync(out, code)
  const url = pathToFileURL(out).href
  done.set(path, url)
  return url
}
