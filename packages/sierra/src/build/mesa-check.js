/**
 * build/mesa-check.js — compile `.mesa` files without building, for a gate.
 *
 * `fli check` runs this over every surface. Without it the UI realm had no
 * grader short of `vite build`: an unclosed `{#if}` or a RULE 7 watch passed
 * rules, lint, typecheck and tests, and failed at the first deploy (`FJS-1228`).
 *
 * The source goes through `prepareMesaSource`, the plugin's own preprocessing,
 * so a file is judged as the build would judge it. Auto-imports are not
 * applied: Mesa compiles an undefined name without complaint, so they change
 * no verdict here.
 *
 * @module sierra/check
 */

import { readFileSync } from 'fs'
import { pathToFileURL } from 'url'
import { findMesaFile, prepareMesaSource } from './mesa-plugin.js'

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

  const failed = []
  for (const file of files) {
    const { content } = prepareMesaSource(readFileSync(file, 'utf8'), file)
    if (content === null) continue
    try {
      const ctx = await compiler.compileSource(content, { filename: file })
      const errors = ctx.analysis?.errors ?? []
      if (errors.length) failed.push({ file, errors: errors.map(String) })
    } catch (err) {
      failed.push({ file, errors: [err.message] })
    }
  }
  return failed
}
