// ─── typecheck ────────────────────────────────────────────────────────────────
//
// Run `tsc --noEmit` and report only the diagnostics that belong to the code
// being checked.
//
// ─── why this is not just `tsc --noEmit` ─────────────────────
//
// Every @frontierjs package ships TypeScript SOURCE — each `exports` map points
// at a `.ts`, and nothing here emits `.d.ts`. That is deliberate: a consumer
// reads the real implementation and Bun runs it directly. The cost lands on
// whoever runs tsc, because tsc follows those imports and type-checks the
// framework's own sources as part of the consumer's program. A freshly
// scaffolded app that imports `@frontierjs/junction` gets several hundred
// diagnostics from inside node_modules and none of its own.
//
// `skipLibCheck` does not help — it covers `.d.ts` only, and these are not
// declaration files. `preserveSymlinks` makes it worse: resolution breaks and
// the count goes up. There is no tsc option for *check my files, not the ones
// they import*, so the filtering happens here, on the output.
//
// Foreign diagnostics are COUNTED AND SUMMARIZED, never silently dropped. They
// are someone's problem — just not this exit code's. `--foreign` prints them.
//
// ─── two callers ─────────────────────────────────────────────
//
// `fli test:types` runs it over a client app. `scripts/typecheck.mjs` imports it
// by relative path and runs it over one workspace package, adding the baseline
// ratchet of Invariant 14 on top. Same reason `core/checks.js` and
// `core/snapshots.js` have two callers: a rule the framework publishes and a
// rule the framework holds itself to must be one implementation.
//
// Zero dependencies, plain ESM, node or bun — `scripts/typecheck.mjs` runs on
// plain node.

import { spawnSync }  from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// tsc non-pretty diagnostics look like:
//   src/foo.ts(12,3): error TS2345: ...
// Continuation lines are indented and belong to the diagnostic above them.
const DIAGNOSTIC = /^(\S.*?)\((\d+),(\d+)\): error (TS\d+):/

// Walk up looking for node_modules/.bin/tsc — works whether TypeScript is
// hoisted to a workspace root or installed in the package itself.
export function findTsc(startDir) {
  let dir = resolve(startDir)
  for (;;) {
    const candidate = join(dir, 'node_modules', '.bin', 'tsc')
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) return null
    dir = parent
  }
}

// A path that escapes the directory being checked, or resolves inside
// node_modules, belongs to someone else.
const isForeign = (file) => file.startsWith('..') || file.includes('node_modules')

/**
 * @returns {{ status: 'ok'|'no-tsc'|'spawn-failed', own: string[], ownCount: number,
 *             foreign: string[], foreignCount: number, message?: string }}
 */
export function runTypecheck({ dir = process.cwd(), tscArgs = [] } = {}) {
  const tscPath = findTsc(dir)
  if (!tscPath) {
    return empty('no-tsc', 'could not find tsc — is `typescript` installed?')
  }

  const result = spawnSync(tscPath, ['--noEmit', '--pretty', 'false', ...tscArgs], {
    cwd:      dir,
    encoding: 'utf8',
    shell:    false,
    maxBuffer: 64 * 1024 * 1024,
  })

  if (result.error) {
    return empty('spawn-failed', `failed to run tsc: ${result.error.message}`)
  }

  const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n').filter(Boolean)

  const own          = []
  const foreignLines = []
  const foreignFiles = new Set()
  let   current      = null   // 'own' | 'foreign' | null

  for (const line of lines) {
    const match = DIAGNOSTIC.exec(line)

    if (match) {
      const file = match[1]
      current = isForeign(file) ? 'foreign' : 'own'
      if (current === 'foreign') { foreignFiles.add(file); foreignLines.push(line) }
      else                       { own.push(line) }
      continue
    }

    if (!/^\s/.test(line)) continue
    if (current === 'own')     own.push(line)
    if (current === 'foreign') foreignLines.push(line)
  }

  return {
    status:       'ok',
    own,
    ownCount:     own.filter(l => DIAGNOSTIC.test(l)).length,
    foreign:      [...foreignFiles].sort(),
    foreignLines,
    foreignCount: foreignLines.filter(l => DIAGNOSTIC.test(l)).length,
  }

  function empty(status, message) {
    return { status, message, own: [], ownCount: 0, foreign: [], foreignLines: [], foreignCount: 0 }
  }
}

// Rendered by the caller so the command and the workspace runner can differ in
// how they talk about a baseline without differing about what was found.
export function formatTypecheck(result, { quiet = false, showForeign = false } = {}) {
  const out = []

  if (result.own.length) out.push(result.own.join('\n'))

  if (showForeign && result.foreignLines.length) {
    out.push(result.foreignLines.join('\n'))
  }

  if (result.foreignCount && !quiet) {
    out.push(
      `${result.foreignCount} diagnostic(s) across ${result.foreign.length} file(s) outside this project ` +
      `were not counted — every @frontierjs package ships TypeScript source, so tsc checks the framework ` +
      `alongside your code. Pass --foreign to see them.`
    )
  }

  return out.join('\n\n')
}
