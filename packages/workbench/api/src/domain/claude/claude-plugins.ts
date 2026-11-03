// src/domain/claude/claude-plugins.ts — the plugins Claude Code has installed, and the marketplaces they came from.
//
// Four files, none of them a plugin's code:
//   - `plugins/installed_plugins.json`          what is installed, at which scope
//   - `plugins/known_marketplaces.json`         the catalogs Claude Code is tracking
//   - a marketplace's `marketplace.json`        the plugins that catalog offers
//   - an installed plugin's `plugin.json`       its own manifest
//
// **Installed is not enabled.** `installed_plugins.json` is the install record;
// whether a plugin runs is `enabledPlugins` in the merged settings. A plugin
// with no `enabledPlugins` entry is OFF (`pluginEnabled`), the opposite of what
// the word "installed" suggests, and a screen that listed installs as active
// would be wrong about every plugin the user disabled.
//
// One plugin can be installed more than once — at user scope and again for a
// project — so installs are one row per INSTALL, and `id` is not unique.
//
// A manifest is third-party text. Every field is read defensively, a field of
// the wrong shape comes back `null`, and nothing here follows a path it names.

import { read, readJsonObject, unreadable, type Read } from './claude-read.ts'

type Obj = Record<string, unknown>

const isObject = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string | null => typeof v === 'string' && v !== '' ? v : null

/** Whether a plugin runs: only an explicit `true` in the merged `enabledPlugins`. */
export function pluginEnabled(id: string, enabledPlugins: Record<string, boolean>): boolean {
  return enabledPlugins[id] === true
}

/** A plugin's author, which a manifest writes as a bare name or as `{ name, email, url }`. */
export type Author = { name: string, email: string | null, url: string | null }

function readAuthor(v: unknown): Author | null {
  if (typeof v === 'string') return v === '' ? null : { name: v, email: null, url: null }
  if (!isObject(v)) return null
  const name = text(v.name)
  return name ? { name, email: text(v.email), url: text(v.url) } : null
}

// --- installed_plugins.json -------------------------------------------------

export type InstalledPlugin = {
  /** `name@marketplace` — the key `enabledPlugins` uses. */
  id:           string
  name:         string
  marketplace:  string | null
  /** `user`, `project`, `local` or `managed`, as written. */
  scope:        string | null
  /** The checkout a project- or local-scope install belongs to; null at user scope. */
  projectPath:  string | null
  installPath:  string | null
  version:      string | null
  installedAt:  string | null
  lastUpdated:  string | null
  gitCommitSha: string | null
}

export type InstalledPlugins = { plugins: InstalledPlugin[], issues: string[] }

export function parseInstalledPlugins(source: string): Read<InstalledPlugins> {
  const parsed = readJsonObject(source)
  if (!parsed.ok) return parsed
  const map = parsed.value.plugins
  if (!isObject(map)) return unreadable('no "plugins" object')

  const plugins: InstalledPlugin[] = []
  const issues: string[] = []
  for (const [id, installs] of Object.entries(map)) {
    if (!Array.isArray(installs)) { issues.push(`${id}: expected a list of installs`); continue }
    const at = id.lastIndexOf('@')
    const name = at > 0 ? id.slice(0, at) : id
    const marketplace = at > 0 ? id.slice(at + 1) : null
    for (const i of installs) {
      if (!isObject(i)) { issues.push(`${id}: an install is not an object`); continue }
      plugins.push({
        id, name, marketplace,
        scope:        text(i.scope),
        projectPath:  text(i.projectPath),
        installPath:  text(i.installPath),
        version:      text(i.version),
        installedAt:  text(i.installedAt),
        lastUpdated:  text(i.lastUpdated),
        gitCommitSha: text(i.gitCommitSha),
      })
    }
  }
  return read({ plugins, issues })
}

// --- known_marketplaces.json ------------------------------------------------

/** Where a marketplace is fetched from. `other` keeps the raw object for a kind this file does not know. */
export type MarketplaceSource =
  | { kind: 'github', repo: string, ref: string | null }
  | { kind: 'git',    url: string,  ref: string | null }
  | { kind: 'url',    url: string }
  | { kind: 'path',   path: string }
  | { kind: 'other',  raw: unknown }

/** A source with a credential in its URL (`https://user:token@host/…`) loses it before it leaves. */
const stripCredential = (url: string): string => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, '$1')

export function readMarketplaceSource(v: unknown): MarketplaceSource {
  if (!isObject(v)) return { kind: 'other', raw: v }
  const kind = v.source
  const ref = text(v.ref)
  if (kind === 'github' && text(v.repo)) return { kind: 'github', repo: v.repo as string, ref }
  if (kind === 'git' && text(v.url))     return { kind: 'git', url: stripCredential(v.url as string), ref }
  if (kind === 'url' && text(v.url))     return { kind: 'url', url: stripCredential(v.url as string) }
  if ((kind === 'directory' || kind === 'file') && text(v.path)) return { kind: 'path', path: v.path as string }
  return { kind: 'other', raw: v }
}

export type Marketplace = {
  name:            string
  source:          MarketplaceSource
  /** The folder Claude Code cloned or copied it to; where the manifest is read from. */
  installLocation: string | null
  lastUpdated:     string | null
}

export type Marketplaces = { marketplaces: Marketplace[], issues: string[] }

export function parseKnownMarketplaces(source: string): Read<Marketplaces> {
  const parsed = readJsonObject(source)
  if (!parsed.ok) return parsed
  const marketplaces: Marketplace[] = []
  const issues: string[] = []
  for (const [name, entry] of Object.entries(parsed.value)) {
    if (!isObject(entry)) { issues.push(`${name}: not an object`); continue }
    marketplaces.push({
      name,
      source:          readMarketplaceSource(entry.source),
      installLocation: text(entry.installLocation),
      lastUpdated:     text(entry.lastUpdated),
    })
  }
  return read({ marketplaces, issues })
}

// --- marketplace.json -------------------------------------------------------

/** Where an offered plugin is fetched from: a path inside the marketplace, or a remote. */
export type PluginSource =
  | { kind: 'path',       path: string }
  | { kind: 'github',     repo: string, ref: string | null }
  | { kind: 'url',        url: string,  ref: string | null }
  | { kind: 'git-subdir', url: string,  path: string, ref: string | null }
  | { kind: 'other',      raw: unknown }

export function readPluginSource(v: unknown): PluginSource | null {
  if (v === undefined || v === null) return null
  if (typeof v === 'string') return { kind: 'path', path: v }
  if (!isObject(v)) return { kind: 'other', raw: v }
  const ref = text(v.ref)
  if (v.source === 'github' && text(v.repo)) return { kind: 'github', repo: v.repo as string, ref }
  if (v.source === 'url' && text(v.url))     return { kind: 'url', url: stripCredential(v.url as string), ref }
  if (v.source === 'git-subdir' && text(v.url) && text(v.path))
    return { kind: 'git-subdir', url: stripCredential(v.url as string), path: v.path as string, ref }
  return { kind: 'other', raw: v }
}

export type OfferedPlugin = {
  name:        string
  description: string | null
  category:    string | null
  author:      Author | null
  homepage:    string | null
  version:     string | null
  source:      PluginSource | null
}

export type MarketplaceManifest = {
  name:        string | null
  description: string | null
  owner:       Author | null
  plugins:     OfferedPlugin[]
  issues:      string[]
}

/** `plugins` is a list in every catalog seen; an object map keyed by name is read too, since the manifest schema has allowed one. */
export function parseMarketplaceManifest(source: string): Read<MarketplaceManifest> {
  const parsed = readJsonObject(source)
  if (!parsed.ok) return parsed
  const raw = parsed.value
  const issues: string[] = []

  let entries: [string | null, unknown][]
  if (Array.isArray(raw.plugins)) entries = raw.plugins.map(e => [null, e])
  else if (isObject(raw.plugins)) entries = Object.entries(raw.plugins)
  else if (raw.plugins === undefined) entries = []
  else return unreadable('"plugins" is neither a list nor an object')

  const plugins: OfferedPlugin[] = []
  for (const [key, e] of entries) {
    if (!isObject(e)) { issues.push(`${key ?? 'a plugin'}: not an object`); continue }
    const name = text(e.name) ?? key
    if (!name) { issues.push('a plugin has no name'); continue }
    plugins.push({
      name,
      description: text(e.description),
      category:    text(e.category),
      author:      readAuthor(e.author),
      homepage:    text(e.homepage),
      version:     text(e.version),
      source:      readPluginSource(e.source),
    })
  }
  return read({ name: text(raw.name), description: text(raw.description), owner: readAuthor(raw.owner), plugins, issues })
}

// --- plugin.json ------------------------------------------------------------

export type PluginManifest = {
  name:        string | null
  version:     string | null
  description: string | null
  author:      Author | null
  /**
   * The component locations the manifest overrides, exactly as written — a
   * path, a list of paths, or (for `hooks` and `mcpServers`) an inline object.
   * `undefined` for a key the manifest leaves out, meaning the default folder.
   */
  commands:   unknown
  agents:     unknown
  skills:     unknown
  hooks:      unknown
  mcpServers: unknown
}

export function parsePluginManifest(source: string): Read<PluginManifest> {
  const parsed = readJsonObject(source)
  if (!parsed.ok) return parsed
  const raw = parsed.value
  return read({
    name:        text(raw.name),
    version:     text(raw.version),
    description: text(raw.description),
    author:      readAuthor(raw.author),
    commands:    raw.commands,
    agents:      raw.agents,
    skills:      raw.skills,
    hooks:       raw.hooks,
    mcpServers:  raw.mcpServers,
  })
}
