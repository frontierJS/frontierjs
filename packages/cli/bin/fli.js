#!/usr/bin/env node

// ─── Node version check ───────────────────────────────────────────────────────
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 20 || (major === 20 && minor < 6)) {
  console.error(`FLI requires Node.js 20.6 or later. You have ${process.version}.`)
  console.error('Download the latest Node.js at https://nodejs.org')
  process.exit(1)
}

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

// ─── FLI root — where this package lives (never changes) ─────────────────────
// bin/fli.js is at <fliRoot>/bin/fli.js
global.fliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ─── Project root — user's project (walk up from cwd, see findProjectRoot) ───
// Falls back to cwd if nothing matches (e.g. running in /tmp)
//
// `--project <dir>` (or FLI_PROJECT) pins it explicitly, so a command can be
// run against an app that isn't cwd — `fli project:view --project example`
// from a monorepo root. Stripped from the command's flags in bootstrap.js.
const { findProjectRoot, fliTmpRoot, sweepStaleTmp } = await import('../core/utils.js')

// Reap session dirs from runs that were killed before their exit handler. Cheap
// (one readdir plus a few kill probes) and lives here rather than in runtime.js
// so it also fires for commands that compile nothing — `fli list`, `fli help`.
sweepStaleTmp(fliTmpRoot(global.fliRoot))

const explicitProject = (() => {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--project')
  if (i !== -1) {
    const next = argv[i + 1]
    if (!next || next.startsWith('-')) {
      console.error(`\x1b[31m✗\x1b[0m --project needs a directory`)
      process.exit(1)
    }
    return next
  }
  const eq = argv.find(a => a.startsWith('--project='))
  if (eq) return eq.slice('--project='.length)
  return process.env.FLI_PROJECT || null
})()

if (explicitProject) {
  const abs = resolve(process.cwd(), explicitProject)
  if (!existsSync(abs)) {
    console.error(`\x1b[31m✗\x1b[0m --project directory not found: ${abs}`)
    process.exit(1)
  }
  global.projectRoot = abs
} else {
  global.projectRoot = findProjectRoot(process.cwd(), global.fliRoot)
}

// Warn if we couldn't find a real project root (cwd has no package.json above
// it). A handful of commands work without one — list, help, search, the
// fli:* namespace — but most need to resolve project paths. Suppress the
// warning for those obvious no-project commands so it doesn't fire for
// `fli list` in /tmp.
const NO_PROJECT_NEEDED = new Set(['list', 'help', '?', 'init'])
const firstArg = process.argv[2]
const projectLessNs = firstArg?.startsWith('fli:') || firstArg === '--help' || firstArg === '-h' || !firstArg
const cwdHasPkg = existsSync(resolve(process.cwd(), 'package.json'))
if (!explicitProject && global.projectRoot === process.cwd() && !cwdHasPkg
    && !NO_PROJECT_NEEDED.has(firstArg) && !projectLessNs) {
  console.error(`\x1b[33m⚠\x1b[0m no project root found above ${process.cwd()}`)
  console.error(`\x1b[2m  paths.* will resolve relative to cwd. cd into a project or run \`fli init\`\x1b[0m`)
}

// No .md loader hook is registered here. `module.register()` starts a hooks
// thread — 56ms of a ~200ms invocation, on every command — and nothing in the
// CLI ever imports a `.md`: the runtime compiles a command WITH its namespace
// module script, which a hooks thread cannot see, and imports the shim. The
// hooks stay exported from core/compiler.js for `node --import`.

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
