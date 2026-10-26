#!/usr/bin/env node
// ============================================================
// Workspace typecheck runner
//
//   bun run typecheck                 # fail on any error in this package
//   bun run typecheck -- --baseline N # fail only above N (a ratchet)
//   bun run typecheck -- --update     # write an improvement back
//
// Two halves, and only the second one lives here.
//
// **Which diagnostics are mine** is `packages/cli/core/typecheck.js`, because it
// is not a question about this repo: workspace packages import each other's raw
// .ts source (every exports map points at a .ts; nothing here ships .d.ts), and
// so does every application built on the framework. `bun run typecheck` in
// conduit reported 78 of Junction's errors alongside conduit's 34, and a
// scaffolded app gets several hundred and none of its own. `fli typecheck` is
// the other caller of that module — the same rule the framework publishes and
// the rule it holds itself to, once.
//
// **The baseline ratchet** is Invariant 14 and is this repo's alone. An app has
// no ceiling to hold; it is either clean or it is not.
// ============================================================

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, dirname }      from 'node:path'
import { fileURLToPath }                from 'node:url'

import { runTypecheck }                 from '../packages/cli/core/typecheck.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

// An answer from a check that did not run is worse than none, so every way of
// asking for a check this script cannot make is refused by name.
refuseUnknownFlags(args)

const quiet  = args.includes('--quiet')
const update = args.includes('--update')

const pkgDir  = process.cwd()
refuseNonPackage(pkgDir)

// The ceiling lives in scripts/typecheck-baselines.json, keyed by package
// directory name — one file so that raising a number shows up in a diff as a
// raised number, which is what Invariant 14 is about. `--baseline N` still
// overrides, for a one-off check.
const BASELINES = join(dirname(fileURLToPath(import.meta.url)), 'typecheck-baselines.json')
const pkgName   = basename(pkgDir)
const baseline  = readNumberFlag(args, '--baseline') ?? readBaseline(pkgName)

const result = runTypecheck({ dir: pkgDir })

if (result.status === 'no-tsc') {
  console.error('[typecheck] could not find tsc — run `bun install` at the workspace root')
  process.exit(2)
}
if (result.status !== 'ok') {
  console.error(`[typecheck] ${result.message}`)
  process.exit(2)
}

const ownCount = result.ownCount

if (result.own.length) console.log(result.own.join('\n'))

if (result.foreign.length && !quiet) {
  console.log(
    `\n[typecheck] suppressed diagnostics from ${result.foreign.length} file(s) outside this package ` +
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
  if (update) {
    writeBaseline(pkgName, ownCount)
    console.log(`\n[typecheck] ${ownCount} error(s) — baseline lowered from ${baseline} in scripts/typecheck-baselines.json.`)
  } else {
    console.log(
      `\n[typecheck] ${ownCount} error(s), below the baseline of ${baseline}. ` +
      `Run with --update to lock the improvement in.`
    )
  }
} else if (ownCount === 0) {
  console.log('[typecheck] clean')
}

// ─── helpers ────────────────────────────────────────────────

function refuseUnknownFlags(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--quiet' || a === '--update') continue
    if (a === '--baseline') { i++; continue }
    console.error(
      `[typecheck] unknown argument ${a} — this script takes --quiet, --update and --baseline N, ` +
      `and checks the package it is run from. To check one package: cd packages/<name> && bun run typecheck`
    )
    process.exit(2)
  }
}

// A package is a directory with a package.json that is not the workspace root.
// At the root there is nothing to check, and saying `clean` there reads as a
// verdict on every package.
function refuseNonPackage(dir) {
  let pkg = null
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch {}
  if (pkg && !pkg.workspaces) return
  const members = readdirSync(join(REPO, 'packages'), { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(REPO, 'packages', d.name, 'package.json')))
    .map(d => `packages/${d.name}`)
  console.error(
    `[typecheck] no package here (${dir}) — nothing was checked. This script checks the package it is run from; ` +
    `\`bun run typecheck\` at the root checks every member. Run it from one of: ${members.join(' ')}`
  )
  process.exit(2)
}

function loadBaselines() {
  try { return JSON.parse(readFileSync(BASELINES, 'utf8')) } catch { return {} }
}

function readBaseline(name) {
  const value = loadBaselines()[name]
  return Number.isFinite(value) ? value : 0
}

// Only ever writes a LOWER number — the ratchet is the point.
function writeBaseline(name, count) {
  const all = loadBaselines()
  if (count === 0) delete all[name]
  else all[name] = count
  writeFileSync(BASELINES, `${JSON.stringify(all, null, 2)}\n`)
}

function readNumberFlag(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1) return undefined
  const value = Number(argv[i + 1])
  return Number.isFinite(value) ? value : undefined
}
