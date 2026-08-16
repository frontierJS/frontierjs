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

import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { resolve, dirname, basename, join } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'
import { findFilesPlugin } from './utils.js'
import { extractFrontmatter } from './compiler.js'
import { getConfig } from './config.js'


// ─── Frontmatter cache ───────────────────────────────────────────────────────
// Every invocation builds the registry, and building it used to mean reading
// and frontmatter-parsing all ~200 command files — including on each press of
// Tab, since completion asks the registry the same question.
//
// The cache holds one parsed frontmatter block per file, keyed by mtime+size,
// so a run stats the files it finds and parses only what moved. Discovery still
// walks the directories: a cached list would not notice a new command file, and
// "drop a file, it runs" is the whole authoring model.
//
// It lives under ~/.fli/ rather than beside the install, for the same reason
// the temp root does — a global install is not writable. A cache that cannot be
// read or written is never an error: every path here falls back to parsing.
const CACHE_VERSION = 1

function cacheFile(routesDir) {
  const key = createHash('sha1')
    .update([global.fliRoot, global.projectRoot, routesDir].join('\0'))
    .digest('hex')
    .slice(0, 10)
  return join(homedir(), '.fli', 'cache', `registry-${key}.json`)
}

function readCache(path) {
  // The escape hatch for "I think the cache is lying to me". Cheap to offer and
  // the alternative is deleting a file whose location you have to look up.
  if (process.env.FLI_NO_CACHE) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed?.v === CACHE_VERSION && parsed.files) return parsed.files
  } catch {}
  return {}
}

function writeCache(path, files) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    // Write-then-rename: two fli processes can finish a build at once, and a
    // half-written cache read by a third would be a parse error every run
    // after. The rename is atomic; the loser's copy is simply overwritten.
    const tmp = `${path}.${process.pid}`
    writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, files }))
    renameSync(tmp, path)
  } catch {}
}


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
  const { routesDir } = getConfig()
  const cachePath = cacheFile(routesDir)
  const cached = readCache(cachePath)
  // Rebuilt from scratch each run, so a deleted command's entry leaves with it
  // rather than accumulating forever.
  const fresh = {}
  let cacheChanged = false

  // The parse a cache hit avoids: a full read plus the frontmatter scan.
  const metaFor = (filePath) => {
    let sig = null
    try {
      const st = statSync(filePath)
      sig = `${st.mtimeMs}:${st.size}`
      const hit = cached[filePath]
      if (hit && hit.sig === sig) {
        fresh[filePath] = hit
        return hit.meta
      }
    } catch {}
    const meta = extractFrontmatter(readFileSync(filePath, 'utf8'))
    if (sig) {
      fresh[filePath] = { sig, meta }
      cacheChanged = true
    }
    return meta
  }

  // Core commands — always available regardless of cwd
  const coreFinder = findFilesPlugin({
    directories: [resolve(global.fliRoot, 'commands')],
    extensions: ['md']
  })

  // Project commands — from routesDir in .fli.json (default: cli/src/routes)
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
        // Skip step files — they're not standalone commands.
        // Anchored on a path separator to avoid false positives like
        // commands/foo_steps_archive/bar.md, while matching _steps,
        // _steps-docker, _steps-rollback, etc.
        if (/[\/\\]_steps[^\/\\]*[\/\\]/.test(filePath)) continue

        // _module.md — namespace module definition, not a command
        if (basename(filePath) === '_module.md') {
          const mod = loadModuleFile(filePath)
          if (mod) {
            const ns = mod.meta.namespace || basename(dirname(filePath))
            _moduleRegistry.set(ns, mod)
          }
          continue
        }

        const meta = metaFor(filePath)

        if (!meta.title) continue

        const entry = { filePath, meta, source }

        // Title collision — log warn, last loader (project) wins on purpose
        const existing = registry.get(meta.title)
        if (existing && existing.filePath !== filePath) {
          // Same source means duplicate definition — bug in the user's repo
          if (existing.source === source) {
            console.error(`\x1b[33m⚠\x1b[0m duplicate command title "${meta.title}":`)
            console.error(`    ${existing.filePath}`)
            console.error(`    ${filePath}  (overrides previous)`)
          }
          // Project overriding core is intentional — silent
        }
        registry.set(meta.title, entry)

        // Alias collision — warn but proceed. Aliases lose to titles below.
        if (meta.alias) {
          const aliasExisting = registry.get(meta.alias)
          if (aliasExisting && aliasExisting.filePath !== filePath
              && aliasExisting.meta?.title === meta.alias) {
            // The alias collides with another command's TITLE — keep title, skip alias
            console.error(`\x1b[33m⚠\x1b[0m alias "${meta.alias}" on ${meta.title} collides with command title "${aliasExisting.meta.title}" — alias ignored`)
          } else if (aliasExisting && aliasExisting.filePath !== filePath
                     && aliasExisting.meta?.alias === meta.alias
                     && aliasExisting.source === source) {
            // TWO COMMANDS CLAIMING ONE ALIAS. The winner is whichever loads
            // LAST, which is discovery order — and `find()` sorts for that
            // reason, because readdir order made `fli new` mean `project:new`
            // on one checkout and `make:command` on another, from one tree.
            //
            // Sorted is reproducible, not meaningful: nothing about `utils`
            // sorting after `ports` says which command should own `dev`. So
            // the warning stands, and a contested alias is a thing to resolve
            // by renaming one side rather than to leave to the alphabet.
            //
            // Only within one source: a project overriding a core command is
            // intentional, which is the rule the title branch above follows.
            console.error(`\x1b[33m⚠\x1b[0m alias "${meta.alias}" claimed by both ${aliasExisting.meta.title} and ${meta.title} — "${meta.alias}" runs ${meta.title}; use "${aliasExisting.meta.title}" for the other`)
            registry.set(meta.alias, entry)
          } else {
            registry.set(meta.alias, entry)
          }
        }

      } catch {
        // unreadable or unparseable — skip
      }
    }
  }

  // Second pass: titles always win over aliases. If a title appears in the
  // registry but was set by an alias from another command, restore the title-owner.
  for (const entry of [...registry.values()]) {
    if (registry.get(entry.meta.title) !== entry && entry.meta.title) {
      // The title key is pointing somewhere else — that's a bug we already warned about
    }
  }

  // A file that vanished also changes the cache, not just a file that moved.
  if (cacheChanged || Object.keys(fresh).length !== Object.keys(cached).length) {
    writeCache(cachePath, fresh)
  }

  return registry
}

// Drop the cache — the one thing `completion:refresh` needs to do, and the
// caller should not have to know where it lives. Answers how many files the
// dropped cache held, since "cleared" with no number reads as a no-op.
export function clearRegistryCache() {
  const { routesDir } = getConfig()
  const path = cacheFile(routesDir)
  const held = Object.keys(readCache(path)).length
  try { unlinkSync(path) } catch {}
  return { path, held }
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
