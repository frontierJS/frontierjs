#!/usr/bin/env bun

// ─── Runtime check ────────────────────────────────────────────────────────────
// fli runs under bun (`FJS-D593`): a command body's shell is `Bun.$`, and an
// app's API cannot run anywhere else either. A node-run fli would get as far as
// the first command and die inside it, which names nothing.
if (!process.versions.bun) {
  console.error('fli runs under Bun 1.4 or later — install it at https://bun.sh')
  process.exit(1)
}
const [major, minor] = process.versions.bun.split('.').map(Number)
if (major < 1 || (major === 1 && minor < 4)) {
  console.error(`fli requires Bun 1.4 or later. You have ${process.versions.bun}.`)
  console.error('Upgrade with: bun upgrade')
  process.exit(1)
}

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

global.fliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { findProjectRoot } = await import('../core/utils.js')
global.projectRoot = findProjectRoot(process.cwd(), global.fliRoot)

// No .md loader hook — nothing imports a .md. The runtime compiles a command
// with its namespace module script and imports the shim; see bin/fli.js.

const { startServer } = await import('../core/server.js')
startServer()
