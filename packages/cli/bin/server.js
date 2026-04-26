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

global.fliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function findProjectRoot(start) {
  let dir = start
  while (true) {
    if (existsSync(resolve(dir, 'package.json')) && dir !== global.fliRoot) return dir
    if (existsSync(resolve(dir, 'package.json'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) return start
    dir = parent
  }
}

global.projectRoot = findProjectRoot(process.cwd())

const loaderPath = resolve(global.fliRoot, 'core/compiler.js')
register(pathToFileURL(loaderPath))

const { startServer } = await import('../core/server.js')
startServer()
