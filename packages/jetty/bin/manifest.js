#!/usr/bin/env node
// jetty-manifest — print the manifest.json that would be emitted, without
// running the actual Vite build.
//
// Usage:
//   jetty-manifest --root=. [--browser=chrome|firefox|both]
//
// Useful for: CI checks ("did this PR change the manifest?"), debugging,
// pre-commit hooks.

import { resolve } from 'node:path'

import { loadConfig }    from '../src/build/config-loader.js'
import { discover }      from '../src/build/discover.js'
import { buildManifest } from '../src/build/manifest.js'

const args = parseArgs(process.argv.slice(2))
const root     = resolve(args.root ?? '.')
const browser  = args.browser ?? 'chrome'

const browsers = browser === 'both' ? ['chrome', 'firefox'] : [browser]

try {
  for (const b of browsers) {
    const config = await loadConfig({ root, browser: b })
    const found  = discover({ root })
    const manifest = buildManifest({ config, found, browser: b })

    if (browsers.length > 1) {
      console.log(`\n=== ${b} ===`)
    }
    console.log(JSON.stringify(manifest, null, 2))
  }
} catch (e) {
  console.error('✗ jetty-manifest failed:', e.message)
  process.exit(1)
}

function parseArgs(argv) {
  const out = {}
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    if (m) out[m[1]] = m[2] ?? true
  }
  return out
}
