#!/usr/bin/env node
// jetty-audit — standalone permission audit.
//
// Usage:
//   jetty-audit --root=. [--browser=chrome]
//
// Runs against an existing build (does NOT trigger a rebuild). Exits 1 if
// the audit reports issues — useful for CI pipelines.
//
// Run after `jetty-build-ext`. To get continuous auditing during dev,
// set `permissions.audit: 'warn'` in jetty.config.js.

import { resolve, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

import { runAudit, formatAuditReport } from '../src/audit/index.js'

const args = parseArgs(process.argv.slice(2))
const root    = resolve(args.root ?? '.')
const browser = args.browser ?? 'chrome'

const distDir      = resolve(root, 'dist', browser)
const manifestPath = join(distDir, 'manifest.json')

if (!existsSync(distDir)) {
  console.error(`✗ no dist/${browser}/ directory found at ${distDir}`)
  console.error(`  Run \`jetty-build-ext --browser=${browser}\` first.`)
  process.exit(1)
}
if (!existsSync(manifestPath)) {
  console.error(`✗ no manifest.json found at ${manifestPath}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const report   = runAudit({ distDir, manifest })

console.log(formatAuditReport(report))

if (!report.ok) {
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
