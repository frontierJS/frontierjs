#!/usr/bin/env node
// jetty — the one bin. `fli extension:*` and `fli dev:extension` call it, and so
// do the scripts `fli make:extension` writes; a person types `fli`.
//
// Usage:
//   jetty <build|dev|info|audit|manifest> --root=. [--browser=...] [...]
//
// Each command is a script that reads its own flags from process.argv, so the
// command name is taken off argv and the script imported in place.

const COMMANDS = {
  build:    './build-ext.js',
  dev:      './dev-ext.js',
  info:     './info.js',
  audit:    './audit.js',
  manifest: './manifest.js',
}

const name = process.argv[2]
if (!COMMANDS[name]) {
  console.error(`jetty: ${name ? `unknown command '${name}'` : 'no command given'}`)
  console.error(`  commands: ${Object.keys(COMMANDS).join(' · ')}`)
  process.exit(1)
}

process.argv.splice(2, 1)
await import(COMMANDS[name])
