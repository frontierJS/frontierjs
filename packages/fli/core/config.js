// ─── config.js ────────────────────────────────────────────────────────────────
// Loads .fli.json from projectRoot and exposes it as global.fliConfig.
//
// .fli.json shape (all fields optional):
// {
//   "routesDir":        "cli/src/routes",   // where project commands live
//   "defaultNamespace": "hello",            // default ns for make:command / fli init
//   "editor":          "code"              // preferred editor for fli edit
// }
//
// Loaded once at bootstrap. Safe to read from anywhere via global.fliConfig.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const DEFAULTS = {
  routesDir:        'cli/src/routes',
  defaultNamespace: 'hello',
  editor:           '',                // falls back to $EDITOR env var
}

export function loadConfig() {
  const configPath = resolve(global.projectRoot, '.fli.json')

  let userConfig = {}
  if (existsSync(configPath)) {
    try {
      userConfig = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch (err) {
      // Malformed .fli.json — warn but don't crash
      console.error(`[fli] Warning: could not parse .fli.json — ${err.message}`)
    }
  }

  global.fliConfig = { ...DEFAULTS, ...userConfig }
  return global.fliConfig
}

// Convenience getter with safe fallback if loadConfig hasn't run yet
export function getConfig() {
  return global.fliConfig ?? DEFAULTS
}
