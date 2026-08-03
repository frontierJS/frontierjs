#!/usr/bin/env node
// ============================================================
// Workspace typecheck runner
//
//   bun run typecheck                 # fail on any error in this package
//   bun run typecheck -- --baseline N # fail only above N (a ratchet)
//
// Why this exists rather than a bare `tsc --noEmit`:
//
// Workspace packages import each other's raw .ts source (see each package's
// exports map — nothing here ships .d.ts). tsc follows those imports and
// reports diagnostics for the dependency's source too, so `bun run typecheck`
// in conduit reported 78 of Junction's errors alongside conduit's 34. That
// makes the signal useless in exactly the packages that have dependencies.
//
// `skipLibCheck` doesn't help — it only covers .d.ts. `preserveSymlinks`
// makes it worse: resolution breaks and the count goes up.
//
// So: run tsc normally, then report only the diagnostics that belong to the
// package being checked. Foreign diagnostics are counted and summarised, not
// hidden — they are someone's problem, just not this script's exit code.
// ============================================================

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args     = process.argv.slice(2)
const baseline = readNumberFlag(args, '--baseline') ?? 0
const quiet    = args.includes('--quiet')

const pkgDir  = process.cwd()
const tscPath = findTsc(pkgDir)

if (!tscPath) {
  console.error('[typecheck] could not find tsc — run `bun install` at the workspace root')
  process.exit(2)
}

const result = spawnSync(tscPath, ['--noEmit', '--pretty', 'false'], {
  cwd:      pkgDir,
  encoding: 'utf8',
  shell:    false,
})

if (result.error) {
  console.error(`[typecheck] failed to run tsc: ${result.error.message}`)
  process.exit(2)
}

const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`
  .split('\n')
  .filter(Boolean)

// tsc non-pretty diagnostics look like:
//   src/foo.ts(12,3): error TS2345: ...
// Continuation lines (indented) belong to the diagnostic above them.
const DIAGNOSTIC = /^(\S.*?)\((\d+),(\d+)\): error (TS\d+):/

const own     = []
const foreign = new Set()
let current   = null   // 'own' | 'foreign' | null

for (const line of lines) {
  const match = DIAGNOSTIC.exec(line)

  if (match) {
    const file = match[1]
    // A path that escapes the package directory, or resolves inside
    // node_modules, belongs to a dependency.
    const isForeign = file.startsWith('..') || file.includes('node_modules')
    current = isForeign ? 'foreign' : 'own'
    if (isForeign) foreign.add(file.split('(')[0])
    else own.push(line)
    continue
  }

  // Indented continuation of the previous diagnostic
  if (current === 'own' && /^\s/.test(line)) own.push(line)
}

const ownCount = own.filter(l => DIAGNOSTIC.test(l)).length

if (own.length) console.log(own.join('\n'))

if (foreign.size && !quiet) {
  console.log(
    `\n[typecheck] suppressed diagnostics from ${foreign.size} file(s) outside this package ` +
    `(workspace dependencies are checked by their own package).`
  )
}

if (ownCount > baseline) {
  console.error(
    `\n[typecheck] ${ownCount} error(s) in this package` +
    (baseline > 0 ? ` — baseline is ${baseline}. Fix the regression or lower the baseline.` : '')
  )
  process.exit(1)
}

if (baseline > 0 && ownCount < baseline) {
  console.log(
    `\n[typecheck] ${ownCount} error(s), below the baseline of ${baseline}. ` +
    `Lower the baseline in package.json to lock the improvement in.`
  )
} else if (ownCount === 0) {
  console.log('[typecheck] clean')
}

// ─── helpers ────────────────────────────────────────────────

function readNumberFlag(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1) return undefined
  const value = Number(argv[i + 1])
  return Number.isFinite(value) ? value : undefined
}

// Walk up looking for node_modules/.bin/tsc — works whether TypeScript is
// hoisted to the workspace root or installed in the package.
function findTsc(startDir) {
  let dir = resolve(startDir)
  for (;;) {
    const candidate = join(dir, 'node_modules', '.bin', 'tsc')
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) return null
    dir = parent
  }
}
