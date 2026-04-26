import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { chalk } from 'zx'

export function find(spec) {
  const { dir, include, extensions } = spec

  return readdirSync(dir, { withFileTypes: true }).flatMap((file) => {
    const path = join(dir, file.name)
    if (file.isDirectory()) return find({ ...spec, dir: path })
    if (!include.some((regex) => regex.test(path))) return []
    if (extensions) return extensions.includes(file.name.split('.').pop()) ? path : []
    return path
  })
}

export function findFilesPlugin(config) {
  const defaults = {
    directories: [],
    extensions: undefined,
    include: [/.*/],
    ...config
  }

  return (spec) => {
    const dirs = defaults.directories.concat(spec?.directories || [])
    return dirs.flatMap((dir) => find({ ...defaults, ...spec, dir }))
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
// Does NOT override variables already set in process.env.
export function loadEnv(filePath) {
  let content
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    return // file doesn't exist — silently skip
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()

    // Skip blank lines and comments
    if (!line || line.startsWith('#')) continue

    const eqIdx = line.indexOf('=')
    if (eqIdx === -1) continue

    const key = line.slice(0, eqIdx).trim()
    if (!key || key.includes(' ')) continue

    let val = line.slice(eqIdx + 1)

    // Strip inline comments (only outside quotes)
    // e.g. KEY=value # comment → value
    const dq = val.startsWith('"')
    const sq = val.startsWith("'")

    if (dq || sq) {
      // Quoted — find closing quote, ignore everything after
      const quote = dq ? '"' : "'"
      const close = val.indexOf(quote, 1)
      val = close === -1 ? val.slice(1) : val.slice(1, close)
    } else {
      // Unquoted — strip inline comments and trim
      const commentIdx = val.indexOf(' #')
      if (commentIdx !== -1) val = val.slice(0, commentIdx)
      val = val.trim()
    }

    // Don't override vars already in the environment
    if (process.env[key] === undefined) {
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
