#!/usr/bin/env bun
// tools/tui.js — a web surface's routes in this terminal (`terminal/shell.js`).
//
//   bun tui.js                         the shell: Tab moves, Enter opens, Esc comes back, Ctrl+C quits
//   bun tui.js --list                  each route and the first thing that stops it lowering
//   bun tui.js --frame /reports/       one route's frame, printed, no TTY needed
//   bun tui.js --api http://host:8110  the API origin, when it is not config.junction.url
//
// Run it from the WEB ROOT, as `sierra routes` is. Bun, never node: the loader
// is a Bun plugin and the terminal engine runs on Bun's FFI. `fli dev:tui` is
// the usual way in.

import { runTerminalShell } from '../terminal/shell.js'

const argv = process.argv.slice(2)
const getFlag = (name) => {
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const at = argv.indexOf(`--${name}`)
  return at !== -1 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : null
}

try {
  const code = await runTerminalShell({
    root:   process.cwd(),
    apiUrl: getFlag('api'),
    list:   argv.includes('--list'),
    frame:  getFlag('frame'),
  })
  process.exit(code)
} catch (e) {
  console.error(`\n  ✗  ${e.message}\n`)
  process.exit(1)
}
