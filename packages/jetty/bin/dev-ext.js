#!/usr/bin/env node
// jetty dev — wraps startDev(); `fli dev:extension` calls it through bin/jetty.js.
//
// Usage:
//   jetty dev --root=. [--browser=chrome|firefox|both] [--verbose]
//                          [--launch] [--start-url=https://example.com]
//                          [--profile=DIR | --temp-profile]
//
// Flags:
//   --browser       target browser(s); default chrome
//   --verbose       pipe child-process output (Vite, web-ext) directly
//   --launch        spawn the browser(s) via web-ext after the initial build.
//                   Without it, press `o` to spawn them later, or load
//                   dist/<browser>/ by hand via Developer mode.
//   --start-url     URL to open in the launched browser. Useful for testing
//                   content scripts on a specific page (e.g. --start-url=https://example.com).
//   --profile       where the launched browsers keep their profiles; default
//                   <root>/.browser-profiles/<browser>, so a sign-in and the
//                   extension's storage survive a restart
//   --temp-profile  a fresh profile per launch instead (web-ext's default)
//
// Keys, when stdin is a terminal: o — open the browser(s) · q / Ctrl-C — quit.

import { resolve } from 'node:path'
import { startDev } from '../src/dev/orchestrator.js'

const args = parseArgs(process.argv.slice(2))
const root     = resolve(args.root ?? '.')
const browser  = args.browser ?? 'chrome'
const verbose  = !!args.verbose || !!args.v
const launch   = !!args.launch
const startUrl = args['start-url'] ?? null
const profile  = args['temp-profile'] ? false : (typeof args.profile === 'string' ? args.profile : true)

let handle
try {
  handle = await startDev({ root, browser, verbose, launch, startUrl, profile })
} catch (err) {
  console.error('[jetty:dev] fatal:', err.message)
  if (verbose) console.error(err.stack)
  process.exit(1)
}

const keys = process.stdin.isTTY
console.log('')
if (launch) {
  console.log('jetty dev server running with browser(s) launched.')
  console.log('Edit src/, config/, or public/ to trigger rebuild.')
  console.log('web-ext will reload the extension automatically.')
} else {
  console.log('jetty dev server running. Edit src/, config/, or public/ and reload behavior')
  console.log(`will trigger automatically. ${keys ? 'Press o to open' : 'Pass --launch to spawn'} the browser with the extension loaded.`)
}
console.log(keys ? 'o open browser · q quit' : 'Ctrl-C to stop.')

// Raw mode turns Ctrl-C into a byte instead of a SIGINT, so it is handled here.
if (keys) {
  process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (key) => {
    if (key === 'o') handle.openBrowsers().catch((e) => console.error('[jetty:dev] launch failed:', e.message))
    else if (key === 'q' || key === '\u0003') shutdown()
  })
}

// Graceful shutdown
let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  if (keys) process.stdin.setRawMode(false)
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
