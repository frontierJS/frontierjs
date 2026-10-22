/**
 * build/mesa-check.js — compile `.mesa` files without building, for a gate.
 *
 * `fli check` runs this over every surface. Without it the UI realm had no
 * grader short of `vite build`: an unclosed `{#if}` or a RULE 7 watch passed
 * rules, lint, typecheck and tests, and failed at the first deploy (`FJS-1228`).
 *
 * The source goes through `prepareForCompile`, the preparation both builds use
 * (`FJS-1491`), so a file is judged as the build would judge it. Auto-imports are not
 * applied: Mesa compiles an undefined name without complaint, so they change
 * no verdict here.
 *
 * The compile is 'strict', as the plugin's is, and a reactivity hint fails the
 * file: the dev server prints it and a read that renders once is no better for
 * having been printed (`FJS-3173`).
 *
 * A compile with no errors is not a module that loads (Invariant 15), so the
 * output is parsed too — with the acorn the resolved compiler depends on.
 * `{@const t = { w, h }}` compiled clean to a memo `vite build` stopped on,
 * and this gate passed it (`FJS-2489`).
 *
 * @module sierra/check
 */

import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import { findMesaFile, prepareForCompile } from './mesa-plugin.js'

/**
 * @param {string[]} files — absolute paths
 * @param {{ root?: string }} [opts] — where `@frontierjs/mesa` resolves from
 * @returns {Promise<{ file: string, errors: string[] }[]>} one entry per file
 *   that fails; a clean file is absent
 */
export async function checkMesaFiles(files, { root = process.cwd() } = {}) {
  const path = findMesaFile('compiler.js', root)
  if (!path) throw new Error(`[Sierra] Could not find the @frontierjs/mesa compiler from ${root}`)
  const compiler = await import(pathToFileURL(path).href)
  const acorn = createRequire(path)('acorn')

  const failed = []
  for (const file of files) {
    const content = prepareForCompile(readFileSync(file, 'utf8'), file)
    if (content === null) continue
    try {
      const ctx = await compiler.compileSource(content, { filename: file, externalReactivityHints: 'strict' })
      const errors = [...(ctx.analysis?.errors ?? []), ...(ctx.analysis?.reactivityHints ?? [])]
      if (errors.length) { failed.push({ file, errors: errors.map(String) }); continue }
      try {
        acorn.parse(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })
      } catch (err) {
        failed.push({ file, errors: [`compiled clean but the emitted JavaScript does not parse: ${err.message}`] })
      }
    } catch (err) {
      failed.push({ file, errors: [err.message] })
    }
  }
  return failed
}
