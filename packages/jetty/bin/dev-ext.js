#!/usr/bin/env node
// jetty-dev-ext — Phase 5 CLI. Wraps startDev(); future `fli dev:ext` calls this.
//
// Usage:
//   jetty-dev-ext --root=. [--browser=chrome|firefox|both] [--verbose]
//                          [--launch] [--start-url=https://example.com]
//
// Flags:
//   --browser    target browser(s); default chrome
//   --verbose    pipe child-process output (Vite, web-ext) directly
//   --launch     spawn the browser(s) via web-ext after the initial build.
//                Without this flag, jetty just runs the file watcher + WS server
//                and you load the extension manually via Developer mode.
//   --start-url  URL to open in the launched browser. Useful for testing
//                content scripts on a specific page (e.g. --start-url=https://example.com).

import { resolve } from 'node:path'
import { startDev } from '../src/dev/orchestrator.js'

const args = parseArgs(process.argv.slice(2))
const root     = resolve(args.root ?? '.')
const browser  = args.browser ?? 'chrome'
const verbose  = !!args.verbose || !!args.v
const launch   = !!args.launch
const startUrl = args['start-url'] ?? null

let handle
try {
  handle = await startDev({ root, browser, verbose, launch, startUrl })
} catch (err) {
  console.error('[jetty:dev] fatal:', err.message)
  if (verbose) console.error(err.stack)
  process.exit(1)
}

console.log('')
if (launch) {
  console.log('jetty dev server running with browser(s) launched.')
  console.log('Edit src/, config/, or public/ to trigger rebuild.')
  console.log('web-ext will reload the extension automatically.')
} else {
  console.log('jetty dev server running. Edit src/, config/, or public/ and reload behavior')
  console.log('will trigger automatically. Pass --launch to auto-spawn the browser.')
}
console.log('Ctrl-C to stop.')

// Graceful shutdown
let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\n[jetty:dev] shutting down…')
  try { await handle.stop() } catch {}
  process.exit(0)
}
process.on('SIGINT',  shutdown)
process.on('SIGTERM', shutdown)

function parseArgs(argv) {
  const out = {}
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    if (m) out[m[1]] = m[2] ?? true
  }
  return out
}
