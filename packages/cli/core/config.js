// ─── config.js ────────────────────────────────────────────────────────────────
// Loads .fli.json from projectRoot and exposes it as global.fliConfig.
//
// .fli.json shape (all fields optional):
// {
//   "routesDir":        "cli/src/routes",   // where project commands live
//   "defaultNamespace": "hello"             // default ns for make:command / fli init
// }
//
// No editor key: this file is committed, and the editor is the person's —
// fli edit / fli config read $VISUAL, then $EDITOR.
//
// Loaded once at bootstrap. Safe to read from anywhere via global.fliConfig.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const DEFAULTS = {
  routesDir:        'cli/src/routes',
  defaultNamespace: 'hello',
}

export function loadConfig() {
  global.fliConfig = readConfig(global.projectRoot)
  return global.fliConfig
}

/** `.fli.json` at `root` over the defaults, without touching the global. */
export function readConfig(root) {
  const configPath = resolve(root, '.fli.json')

  let userConfig = {}
  if (existsSync(configPath)) {
    try {
      userConfig = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch (err) {
      // Malformed .fli.json — warn but don't crash
      console.error(`[fli] Warning: could not parse .fli.json — ${err.message}`)
    }
  }
  return { ...DEFAULTS, ...userConfig }
}

// Convenience getter with safe fallback if loadConfig hasn't run yet
export function getConfig() {
  return global.fliConfig ?? DEFAULTS
}
