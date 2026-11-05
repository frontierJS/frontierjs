// ─── prep.mjs — rewrite every generated file `bun run ci` would otherwise fail on ─
//
//   bun run prep            snapshots + lint autofixes
//   bun run prep -- --full  also lowers typecheck baselines (slow: typechecks every package)
//
// Each step is the command CI's phase names in its own failure message, so this
// owns no logic of its own. It writes files; read `git diff` before committing,
// since a snapshot that moved is a behavior change the diff is there to show.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const full = process.argv.includes('--full')

const steps = [
  ['snapshots', 'fli', ['test:snapshots', '--fix']],
  ['lint',      join(ROOT, 'node_modules', '.bin', 'biome'), ['lint', '--write']],
  ...(full ? [['typecheck baselines', 'bun', ['run', 'typecheck', '--', '--update']]] : []),
]

let failed = 0
for (const [name, bin, argv] of steps) {
  console.log(`\n── prep · ${name} ──`)
  const run = spawnSync(bin, argv, { cwd: ROOT, stdio: 'inherit' })
  if (run.status !== 0) {
    failed++
    console.log(`prep · ${name} exited ${run.status ?? run.error?.message}`)
  }
}

console.log(failed ? `\nprep · ${failed} step(s) failed — fix those by hand, then rerun.` : '\nprep · done. Run `git diff`, then `bun run ci:fast`.')
process.exitCode = failed ? 1 : 0
