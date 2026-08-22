import { readdirSync, readFileSync, existsSync, mkdirSync, rmSync, accessSync, symlinkSync, constants } from 'fs'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { chalk } from './color.js'

// ─── Filesystem walker ────────────────────────────────────────────────────────
// Recursive .md (or arbitrary extension) discovery. Hot path on every cold
// CLI invocation — `buildRegistry()` runs this against `commands/` (often
// 100+ files across many subdirs).
//
// Optimizations vs. the prior implementation:
//   - No object spreads per directory entry (was: `{ ...spec, dir: path }`)
//   - No flatMap allocation chain (was: `dirs.flatMap(...)` recursively)
//   - No regex test for a match-all default (was: `[/.*/].some(re => re.test(path))`)
//   - `name.endsWith('.md')` instead of `name.split('.').pop() === 'md'`
//
// `include` regexes are still supported when provided, but skipped entirely
// when not — the common command-registry case.
export function find(spec) {
  const { dir, include, extensions } = spec
  const out = []
  const hasExt     = extensions !== undefined
  const hasInclude = include && include.length && !(include.length === 1 && include[0].source === '.*')

  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    // readdir order is the filesystem's, not sorted — and the command registry
    // resolves a contested alias by load order, so an unsorted walk makes the
    // winner depend on the machine. `fli new` meant project:new on one checkout
    // and make:command on another, from the same tree.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (hasExt) {
        // Fast extension check — avoid split + array allocation
        const dot = entry.name.lastIndexOf('.')
        if (dot < 0) continue
        const ext = entry.name.slice(dot + 1)
        if (!extensions.includes(ext)) continue
      }
      if (hasInclude) {
        let match = false
        for (const re of include) { if (re.test(path)) { match = true; break } }
        if (!match) continue
      }
      out.push(path)
    }
  }

  walk(dir)
  return out
}

export function findFilesPlugin(config) {
  const defaults = {
    directories: [],
    extensions: undefined,
    include: undefined,
    ...config
  }

  return (spec) => {
    const dirs = defaults.directories.concat(spec?.directories || [])
    const merged = spec ? { ...defaults, ...spec } : defaults
    const out = []
    for (const dir of dirs) {
      const found = find({ ...merged, dir })
      if (found.length) out.push(...found)
    }
    return out
  }
}

export const logger = (msg, level = 'log') => {
  switch (level) {
    case 'error':
      console.error(chalk.red('✗') + ' ' + chalk.red(msg))
      break
    case 'warn':
      console.warn(chalk.yellow('⚠') + ' ' + chalk.yellow(msg))
      break
    case 'dry':
      console.log(chalk.cyan('~') + ' ' + chalk.dim(msg))
      break
    case 'success':
      console.log(chalk.green('✓') + ' ' + chalk.green(msg))
      break
    case 'info':
      console.log(chalk.dim('·') + ' ' + msg)
      break
    case 'debug':
      console.log(chalk.dim('[debug]') + ' ' + chalk.dim(msg))
      break
    default:
      console.log(msg)
  }
}

// ─── loadEnv — native .env parser (no dotenv dependency) ─────────────────────
// Handles: KEY=value, KEY="quoted value", KEY='quoted', # comments, blank lines,
// KEY=value with inline # comment, multi-word unquoted values.
//
// Quoted values:
//   - Double quotes interpret \n \r \t \\ \" escape sequences (dotenv-compatible).
//   - Single quotes are literal — no escape interpretation.
//   - Both kinds of quotes support multi-line values: a value that opens with a
//     quote but doesn't close on the same line continues until a matching quote
//     is found on a later line.
//
// Override behavior (configurable via opts.override):
//   - opts.override = false (default): existing env vars are not changed.
//     Useful when loading global config that shouldn't override the shell's vars.
//   - opts.override = true: values from this file replace existing env vars.
//     Useful for project-local .env files that should win over global config.
export function loadEnv(filePath, opts = {}) {
  const { override = false } = opts
  let content
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    return // file doesn't exist — silently skip
  }

  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const line = rawLine.trim()

    // Skip blank lines and comments
    if (!line || line.startsWith('#')) continue

    const eqIdx = line.indexOf('=')
    if (eqIdx === -1) continue

    const key = line.slice(0, eqIdx).trim()
    if (!key || key.includes(' ')) continue

    let val = line.slice(eqIdx + 1)

    const dq = val.startsWith('"')
    const sq = val.startsWith("'")

    if (dq || sq) {
      const quote = dq ? '"' : "'"
      // Look for closing quote on the same line first
      let close = val.indexOf(quote, 1)
      if (close === -1) {
        // Multi-line quoted value — keep reading until matching quote
        const buf = [val.slice(1)]
        let found = false
        while (++i < lines.length) {
          const next = lines[i]
          const closeIdx = next.indexOf(quote)
          if (closeIdx === -1) {
            buf.push(next)
          } else {
            buf.push(next.slice(0, closeIdx))
            found = true
            break
          }
        }
        if (!found) continue // unterminated quote — skip this entry
        val = buf.join('\n')
      } else {
        val = val.slice(1, close)
      }

      // Interpret escapes inside double quotes (dotenv convention)
      if (dq) {
        val = val.replace(/\\(.)/g, (_, ch) => {
          switch (ch) {
            case 'n': return '\n'
            case 'r': return '\r'
            case 't': return '\t'
            case '\\': return '\\'
            case '"': return '"'
            default: return '\\' + ch
          }
        })
      }
    } else {
      // Unquoted — strip inline comments and trim
      const commentIdx = val.indexOf(' #')
      if (commentIdx !== -1) val = val.slice(0, commentIdx)
      val = val.trim()
    }

    if (override || process.env[key] === undefined) {
      process.env[key] = val
    }
  }
}

// ─── loadFrontierConfig ────────────────────────────────────────────────────────
// Reads frontier.config.js from the project root and returns the parsed config,
// or null if the file doesn't exist or fails to load.
//
// frontier.config.js is an ES module:
//   export default { deploy: { server: '...', ... } }
//
// Returns the default export, or null on any failure.
// Never throws — callers treat null as "no frontier config present."
export async function loadFrontierConfig(projectRoot) {
  const configPath = resolve(projectRoot, 'frontier.config.js')

  if (!existsSync(configPath)) return null

  try {
    const mod = await import(pathToFileURL(configPath))
    return mod.default ?? null
  } catch (err) {
    // Malformed or unloadable config — warn but don't crash the deploy
    console.error(chalk.yellow('⚠') + ' frontier.config.js could not be loaded: ' + err.message)
    return null
  }
}

// ─── findWorkspaceRoot ────────────────────────────────────────────────────────
// Walk up from `start` to locate the monorepo root — the directory holding
// `packages/`. Priority order:
//
//   1. package.json declaring `workspaces` AND holding a `packages/` dir.
//      Both halves are needed: `workspaces` alone matches a member package that
//      declares its own, and `packages/` alone matches any directory that
//      happens to have one.
//   2. `.git/` with a `packages/` dir — a monorepo whose root package.json
//      does not declare workspaces (or has none at all).
//
// This is NOT findProjectRoot. That resolves the app you are working ON and
// stops at the deepest `db/schema.lite`, so standing in packages/basecamp it
// answers basecamp — the wrong answer for a workspace-wide command.
//
// Returns null when nothing matches, which is the signal to fall back to
// $WORKSPACE_DIR and then to prompting.
export function findWorkspaceRoot(start) {
  let dir = resolve(start)
  while (true) {
    if (existsSync(resolve(dir, 'packages'))) {
      try {
        const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
        if (pkg.workspaces) return dir
      } catch { /* no package.json, or unreadable — try the .git marker */ }
      if (existsSync(resolve(dir, '.git'))) return dir
    }
    const parent = resolve(dir, '..')
    if (parent === dir) return null
    dir = parent
  }
}

// ─── findProjectRoot ──────────────────────────────────────────────────────────
// Walk up from `start` to locate the user's project root. Priority order:
//
//   1. `.fli.json`  — explicit project marker. Deepest match wins. Lets users
//                     override the default boundary for monorepos and other
//                     nested-package setups.
//   2. `db/schema.lite` — an FJS app root. A FrontierJS app IS its schema seed
//                     (root README §Project Structure: db/ + api/ + web/ at the
//                     root), so the deepest directory holding one is the app the
//                     user means. Without this, a nested app inside a monorepo
//                     (example/, packages/basecamp/) resolves to the repo's .git
//                     root, and every paths.* points at a directory with no
//                     schema — which is what made `fli project:view` unusable
//                     there.
//   3. `.git/`      — git repository root. Treats the whole repo as one project
//                     even when there are nested package.jsons (e.g. ksite sites
//                     with their own deps, or workspace member packages).
//   4. `package.json` — legacy fallback for projects that aren't in git.
//
// `fliRootSelf` is FLI's own checkout — we skip the `.git/` check if cwd is
// inside it, so running FLI from within its own source doesn't try to treat
// FLI as the user's project.
//
// Falls back to `start` if nothing matches.
export function findProjectRoot(start, fliRootSelf) {
  const walkUp = (dir, marker) => {
    while (true) {
      if (existsSync(resolve(dir, marker))) return dir
      const parent = resolve(dir, '..')
      if (parent === dir) return null
      dir = parent
    }
  }

  // 1. .fli.json — explicit marker, deepest wins
  const explicit = walkUp(start, '.fli.json')
  if (explicit) return explicit

  // 2. db/schema.lite — the FJS app marker, deepest wins
  const appRoot = walkUp(start, 'db/schema.lite')
  if (appRoot) return appRoot

  // 3. .git/ — git repo root, skip if running inside fli's own checkout
  const insideFliRoot = fliRootSelf && (start === fliRootSelf || start.startsWith(fliRootSelf + '/'))
  if (!insideFliRoot) {
    const gitRoot = walkUp(start, '.git')
    if (gitRoot) return gitRoot
  }

  // 4. package.json — legacy fallback
  const pkgRoot = walkUp(start, 'package.json')
  if (pkgRoot && pkgRoot !== fliRootSelf) return pkgRoot
  if (pkgRoot) return pkgRoot

  return start
}

// ─── Temp root ────────────────────────────────────────────────────────────────
// The one owner of "where does a compiled command shim go". Both the runtime
// (which writes them) and bin/fli.js (which sweeps them at startup) ask here.
//
// A shim imports `zx/globals` by bare specifier, so it has to sit somewhere
// Node's resolver can walk up from and find a node_modules holding zx —
// <fliRoot>/.fli-tmp/<pid>/ whenever fliRoot is writable.
//
// It is not writable for a global install: `npm i -g @frontierjs/cli` lands
// under a root-owned prefix, where the first temp write is EACCES and EVERY
// command dies before running. The fallback moves the session under the OS temp
// dir and symlinks node_modules back at fliRoot's, which is what keeps the bare
// specifier resolving — Node resolves from the importing file's own directory,
// and the link sits on that path. The directory is keyed by a digest of fliRoot
// so two installs never share one link pointing at the wrong tree.
const _tmpRoots = new Map()

export function fliTmpRoot(fliRoot) {
  if (_tmpRoots.has(fliRoot)) return _tmpRoots.get(fliRoot)

  const local = join(fliRoot, '.fli-tmp')
  // Attempt rather than probe permissions — a root-owned prefix, a read-only
  // mount and a container's squashed image all fail differently and only the
  // write tells the truth.
  try {
    mkdirSync(local, { recursive: true })
    accessSync(local, constants.W_OK)
    _tmpRoots.set(fliRoot, local)
    return local
  } catch {}

  const key = createHash('sha1').update(fliRoot).digest('hex').slice(0, 10)
  const fallback = join(tmpdir(), `fli-${key}`)
  mkdirSync(fallback, { recursive: true })
  try {
    // 'junction' is the Windows directory-link type that needs no privilege;
    // ignored on POSIX. EEXIST is the normal case after the first run, and a
    // dangling link is not one existsSync can see.
    symlinkSync(join(fliRoot, 'node_modules'), join(fallback, 'node_modules'), 'junction')
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
  _tmpRoots.set(fliRoot, fallback)
  return fallback
}

// Reap session dirs left by runs that died before their exit handler. Keyed by
// pid, so a live process is left alone; `test-<pid>` is the suites' own naming
// and was invisible to an int-only parse, which is why 47 of them accumulated.
export function sweepStaleTmp(tmpRoot) {
  try {
    for (const name of readdirSync(tmpRoot)) {
      const pid = Number(/^(?:test-)?(\d+)$/.exec(name)?.[1])
      if (!pid || pid === process.pid) continue
      try {
        process.kill(pid, 0)   // throws ESRCH when the process is gone
      } catch (err) {
        if (err.code === 'ESRCH') {
          try { rmSync(join(tmpRoot, name), { recursive: true, force: true }) } catch {}
        }
      }
    }
  } catch {}
}

// ─── fli's own version ────────────────────────────────────────────────────────
// Read off the installed package.json rather than written into a banner: a
// literal drifts the moment a version is published, and a stranger who ran
// `npm i -g @frontierjs/cli` reads that banner to decide whether their bug is
// already fixed.
// Keyed by root rather than a bare memo: the argument exists so a caller
// holding its own path can ask, and a single cached answer would hand it this
// package's version for someone else's directory.
const _versions = new Map()
export function fliVersion(root = global.fliRoot) {
  if (_versions.has(root)) return _versions.get(root)
  let v = null
  try {
    v = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || null
  } catch {}
  _versions.set(root, v)
  return v
}
