// The seed a drive reads, run before it reads it.
//
// A drive that finds `EMP-1001`, a plan or a seeded order by name fails on an
// unseeded database with a TypeError a dozen lines from the cause — `dana.id`
// of null — and stops before its report (`FJS-4474`, `FJS-4501`). db/seed.ts
// adds only what is missing, so a seeded database pays about a second.
//
// It runs as its own process because db/seed.ts is a script, not a module.
// `SHOP` reaches it through the environment, so it seeds the shop the drive
// opened. Its output is piped rather than shown, and a failed seed throws with
// its stderr in the message, which is the line worth reading.

import { execFileSync }  from 'node:child_process'
import { fileURLToPath } from 'node:url'

const APP_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

export function seedShop() {
  execFileSync('bun', ['run', 'db/seed.ts'], { cwd: APP_ROOT, stdio: 'pipe' })
}
