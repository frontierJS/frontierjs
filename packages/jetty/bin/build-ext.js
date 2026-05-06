#!/usr/bin/env node
// jetty-build-ext — production build CLI.
//
// Usage:
//   jetty-build-ext --root=. --browser=chrome  [--verbose]
//   jetty-build-ext --root=. --browser=firefox [--verbose]
//   jetty-build-ext --root=. --browser=both    [--verbose]

import { resolve } from 'node:path'
import { buildExtension, buildBoth } from '../src/build/index.js'

const args = parseArgs(process.argv.slice(2))
const root    = resolve(args.root ?? '.')
const browser = args.browser ?? 'chrome'
const verbose = !!args.verbose || !!args.v

try {
  if (browser === 'both') {
    const { chrome, firefox } = await buildBoth({ root, verbose })
    console.log('')
    console.log(`✓ built ${chrome.manifest.name} v${chrome.manifest.version} (both browsers)`)
    console.log(`  chrome  → ${chrome.distDir}`)
    console.log(`  firefox → ${firefox.distDir}`)
    console.log(`  harbor: ${chrome.found.harbor ? '1' : '0'}, dock: ${chrome.found.dock ? '1' : '0'}, options: ${chrome.found.options ? '1' : '0'}, piers: ${chrome.found.piers.length}, islands: ${chrome.found.islands.length}`)
  } else {
    const { distDir, manifest, found } = await buildExtension({ root, browser, verbose })
    console.log('')
    console.log(`✓ built ${manifest.name} v${manifest.version} (${browser})`)
    console.log(`  → ${distDir}`)
    console.log(`  harbor: ${found.harbor ? '1' : '0'}, dock: ${found.dock ? '1' : '0'}, options: ${found.options ? '1' : '0'}, piers: ${found.piers.length}, islands: ${found.islands.length}`)
  }
} catch (err) {
  console.error('✗ build failed:', err.message)
  if (verbose) console.error(err.stack)
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
