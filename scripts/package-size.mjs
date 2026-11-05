#!/usr/bin/env node
// ============================================================
// Package size — what a package's own source weighs
//
//   node scripts/package-size.mjs            # table of every package, for choosing a limit
//
// The limits live in scripts/size-limits.json and the grading in scripts/ci.mjs
// (`structure`). This module only measures, so CI and a person read one number.
//
// Source means what someone wrote and has to keep reading: tests, docs, benches,
// fixtures, snapshots, lockfiles and binary assets are left out. Counting them
// put litestone at 12 MB when its source is 5, and a limit on that number would
// have been broken on the day it was set. `commands/**/*.md` stays in because a
// fli command is a markdown file whose body is JavaScript.
// ============================================================

import { execFileSync }                  from 'node:child_process'
import { statSync, readdirSync }         from 'node:fs'
import { join, dirname }                 from 'node:path'
import { fileURLToPath }                 from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

const NOT_SOURCE_DIR = /(^|\/)(test|tests|docs|bench|fixtures|mockup|node_modules)\//
const NOT_SOURCE     = /\.snapshot\.|lock(\.b|b)?$|\.(png|jpe?g|gif|webp|svg|ico|woff2?|mp4|pdf)$/
const SOURCE_MD      = /(^|\/)commands\/.*\.md$/

export function isSource(path) {
  if (NOT_SOURCE_DIR.test(path) || NOT_SOURCE.test(path)) return false
  return !path.endsWith('.md') || SOURCE_MD.test(path)
}

// Bytes of tracked source under one directory of the repo. A tracked file
// deleted in the working tree is skipped: CI runs on the tree as it stands.
export function sourceBytes(dir) {
  const files = execFileSync('git', ['ls-files', '-z', '--', dir], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\0').filter(Boolean)
  let bytes = 0
  let count = 0
  for (const file of files) {
    if (!isSource(file)) continue
    try { bytes += statSync(join(REPO, file)).size; count++ } catch {}
  }
  return { bytes, count }
}

export const kb = (bytes) => Math.round(bytes / 1024)

export function packageDirs() {
  return readdirSync(join(REPO, 'packages'), { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => `packages/${e.name}`).sort()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = packageDirs().map(dir => ({ dir, ...sourceBytes(dir) })).sort((a, b) => b.bytes - a.bytes)
  for (const r of rows) console.log(`${String(kb(r.bytes)).padStart(7)} KB  ${String(r.count).padStart(5)} files  ${r.dir}`)
}
