#!/usr/bin/env node

// ─── Node version check ───────────────────────────────────────────────────────
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 20 || (major === 20 && minor < 6)) {
  console.error(`FLI requires Node.js 20.6 or later. You have ${process.version}.`)
  console.error('Download the latest Node.js at https://nodejs.org')
  process.exit(1)
}

import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

// ─── FLI root — where this package lives (never changes) ─────────────────────
// bin/fli.js is at <fliRoot>/bin/fli.js
global.fliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ─── Project root — user's project (walk up from cwd to find package.json) ───
// Falls back to cwd if no package.json is found (e.g. running in /tmp)
function findProjectRoot(start) {
  let dir = start
  while (true) {
    // Don't claim fliRoot as the project root when running inside the fli package itself
    // (during development). If cwd IS inside fliRoot, still use it — just don't walk past it.
    if (existsSync(resolve(dir, 'package.json')) && dir !== global.fliRoot) return dir
    // Special case: running from inside fli's own directory (development mode)
    if (existsSync(resolve(dir, 'package.json'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) return start
    dir = parent
  }
}

global.projectRoot = findProjectRoot(process.cwd())

// Register .md loader hook before any .md imports happen
const loaderPath = resolve(global.fliRoot, 'core/compiler.js')
register(pathToFileURL(loaderPath))

const { run } = await import('../core/bootstrap.js')
await run(process)
