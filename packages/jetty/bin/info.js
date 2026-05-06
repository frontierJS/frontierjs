#!/usr/bin/env node
// jetty-info — print extension structure + config summary.
//
// Usage:
//   jetty-info --root=. [--browser=chrome]
//
// Useful for: CI sanity checks, "what's in this extension", debugging
// discover-vs-config mismatches.

import { resolve } from 'node:path'
import { loadConfig } from '../src/build/config-loader.js'
import { discover }   from '../src/build/discover.js'
import { decodePort, isValidExtDevPort } from '../src/dev/fjs-ports.js'

const args = parseArgs(process.argv.slice(2))
const root    = resolve(args.root ?? '.')
const browser = args.browser ?? 'chrome'

try {
  const config = await loadConfig({ root, browser })
  const found  = discover({ root })

  console.log(`Extension: ${config.name} v${config.version}`)
  if (config.description) console.log(`Description: ${config.description}`)
  console.log('')

  console.log('Discovered:')
  console.log(`  Harbor:  ${found.harbor ? '✓ ' + relPath(root, found.harbor.path) : '✗ none'}`)
  console.log(`  Dock:    ${found.dock ? '✓ ' + relPath(root, found.dock.dir) : '✗ none'}`)
  console.log(`  Options: ${found.options ? '✓ ' + relPath(root, found.options.dir) : '✗ none'}`)
  if (found.piers.length) {
    console.log(`  Piers:   ${found.piers.length}`)
    for (const p of found.piers) console.log(`    - ${p.id}: ${relPath(root, p.dir)}`)
  } else {
    console.log(`  Piers:   ✗ none`)
  }
  if (found.islands.length) {
    console.log(`  Islands: ${found.islands.length}`)
    for (const i of found.islands) {
      const cfg = config.islands?.[i.id]
      const matches = cfg?.matches?.join(', ') ?? '(no matches in config!)'
      console.log(`    - ${i.id}: ${relPath(root, i.path)}`)
      console.log(`      matches: ${matches}`)
    }
  } else {
    console.log(`  Islands: ✗ none`)
  }
  console.log('')

  console.log('Config:')
  console.log(`  Browser:        ${browser}`)
  console.log(`  Permissions:    ${(config.permissions?.declared ?? []).join(', ') || '(none)'}`)
  console.log(`  Host perms:     ${(config.hostPermissions ?? []).join(', ') || '(none — derived from islands)'}`)
  console.log(`  Audit:          ${config.permissions?.audit ?? false}`)
  if (config.junction?.url) {
    console.log(`  Junction:       ${config.junction.url}`)
  }
  if (config.dev?.port) {
    const decoded = decodePort(config.dev.port)
    const valid = isValidExtDevPort(config.dev.port) ? '✓' : '✗ OUT OF RANGE'
    console.log(`  Dev port:       ${config.dev.port} ${valid}${decoded ? ` (${decoded.envName}/${decoded.catName}/proj-${decoded.project}/svc-${decoded.service})` : ''}`)
  } else {
    console.log(`  Dev port:       ✗ not set (required by dev mode)`)
  }
  console.log('')

  if (found.warnings.length) {
    console.log('Warnings:')
    for (const w of found.warnings) console.log(`  ⚠ ${w}`)
  }
} catch (e) {
  console.error('✗ jetty-info failed:', e.message)
  process.exit(1)
}

function relPath(root, abs) {
  if (!abs) return ''
  return abs.replace(root, '').replace(/^[/\\]/, '') || '.'
}

function parseArgs(argv) {
  const out = {}
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    if (m) out[m[1]] = m[2] ?? true
  }
  return out
}
