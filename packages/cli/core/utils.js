import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { chalk } from 'zx'

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

// ─── findProjectRoot ──────────────────────────────────────────────────────────
// Walk up from `start` until we find a package.json. Returns that directory,
// or `start` if none found. Used by all bin entry points to set
// global.projectRoot before anything else loads.
//
// fliRootSelf is passed in to avoid claiming fli's own package as the user's
// project when fli is run from inside its own checkout (development mode):
// we don't walk past fliRoot, but if cwd IS already inside fliRoot, that's
// considered intentional and we use it as the project root anyway.
export function findProjectRoot(start, fliRootSelf) {
  let dir = start
  while (true) {
    if (existsSync(resolve(dir, 'package.json')) && dir !== fliRootSelf) return dir
    if (existsSync(resolve(dir, 'package.json'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) return start
    dir = parent
  }
}
