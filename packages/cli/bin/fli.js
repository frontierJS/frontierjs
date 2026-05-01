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
import { existsSync, readdirSync, rmSync } from 'node:fs'

// ─── FLI root — where this package lives (never changes) ─────────────────────
// bin/fli.js is at <fliRoot>/bin/fli.js
global.fliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ─── Sweep stale temp dirs from previous runs that crashed before cleanup ───
// Cheap (one readdir + a few process.kill probes), runs once per fli startup.
// Without this, `.fli-tmp/<dead-pid>/` directories from killed runs would
// accumulate. Lives here (rather than runtime.js) so it fires even for
// commands that don't compile anything, like `fli list` and `fli help`.
;(() => {
  const tmpRoot = resolve(global.fliRoot, '.fli-tmp')
  if (!existsSync(tmpRoot)) return
  try {
    for (const name of readdirSync(tmpRoot)) {
      const pid = parseInt(name)
      if (!pid || pid === process.pid) continue
      try {
        process.kill(pid, 0)
        // still alive — leave it
      } catch (err) {
        if (err.code === 'ESRCH') {
          try { rmSync(resolve(tmpRoot, name), { recursive: true, force: true }) } catch {}
        }
      }
    }
  } catch {}
})()

// ─── Project root — user's project (walk up from cwd to find package.json) ───
// Falls back to cwd if no package.json is found (e.g. running in /tmp)
const { findProjectRoot } = await import('../core/utils.js')
global.projectRoot = findProjectRoot(process.cwd(), global.fliRoot)

// Warn if we couldn't find a real project root (cwd has no package.json above
// it). A handful of commands work without one — list, help, search, the
// fli:* namespace — but most need to resolve project paths. Suppress the
// warning for those obvious no-project commands so it doesn't fire for
// `fli list` in /tmp.
const NO_PROJECT_NEEDED = new Set(['list', 'help', '?', 'init'])
const firstArg = process.argv[2]
const projectLessNs = firstArg?.startsWith('fli:') || firstArg === '--help' || firstArg === '-h' || !firstArg
const cwdHasPkg = existsSync(resolve(process.cwd(), 'package.json'))
if (global.projectRoot === process.cwd() && !cwdHasPkg
    && !NO_PROJECT_NEEDED.has(firstArg) && !projectLessNs) {
  console.error(`\x1b[33m⚠\x1b[0m no project root found above ${process.cwd()}`)
  console.error(`\x1b[2m  paths.* will resolve relative to cwd. cd into a project or run \`fli init\`\x1b[0m`)
}

// Register .md loader hook before any .md imports happen
const loaderPath = resolve(global.fliRoot, 'core/compiler.js')
register(pathToFileURL(loaderPath))

const { run } = await import('../core/bootstrap.js')

try {
  await run(process)
} catch (err) {
  // Signal-based exits should already be handled inside exec/stream, but if
  // anything slips through, treat them as quiet exits.
  if (err?.signal === 'SIGINT')  process.exit(130)
  if (err?.signal === 'SIGTERM') process.exit(143)

  // Print a clean error message. Full stack only when --debug is passed,
  // since most users don't need to see node's internals.
  const debug = process.argv.includes('--debug') || process.env.FLI_DEBUG
  if (debug) {
    console.error(err)
  } else {
    console.error(`\n\x1b[31m✗\x1b[0m ${err?.message || err}`)
    console.error(`\x1b[2m  pass --debug or set FLI_DEBUG=1 to see the full stack trace\x1b[0m\n`)
  }
  process.exit(1)
}
