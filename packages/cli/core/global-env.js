// ─── global-env.js — the one file fli keeps a machine's own keys in ──────────
//
// `~/.config/fli/.env`: what `fli eset --global` writes, what `loadFliEnv`
// reads last (a project `.env` and the shell both beat it), and where a
// namespace's `requires:` key is looked for. Six places spelled the path by
// hand before this file; a seventh would have been the one to move it.
//
// `~/.fli/` is a different directory on purpose: locks, caches, holds and a
// walk's defaults live there — machine STATE, never a secret.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'

export const GLOBAL_ENV_HEADER = '# FLI global environment\n# Add env vars here that apply across all projects\n'

export const globalEnvPath = (home = homedir()) => join(home, '.config', 'fli', '.env')

/** How a person sets `key` by hand — the sentence every refusal and doctor row prints. */
export const esetHint = (key) => `fli eset ${key} <value> --global`

/** The text with `key` set to `value`: its line replaced where one exists, appended where none does. */
export function setEnvLine(content, key, value) {
  const lines   = content.split('\n')
  const quoted  = value.includes(' ') || value.includes('#') ? `"${value}"` : value
  const newLine = `${key}=${quoted}`
  let found = false
  const updated = lines.map(line => {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || !trimmed.includes('=')) return line
    if (trimmed.slice(0, trimmed.indexOf('=')).trim() === key) { found = true; return newLine }
    return line
  })
  if (!found) {
    if (updated[updated.length - 1] !== '') updated.push('')
    updated.push(newLine, '')
  }
  return updated.join('\n')
}

/** Whether the text names `key` at all — set or left empty. */
export const hasEnvLine = (content, key) =>
  content.split('\n').some(l => {
    const t = l.trim()
    return !t.startsWith('#') && t.includes('=') && t.slice(0, t.indexOf('=')).trim() === key
  })

const readOr = (file, fallback) => existsSync(file) ? readFileSync(file, 'utf8') : fallback

const writeEnv = (file, text) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

/** Set `key` in the global env, creating the file under its header when there is none. */
export function storeGlobal(key, value, { home } = {}) {
  const file = globalEnvPath(home)
  writeEnv(file, setEnvLine(readOr(file, GLOBAL_ENV_HEADER), key, value))
  return file
}

/**
 * The lines a missing key leaves behind, so the file itself says what is
 * wanted and how to supply it. `KEY=` with nothing after it loads as empty,
 * which every `requires:` check reads as missing — and `fli eset` replaces
 * that line rather than adding a second.
 */
export function placeholderFor(key, url) {
  return [
    `# ${key} — set with: ${esetHint(key)}`,
    ...(url ? [`#   make one at ${url}`] : []),
    `${key}=`,
    '',
  ].join('\n')
}

/** Append `key`'s placeholder unless the file already names the key. Answers whether it wrote. */
export function ensurePlaceholder(key, url, { home } = {}) {
  const file = globalEnvPath(home)
  const text = readOr(file, GLOBAL_ENV_HEADER)
  if (hasEnvLine(text, key)) return false
  writeEnv(file, text + (text.endsWith('\n') ? '\n' : '\n\n') + placeholderFor(key, url))
  return true
}

// ─── picking keys to send ────────────────────────────────────────────────────

const keyOf = (line) => {
  const t = line.trim()
  if (!t || t.startsWith('#')) return null
  const idx = t.indexOf('=')
  return idx === -1 ? null : t.slice(0, idx).replace(/^export\s+/, '').trim()
}

// `*` is the only wildcard, so a `.` or `$` in a name stays literal.
const keyMatcher = (key) => {
  if (!key.includes('*')) return (k) => k === key
  const re = new RegExp('^' + key.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  return (k) => re.test(k)
}

/**
 * The env text a send carries — `env:send` and `tell --env` — read from the
 * global env under `global`, else `file` under `root`; only the `keys` lines
 * when any are named, a `*` in one matching any run of characters
 * (`'*_TOKEN'`). `{ body, count, source }`, and a throw naming the file or
 * the keys and patterns that matched nothing.
 */
export function pickEnv({ root, file = '.env', global = false, keys = [], home } = {}) {
  const path   = global ? globalEnvPath(home) : resolve(root, file)
  const source = global ? '~/.config/fli/.env' : file
  if (!existsSync(path)) throw new Error(`No env file at ${path}`)
  let body = readFileSync(path, 'utf8')
  if (keys.length) {
    const matchers = keys.map(keyMatcher)
    const lines    = body.split('\n').filter(l => { const k = keyOf(l); return k && matchers.some(m => m(k)) })
    const missing  = keys.filter((_, i) => !lines.some(l => matchers[i](keyOf(l))))
    if (missing.length) throw new Error(`${source} has no ${missing.join(', ')}`)
    body = lines.join('\n') + '\n'
  }
  return { body, count: body.split('\n').filter(keyOf).length, source }
}
