/*
 * VISION §4's claims, graded against the compiler (FJS-1876).
 *
 * `spec-check.mjs` is a script that prints a ✓/✗ line per claim and exits 1 on a
 * miss. It used to be reachable only through a `&&` in the package `test`
 * script, so dropping that link (or running `vitest run` alone) left the spec
 * ungraded and nothing failed. A vitest file runs it wherever the suite runs.
 */
import { it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..')

it('every claim VISION §4 makes is backed by the compiler', () => {
  const r = spawnSync(process.execPath, ['test/spec-check.mjs'], { cwd: ROOT, encoding: 'utf8' })
  const failed = r.stdout.split('\n').filter((l) => l.includes('✗'))
  expect(failed).toEqual([])
  expect(r.status).toBe(0)
  expect(r.stdout).toContain('every documented claim verified')
})
