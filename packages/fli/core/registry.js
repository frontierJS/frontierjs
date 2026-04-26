// ─── registry.js ──────────────────────────────────────────────────────────────
// Builds the command registry by scanning two locations:
//
//   1. fliRoot/commands/          ← core FLI commands (ship with the tool)
//   2. projectRoot/cli/src/routes/ ← project commands (user's cwd-based project)
//
// Project commands take precedence — if a project defines a command with the
// same title as a core command, the project version wins.
//
// Registry shape:  Map<name|alias, { filePath, meta, source }>
//   source: 'core' | 'project'
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname, basename } from 'path'
import { findFilesPlugin } from './utils.js'
import { extractFrontmatter } from './compiler.js'
import { getConfig } from './config.js'


// ─── Module registry ─────────────────────────────────────────────────────────
// Maps namespace → parsed _module.md metadata + raw content
// Built alongside the command registry so commands can reference their module.
const _moduleRegistry = new Map()

export function getModule(namespace) {
  return _moduleRegistry.get(namespace) || null
}

export function loadModuleFile(filePath) {
  try {
    const raw  = readFileSync(filePath, 'utf8')
    const meta = extractFrontmatter(raw)
    const body = raw.replace(/^---[\s\S]*?---\s*/, '')
    // Extract prose (strip script + js blocks)
    const prose = body
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/```[\s\S]*?```/g, '')
      .trim()
    // Extract script block helpers
    const scriptMatch = body.match(/<script[^>]*>([\s\S]*?)<\/script>/)
    const script = scriptMatch ? scriptMatch[1].trim() : ''
    return { meta, prose, script, filePath }
  } catch { return null }
}

export function buildRegistry() {
  const registry = new Map()

  // Core commands — always available regardless of cwd
  const coreFinder = findFilesPlugin({
    directories: [resolve(global.fliRoot, 'commands')],
    extensions: ['md']
  })

  // Project commands — from routesDir in .fli.json (default: cli/src/routes)
  const { routesDir } = getConfig()
  const projectFinder = findFilesPlugin({
    directories: [resolve(global.projectRoot, routesDir)],
    extensions: ['md']
  })

  // Load core first, then project — project entries overwrite core on collision
  const sources = [
    { finder: coreFinder,    source: 'core'    },
    { finder: projectFinder, source: 'project' },
  ]

  for (const { finder, source } of sources) {
    let files
    try {
      files = finder()
    } catch {
      continue // directory doesn't exist — skip silently
    }

    for (const filePath of files) {
      try {
        // Skip step files — they're not standalone commands
        // Matches /_steps/, /_steps-docker/, /_steps-rollback/ etc.
        if (/_steps[^/]*[\/\\]/.test(filePath)) continue

        // _module.md — namespace module definition, not a command
        if (basename(filePath) === '_module.md') {
          const mod = loadModuleFile(filePath)
          if (mod) {
            const ns = mod.meta.namespace || basename(dirname(filePath))
            _moduleRegistry.set(ns, mod)
          }
          continue
        }

        const raw  = readFileSync(filePath, 'utf8')
        const meta = extractFrontmatter(raw)

        if (!meta.title) continue

        const entry = { filePath, meta, source }
        registry.set(meta.title, entry)
        if (meta.alias) registry.set(meta.alias, entry)

      } catch {
        // unreadable or unparseable — skip
      }
    }
  }

  return registry
}

// Unique command entries only (no alias duplicates)
export function uniqueCommands(registry) {
  const seen = new Set()
  const result = []
  for (const entry of registry.values()) {
    if (!seen.has(entry.filePath)) {
      seen.add(entry.filePath)
      result.push({ ...entry.meta, _source: entry.source })
    }
  }
  return result
}
