// src/domain/claude/claude-settings.ts — what a Claude Code `settings.json` says, and how the layers combine.
//
// Three files can carry settings for one project — the user's
// `~/.claude/settings.json`, the project's `.claude/settings.json`, and the
// project's uncommitted `.claude/settings.local.json`. Each parses alone here;
// `mergeSettings` is the answer to "what is in force".
//
// **No value that can be a secret leaves this file.** `env` is a map of
// variables the file exports into every session, and a token is the usual
// thing in one, so only its NAMES are returned. `apiKeyHelper` is a command
// that prints a key; the screen learns that one is set, never what it runs.
//
// **A key this file does not type is still reported** — `keys` lists every
// top-level key, so a screen can say "3 settings not shown" instead of
// pretending the file was smaller. `hooks` is passed through untouched: the
// hooks reader owns its shape, and a second parser here would drift from it.
//
// A field of the wrong type is dropped to `null` and named in `issues`; the
// rest of the file still reads. Only text that is not a JSON object fails whole.

import { read, readJsonObject, type Read } from './claude-read.ts'

export type PermissionMode = string

export type Permissions = {
  allow:                 string[]
  ask:                   string[]
  deny:                  string[]
  defaultMode:           PermissionMode | null
  additionalDirectories: string[]
}

export type Settings = {
  model:                  string | null
  theme:                  string | null
  language:               string | null
  outputStyle:            string | null
  alwaysThinkingEnabled:  boolean | null
  effortLevel:            string | null
  voiceEnabled:           boolean | null
  /** The `voice` key as written; Claude Code has shipped it as a flag and as an object. */
  voice:                  unknown
  cleanupPeriodDays:      number | null
  enabledPlugins:         Record<string, boolean>
  permissions:            Permissions
  /** A key helper is configured. The command itself can embed a secret and is never returned. */
  apiKeyHelper:           boolean
  /** Names of the variables `env` exports — never their values. */
  envKeys:                string[]
  /** As written; `null` when absent. Parsed by the hooks reader. */
  hooks:                  unknown
  /** Every top-level key present, typed here or not. */
  keys:                   string[]
  /** Entries that were present but the wrong type, each naming the key. */
  issues:                 string[]
}

export const emptySettings = (): Settings => ({
  model: null, theme: null, language: null, outputStyle: null,
  alwaysThinkingEnabled: null, effortLevel: null, voiceEnabled: null, voice: null,
  cleanupPeriodDays: null,
  enabledPlugins: {},
  permissions: { allow: [], ask: [], deny: [], defaultMode: null, additionalDirectories: [] },
  apiKeyHelper: false,
  envKeys: [],
  hooks: null,
  keys: [],
  issues: [],
})

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

export function parseSettings(text: string): Read<Settings> {
  const parsed = readJsonObject(text)
  if (!parsed.ok) return parsed
  const raw = parsed.value
  const s = emptySettings()
  const issues = s.issues
  s.keys = Object.keys(raw)

  const str = (key: string): string | null => {
    if (!(key in raw) || raw[key] === null) return null
    if (typeof raw[key] === 'string') return raw[key] as string
    issues.push(`${key}: expected a string`)
    return null
  }
  const bool = (key: string): boolean | null => {
    if (!(key in raw) || raw[key] === null) return null
    if (typeof raw[key] === 'boolean') return raw[key] as boolean
    issues.push(`${key}: expected true or false`)
    return null
  }
  const strings = (key: string, from: Record<string, unknown>): string[] => {
    const v = from[key]
    if (v === undefined || v === null) return []
    if (!Array.isArray(v)) { issues.push(`${key}: expected a list`); return [] }
    const good = v.filter((x): x is string => typeof x === 'string')
    if (good.length !== v.length) issues.push(`${key}: ${v.length - good.length} non-string entries ignored`)
    return good
  }

  s.model                 = str('model')
  s.theme                 = str('theme')
  s.language              = str('language')
  s.outputStyle           = str('outputStyle')
  s.effortLevel           = str('effortLevel')
  s.alwaysThinkingEnabled = bool('alwaysThinkingEnabled')
  s.voiceEnabled          = bool('voiceEnabled')
  s.voice                 = raw.voice === undefined ? null : raw.voice
  s.hooks                 = raw.hooks === undefined ? null : raw.hooks
  s.apiKeyHelper          = typeof raw.apiKeyHelper === 'string' && raw.apiKeyHelper !== ''

  if ('cleanupPeriodDays' in raw && raw.cleanupPeriodDays !== null) {
    const n = raw.cleanupPeriodDays
    if (typeof n === 'number' && Number.isFinite(n)) s.cleanupPeriodDays = n
    else issues.push('cleanupPeriodDays: expected a number')
  }

  if ('env' in raw && raw.env !== null) {
    if (isObject(raw.env)) s.envKeys = Object.keys(raw.env)
    else issues.push('env: expected an object')
  }

  if ('enabledPlugins' in raw && raw.enabledPlugins !== null) {
    if (isObject(raw.enabledPlugins)) {
      for (const [id, on] of Object.entries(raw.enabledPlugins)) {
        if (typeof on === 'boolean') s.enabledPlugins[id] = on
        else issues.push(`enabledPlugins.${id}: expected true or false`)
      }
    } else issues.push('enabledPlugins: expected an object')
  }

  if ('permissions' in raw && raw.permissions !== null) {
    const p = raw.permissions
    if (isObject(p)) {
      s.permissions.allow                 = strings('permissions.allow', { 'permissions.allow': p.allow })
      s.permissions.ask                   = strings('permissions.ask', { 'permissions.ask': p.ask })
      s.permissions.deny                  = strings('permissions.deny', { 'permissions.deny': p.deny })
      s.permissions.additionalDirectories = strings('permissions.additionalDirectories', { 'permissions.additionalDirectories': p.additionalDirectories })
      if (typeof p.defaultMode === 'string') s.permissions.defaultMode = p.defaultMode
      else if (p.defaultMode !== undefined && p.defaultMode !== null) issues.push('permissions.defaultMode: expected a string')
    } else issues.push('permissions: expected an object')
  }

  return read(s)
}

const union = (lists: string[][]): string[] => [...new Set(lists.flat())]

/**
 * The settings in force, from layers ordered lowest precedence FIRST:
 * `[user, project, local]` — Claude Code's order is local over project over user.
 *
 * What merges, and how:
 * - scalars (`model`, `theme`, `effortLevel`, `cleanupPeriodDays`, …) — the
 *   highest layer that sets one wins; a layer that leaves it out does not
 *   clear it. `voice` is taken whole from the highest layer that has it.
 * - `permissions.allow` / `ask` / `deny` / `additionalDirectories` — every
 *   layer's entries concatenate, duplicates dropped, lowest layer first.
 *   `defaultMode` is a scalar. A `deny` in ANY layer stays in force: the merged
 *   list is the union, never the highest layer's alone.
 * - `enabledPlugins` — merged per plugin id; the highest layer naming an id wins.
 * - `envKeys`, `keys`, `issues` — union.
 * - `apiKeyHelper` — set if any layer sets it.
 * - `hooks` — NOT merged here: an array of each layer's `hooks` value that has
 *   one (lowest first), for the hooks reader, or `null` when no layer has any.
 */
export function mergeSettings(layers: Settings[]): Settings {
  const out = emptySettings()
  const scalars = ['model', 'theme', 'language', 'outputStyle', 'effortLevel', 'alwaysThinkingEnabled', 'voiceEnabled', 'cleanupPeriodDays'] as const
  const hooks: unknown[] = []

  for (const layer of layers) {
    for (const k of scalars) if (layer[k] !== null) (out as Record<string, unknown>)[k] = layer[k]
    if (layer.voice !== null) out.voice = layer.voice
    if (layer.permissions.defaultMode !== null) out.permissions.defaultMode = layer.permissions.defaultMode
    Object.assign(out.enabledPlugins, layer.enabledPlugins)
    if (layer.apiKeyHelper) out.apiKeyHelper = true
    if (layer.hooks !== null) hooks.push(layer.hooks)
  }

  out.permissions.allow                 = union(layers.map(l => l.permissions.allow))
  out.permissions.ask                   = union(layers.map(l => l.permissions.ask))
  out.permissions.deny                  = union(layers.map(l => l.permissions.deny))
  out.permissions.additionalDirectories = union(layers.map(l => l.permissions.additionalDirectories))
  out.envKeys = union(layers.map(l => l.envKeys))
  out.keys    = union(layers.map(l => l.keys))
  out.issues  = union(layers.map(l => l.issues))
  out.hooks   = hooks.length ? hooks : null
  return out
}
