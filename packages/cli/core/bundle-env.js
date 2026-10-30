// ─── bundle-env.js — the env keys a laptop-built static bundle bakes ─────────
//
// `basecamp:deploy` builds `web/` with the checkout's own `.env` (`FJS-D1482`),
// while a preview's Freeze bakes the App's Variables. One App released by both
// can carry different values and the Variables page states only Freeze's, so
// the deploy names the keys it baked and where they came from. Names only: a
// value in a build log is a value in a CI log.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { parseEnvText } from './local-env.js'

// Sierra's `ENV_PREFIX`: what a bundle may read from the environment.
const PREFIXES = ['VITE_', 'FRONTIER_PUBLIC_']

// Vite's load order, lowest first — a later file wins.
const FILES = ['.env', '.env.local', '.env.production', '.env.production.local']

/**
 * The keys `vite build` in `webDir` exposes to the bundle, each with the file
 * that supplies it (`process` for the shell's own, which Vite reads over the
 * files). Sorted by key.
 *
 * @param {string} webDir
 * @param {Record<string, string | undefined>} [shell]
 * @returns {{ key: string, from: string }[]}
 */
export function bundleEnvKeys(webDir, shell = process.env) {
  const from = new Map()
  const exposed = (key) => PREFIXES.some(p => key.startsWith(p))
  for (const file of FILES) {
    const path = join(webDir, file)
    if (!existsSync(path)) continue
    for (const key of Object.keys(parseEnvText(readFileSync(path, 'utf8'))))
      if (exposed(key)) from.set(key, file)
  }
  for (const key of Object.keys(shell)) if (exposed(key)) from.set(key, 'process')
  return [...from].map(([key, source]) => ({ key, from: source })).sort((a, b) => a.key.localeCompare(b.key))
}

/** The line the deploy prints before it builds. */
export function bundleEnvLine(keys) {
  if (!keys.length) return "Bundle env: none baked — no VITE_ or FRONTIER_PUBLIC_ key in web/'s .env files or the shell (the App's Variables in Basecamp are not read)"
  return `Bundle env baked from the checkout, not the App's Variables: ${keys.map(k => `${k.key} (${k.from})`).join(', ')}`
}
