#!/usr/bin/env bun
// tools/tui.js — a web surface's routes in this terminal (`terminal/shell.js`).
//
//   bun tui.js                         the shell: Tab or j/k moves, Enter opens, Esc comes back, Ctrl+C quits
//   bun tui.js --list                  each route and the first thing that stops it lowering
//   bun tui.js --frame /reports/       one route's frame, printed, no TTY needed
//   bun tui.js --api http://host:8110  the API origin, when it is not config.junction.url
//   bun tui.js --side src/Pane.mesa    a component in a pane at the right, Ctrl+\ shows it
//   bun tui.js --open /reports/        the shell, opened at that path
//
// Run it from the WEB ROOT, as `sierra routes` is. Bun, never node: the loader
// is a Bun plugin and the terminal engine runs on Bun's FFI. `fli dev:tui` is
// the usual way in.
//
// The interactive shell runs in a child of this process, so the router's
// `reload()` can end it and this one start another at the url it named, with
// every module read from disk again. The child writes that url to the file
// SIERRA_TUI_RELOAD names; a child that exits without one is the shell ending.

import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { runTerminalShell } from '../terminal/shell.js'

const argv = process.argv.slice(2)
const getFlag = (name) => {
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const at = argv.indexOf(`--${name}`)
  return at !== -1 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : null
}
const without = (name) => argv.filter((a, i) => !a.startsWith(`--${name}=`) && a !== `--${name}` && argv[i - 1] !== `--${name}`)

const interactive = !argv.includes('--list') && !getFlag('frame')
const asked = process.env.SIERRA_TUI_RELOAD

if (interactive && !asked) {
  const note = join(tmpdir(), `sierra-tui-${process.pid}.reload`)
  let args = argv
  let child = null
  // Ctrl+C reaches the child as a key in raw mode; a signal sent to the
  // group would otherwise end this process under a child still holding the TTY.
  process.on('SIGINT', () => {})
  process.on('SIGTERM', () => { child?.kill(); process.exit(143) })
  for (;;) {
    child = Bun.spawn([process.execPath, import.meta.path, ...args], {
      stdio: ['inherit', 'inherit', 'inherit'],
      env:   { ...process.env, SIERRA_TUI_RELOAD: note },
    })
    const code = await child.exited
    if (!existsSync(note)) process.exit(code)
    const url = readFileSync(note, 'utf8')
    rmSync(note)
    args = [...without('open'), '--open', url]
  }
}

try {
  const code = await runTerminalShell({
    root:   process.cwd(),
    apiUrl: getFlag('api'),
    list:   argv.includes('--list'),
    frame:  getFlag('frame'),
    side:   getFlag('side') && resolve(getFlag('side')),
    open:   getFlag('open'),
    reload: asked && ((url) => writeFileSync(asked, url)),
  })
  process.exit(code)
} catch (e) {
  console.error(`\n  ✗  ${e.message}\n`)
  process.exit(1)
}
