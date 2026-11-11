// test/grade-theme.js — the AA suite against a theme the package does not ship (FJS-4194).
//
//   import { gradeTheme } from './grade-theme.js'
//   const { ok, status, output } = gradeTheme('/abs/path/theme.css')
//
// The function form of `bun test/run.js contrast --theme <file>`: the file holds
// one `.theme-<name> { … }` rule, and contrast.spec.js grades that class through
// every pairing it grades a shipped one. `status` is the runner's exit code — 0
// clears AA, 1 a failing pairing (named in `output`), 2 a file the runner could
// not use or no Chrome. It runs the runner rather than re-implementing it, so a
// theme graded here and a shipped one are graded by the same page.

import { spawnSync } from 'node:child_process'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUN = join(dirname(fileURLToPath(import.meta.url)), 'run.js')
const BUN = process.versions.bun ? process.execPath : 'bun'

/** @param {string} file a stylesheet holding one `.theme-<name>` rule */
export function gradeTheme(file) {
  const r = spawnSync(BUN, [RUN, 'contrast', '--theme', resolve(file)], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 16 * 1024 * 1024,
  })
  const status = r.status ?? 2
  return { ok: status === 0, status, output: `${r.stdout || ''}${r.stderr || ''}` }
}
