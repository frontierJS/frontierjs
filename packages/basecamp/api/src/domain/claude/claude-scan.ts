// src/domain/claude/claude-scan.ts — the fs half of a read-only scan of the operator's Claude Code configuration.
//
// Walks `~/.claude`, `~/.claude.json` and each project's `.claude/` and hands the
// bytes it finds to the pure readers beside it. It reads, it never writes, and
// it never throws: an unreadable file becomes an issue on that entry and the
// scan goes on, because one root-owned file must not blank the whole screen.
//
// **A project is a path someone worked in, not a directory name.** Transcripts
// live in `projects/<encoded>/`, where `/` and `.` both encode to `-`, so the
// name cannot be decoded back. The project's path is the `cwd` a transcript
// line records. Transcripts reach hundreds of MB, so only the head of the newest
// ones is read, never the whole file.
//
// **Absent is not unreadable.** A settings file the user never wrote is the
// normal case and reports `absent`; only a file that exists and fails to read or
// parse becomes an issue. A project folder that is gone is listed and nothing
// under it is read.
//
// **Directory walks can loop.** A symlinked folder is followed, once per real
// path, and `**` walks stop at `MAX_DEPTH`. A plugin's manifest may name a
// component path, and one that resolves outside the plugin's own folder is
// refused: the manifest is third-party text.
//
// `@path` imports inside a CLAUDE.md are not followed, so a memory file's byte
// size is the file's own and understates what Claude Code loads.

import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, type Stats } from 'node:fs'
import { homedir, platform } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseHooksJson, readHooks, type HookEntry } from './claude-hooks.ts'
import { parseItem, type Item, type ItemKind } from './claude-items.ts'
import { parseClaudeJsonMcp, parseMcpJson, readMcpServers, type ClaudeJsonMcp, type McpServer, type McpWhere } from './claude-mcp.ts'
import {
  parseInstalledPlugins, parseKnownMarketplaces, parseMarketplaceManifest, parsePluginManifest, pluginEnabled,
  type InstalledPlugin, type InstalledPlugins, type Marketplace, type MarketplaceManifest, type Marketplaces, type PluginManifest,
} from './claude-plugins.ts'
import { read, unreadable, type Read } from './claude-read.ts'
import { emptySettings, mergeSettings, parseSettings, type Settings } from './claude-settings.ts'

// ─── shapes ───────────────────────────────────────────────────────────────────

/** Where a skill, agent, command, hook or server was declared. */
export type Origin = {
  scope:   'user' | 'project' | 'plugin'
  /** The project a project-scope entry belongs to; a project-scope plugin install's checkout. */
  project: string | null
  /** The `name@marketplace` id of the plugin it ships in. */
  plugin:  string | null
}

/** A file read through a pure reader. `absent` means no file exists, which is not a failure. */
export type Loaded<T> = { path: string, absent: boolean, result: Read<T> }

/** An fs failure or an unparseable file; the entry it came from carries the same reason. */
export type ScanIssue = { path: string, message: string }

export type ScannedItem = {
  origin: Origin
  kind:   ItemKind
  /** As Claude Code lists it: `name`, `folder:name` for a nested command, `plugin:name` for a plugin's. */
  name:   string
  file:   string
  item:   Read<Item>
}

export type ScannedHooks = {
  origin:  Origin
  /** The settings or hooks file the entries came from; the manifest for a plugin's inline hooks. */
  file:    string
  entries: Read<HookEntry[]>
}

export type MemoryKind = 'managed' | 'user' | 'project' | 'local' | 'rules'

/** A memory file Claude Code loads at session start. Contents are not read; a detail view reads them. */
export type MemoryFile = {
  kind:   MemoryKind
  path:   string
  exists: boolean
  bytes:  number | null
}

export type ScannedPlugin = {
  install:   InstalledPlugin
  /** The manifest `name`, else the name from the install id; the prefix on its items. */
  name:      string
  /** On in the user-level settings. */
  enabled:   boolean
  /** Project paths whose merged settings turn it on. */
  enabledIn: string[]
  /** `install.installPath` exists as a folder. */
  rootExists: boolean
  manifest:  Loaded<PluginManifest>
  items:     ScannedItem[]
  hooks:     ScannedHooks[]
  mcp:       McpServer[]
}

export type ScannedMarketplace = {
  marketplace:  Marketplace
  manifestPath: string
  manifest:     Loaded<MarketplaceManifest>
}

export type ProjectScan = {
  path:        string
  source:      'pin' | 'transcript' | 'both'
  exists:      boolean
  /** Newest transcript's modified time; null for a pinned project with none. */
  lastActive:  string | null
  transcripts: number
  settings: {
    project: Loaded<Settings>
    local:   Loaded<Settings>
    /** `mergeSettings([user, project, local])` over the layers that read. */
    merged:  Settings
  }
  /** Plugin ids the merged settings turn on. */
  enabledPlugins: string[]
  items:     ScannedItem[]
  hooks:     ScannedHooks[]
  mcpJson:   Loaded<McpServer[]>
  memory:    MemoryFile[]
}

export type ClaudeConfig = {
  scannedAt:  string
  durationMs: number
  home:       string
  configDir:  string
  claudeJson: string
  user: {
    settings: Loaded<Settings>
    items:    ScannedItem[]
    hooks:    ScannedHooks[]
    /** Managed policy, the user's CLAUDE.md and `rules/`. */
    memory:   MemoryFile[]
  }
  /** `~/.claude.json`: user servers, local servers per project, and `.mcp.json` approvals. */
  mcp: Loaded<ClaudeJsonMcp>
  plugins: {
    installed:    Loaded<InstalledPlugins>
    marketplaces: Loaded<Marketplaces>
    list:         ScannedPlugin[]
    catalogs:     ScannedMarketplace[]
  }
  projects: ProjectScan[]
  issues:   ScanIssue[]
}

export type ScanOptions = {
  configDir?: string
  home?:      string
  pinPaths?:  string[]
}

// ─── limits ───────────────────────────────────────────────────────────────────

/** Deepest `**` walk. A symlink loop is caught by realpath; this catches a tree that is only deep. */
const MAX_DEPTH      = 6
/** Enough for the first lines of a transcript; the files themselves reach hundreds of MB. */
const HEAD_BYTES     = 64 * 1024
/** Newest transcripts tried per project before giving up on finding a `cwd`. */
const HEAD_FILES     = 3
/** No Claude Code config file is near this; a larger one is a wrong file, not a setting. */
const MAX_FILE_BYTES = 32 * 1024 * 1024
const SKIP_DIRS      = new Set(['node_modules', '.git'])

// ─── scan context ─────────────────────────────────────────────────────────────

type Cx = { issues: ScanIssue[], issue: (path: string, message: string) => void }

function makeCx(): Cx {
  const issues: ScanIssue[] = []
  return { issues, issue: (path, message) => { issues.push({ path, message }) } }
}

const absentCode = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

const failure = (e: unknown): string => {
  const err = e as NodeJS.ErrnoException
  return err?.code ? `${err.code}: ${err.message}` : String(err?.message ?? e)
}

/** `stat` that follows symlinks; null when the path is missing or unreachable. */
function statOf(path: string): Stats | null {
  try { return statSync(path) } catch { return null }
}

const isDir  = (path: string): boolean => statOf(path)?.isDirectory() ?? false
const isFile = (path: string): boolean => statOf(path)?.isFile() ?? false

function realOf(path: string): string {
  try { return realpathSync(path) } catch { return path }
}

/** Entry names in a folder, sorted; empty when it is absent, an issue when it is unreadable. */
function listDir(cx: Cx, dir: string): string[] {
  try { return readdirSync(dir).sort() }
  catch (e) {
    if (!absentCode(e)) cx.issue(dir, failure(e))
    return []
  }
}

type Text = { kind: 'absent' } | { kind: 'error', reason: string } | { kind: 'text', text: string }

function loadText(path: string): Text {
  try {
    const st = statSync(path)
    if (st.isDirectory()) return { kind: 'error', reason: 'is a directory' }
    if (st.size > MAX_FILE_BYTES) return { kind: 'error', reason: `${st.size} bytes, over the ${MAX_FILE_BYTES} limit` }
    return { kind: 'text', text: readFileSync(path, 'utf8') }
  } catch (e) {
    return absentCode(e) ? { kind: 'absent' } : { kind: 'error', reason: failure(e) }
  }
}

function load<T>(cx: Cx, path: string, parse: (text: string) => Read<T>): Loaded<T> {
  const t = loadText(path)
  if (t.kind === 'absent') return { path, absent: true, result: unreadable('absent') }
  if (t.kind === 'error')  { cx.issue(path, t.reason); return { path, absent: false, result: unreadable(t.reason) } }
  const result = parse(t.text)
  if (!result.ok) cx.issue(path, result.reason)
  return { path, absent: false, result }
}

const notRead = <T>(path: string): Loaded<T> => ({ path, absent: true, result: unreadable('absent') })

// ─── walks ────────────────────────────────────────────────────────────────────

type Found = { file: string, rel: string[] }

/** Every `.md` under `dir`, with its folder path relative to `dir`. Follows symlinks once per real path. */
function walkMd(cx: Cx, dir: string): Found[] {
  const out: Found[] = []
  const seen = new Set<string>()
  const go = (d: string, rel: string[], depth: number): void => {
    const real = realOf(d)
    if (seen.has(real)) return
    seen.add(real)
    for (const name of listDir(cx, d)) {
      const path = join(d, name)
      const st = statOf(path)
      if (!st) continue
      if (st.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(name)) go(path, [...rel, name], depth + 1)
        else if (depth >= MAX_DEPTH) cx.issue(path, `deeper than ${MAX_DEPTH} levels, not read`)
      } else if (st.isFile() && extname(name).toLowerCase() === '.md') {
        out.push({ file: path, rel: [...rel, basename(name, extname(name))] })
      }
    }
  }
  go(dir, [], 0)
  return out
}

// ─── items ────────────────────────────────────────────────────────────────────

type ItemSink = { origin: Origin, prefix: string | null, seen: Set<string>, out: ScannedItem[] }

const sinkFor = (origin: Origin, prefix: string | null): ItemSink => ({ origin, prefix, seen: new Set(), out: [] })

function addItem(cx: Cx, sink: ItemSink, kind: ItemKind, name: string, file: string, nameFromFile: boolean): void {
  const real = realOf(file)
  if (sink.seen.has(real)) return
  sink.seen.add(real)

  const t = loadText(file)
  let item: Read<Item>
  if (t.kind === 'text') item = parseItem(kind, name, t.text)
  else { item = unreadable(t.kind === 'absent' ? 'absent' : t.reason); cx.issue(file, item.ok ? '' : item.reason) }

  // A command is named by its path; for a skill or agent the frontmatter `name` wins, as in Claude Code.
  const own = nameFromFile || !item.ok ? name : item.value.name
  sink.out.push({ origin: sink.origin, kind, name: sink.prefix ? `${sink.prefix}:${own}` : own, file, item })
}

/** A path is a skill itself when it holds a SKILL.md, otherwise a folder of skills. */
function collectSkills(cx: Cx, sink: ItemSink, dirs: string[]): void {
  for (const dir of dirs) {
    if (isFile(join(dir, 'SKILL.md'))) { addItem(cx, sink, 'skill', basename(dir), join(dir, 'SKILL.md'), false); continue }
    for (const name of listDir(cx, dir)) {
      const file = join(dir, name, 'SKILL.md')
      if (isFile(file)) addItem(cx, sink, 'skill', name, file, false)
    }
  }
}

/** A path is one agent file, or a folder whose top-level `.md` files are agents. */
function collectAgents(cx: Cx, sink: ItemSink, paths: string[]): void {
  for (const p of paths) {
    if (isFile(p)) { addItem(cx, sink, 'agent', basename(p, extname(p)), p, false); continue }
    for (const name of listDir(cx, p)) {
      const file = join(p, name)
      if (extname(name).toLowerCase() === '.md' && isFile(file)) addItem(cx, sink, 'agent', basename(name, extname(name)), file, false)
    }
  }
}

/** A path is one command file, or a folder walked for `.md`; a subfolder prefixes the name as `folder:name`. */
function collectCommands(cx: Cx, sink: ItemSink, paths: string[]): void {
  for (const p of paths) {
    if (isFile(p)) { addItem(cx, sink, 'command', basename(p, extname(p)), p, true); continue }
    for (const f of walkMd(cx, p)) addItem(cx, sink, 'command', f.rel.join(':'), f.file, true)
  }
}

function itemsUnder(cx: Cx, root: string, origin: Origin): ScannedItem[] {
  const sink = sinkFor(origin, null)
  collectSkills(cx, sink, [join(root, 'skills')])
  collectAgents(cx, sink, [join(root, 'agents')])
  collectCommands(cx, sink, [join(root, 'commands')])
  return sink.out
}

// ─── hooks ────────────────────────────────────────────────────────────────────

function settingsHooks(origin: Origin, loaded: Loaded<Settings>): ScannedHooks[] {
  if (!loaded.result.ok || loaded.result.value.hooks === null) return []
  return [{ origin, file: loaded.path, entries: readHooks(loaded.result.value.hooks) }]
}

// ─── memory ───────────────────────────────────────────────────────────────────

function memoryFile(kind: MemoryKind, path: string): MemoryFile {
  const st = statOf(path)
  const exists = st?.isFile() ?? false
  return { kind, path, exists, bytes: exists ? st!.size : null }
}

function managedMemoryPath(): string {
  const os = platform()
  if (os === 'darwin') return '/Library/Application Support/ClaudeCode/CLAUDE.md'
  if (os === 'win32')  return 'C:\\Program Files\\ClaudeCode\\CLAUDE.md'
  return '/etc/claude-code/CLAUDE.md'
}

/** Rule files that exist; a rules folder is optional, so a missing one lists nothing. */
function rulesIn(cx: Cx, dir: string): MemoryFile[] {
  return walkMd(cx, dir).map(f => memoryFile('rules', f.file))
}

/** The project dir and each ancestor up to `/`, nearest first. */
function ancestry(dir: string): string[] {
  const out: string[] = []
  for (let d = dir; ; d = dirname(d)) {
    out.push(d)
    if (dirname(d) === d) return out
  }
}

function projectMemory(cx: Cx, project: string, userClaudeMd: string): MemoryFile[] {
  const out: MemoryFile[] = []
  for (const dir of ancestry(project)) {
    out.push(memoryFile('project', join(dir, 'CLAUDE.md')))
    // `~/.claude/CLAUDE.md` is also `<ancestor>/.claude/CLAUDE.md` for the home folder;
    // it is already listed under the user, and a second row would count it twice.
    const nested = join(dir, '.claude', 'CLAUDE.md')
    if (resolve(nested) !== resolve(userClaudeMd)) out.push(memoryFile('project', nested))
    out.push(memoryFile('local', join(dir, 'CLAUDE.local.md')))
  }
  out.push(...rulesIn(cx, join(project, '.claude', 'rules')))
  return out
}

// ─── plugins ──────────────────────────────────────────────────────────────────

type Components = Pick<ScannedPlugin, 'name' | 'rootExists' | 'manifest' | 'items' | 'hooks' | 'mcp'>

/** A manifest names paths as a string or a list of strings; anything else names none. */
const pathList = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/** A manifest path resolved against the plugin root, or null when it points outside it. */
function insideRoot(cx: Cx, root: string, manifest: string, p: string): string | null {
  const abs = resolve(root, p)
  const rel = relative(root, abs)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    cx.issue(manifest, `component path ${p} is outside the plugin folder, not read`)
    return null
  }
  return abs
}

function scanPlugin(cx: Cx, install: InstalledPlugin): Components {
  const empty = (manifest: Loaded<PluginManifest>, rootExists: boolean): Components =>
    ({ name: install.name, rootExists, manifest, items: [], hooks: [], mcp: [] })

  const root = install.installPath
  if (!root) {
    cx.issue(install.id, 'installed with no installPath')
    return empty(notRead(''), false)
  }
  if (!isDir(root)) {
    cx.issue(root, `${install.id}: install folder is missing`)
    return empty(notRead(join(root, '.claude-plugin', 'plugin.json')), false)
  }

  const manifestPath = join(root, '.claude-plugin', 'plugin.json')
  const manifest = load(cx, manifestPath, parsePluginManifest)
  const m = manifest.result.ok ? manifest.result.value : null
  const name = m?.name ?? install.name

  const origin: Origin = { scope: 'plugin', project: install.projectPath, plugin: install.id }
  const named = (v: unknown): string[] =>
    pathList(v).map(p => insideRoot(cx, root, manifestPath, p)).filter((p): p is string => p !== null)

  // A manifest path adds to the default folder; the same file reached twice is listed once.
  const sink = sinkFor(origin, name)
  collectSkills(cx, sink, [join(root, 'skills'), ...named(m?.skills)])
  collectAgents(cx, sink, [join(root, 'agents'), ...named(m?.agents)])
  collectCommands(cx, sink, [join(root, 'commands'), ...named(m?.commands)])

  const hooks: ScannedHooks[] = []
  const hookFiles = new Set<string>()
  const addHooksFile = (file: string): void => {
    const real = realOf(file)
    if (hookFiles.has(real)) return
    hookFiles.add(real)
    const loaded = load(cx, file, parseHooksJson)
    if (!loaded.absent) hooks.push({ origin, file, entries: loaded.result })
  }
  addHooksFile(join(root, 'hooks', 'hooks.json'))
  for (const h of Array.isArray(m?.hooks) ? m!.hooks as unknown[] : m?.hooks === undefined ? [] : [m!.hooks]) {
    if (typeof h === 'string') { const p = insideRoot(cx, root, manifestPath, h); if (p) addHooksFile(p) }
    else hooks.push({ origin, file: manifestPath, entries: readHooks(h) })
  }

  const mcp: McpServer[] = []
  const mcpFiles = new Set<string>()
  const where: McpWhere = { scope: 'plugin', plugin: install.id }
  const addMcpFile = (file: string): void => {
    const real = realOf(file)
    if (mcpFiles.has(real)) return
    mcpFiles.add(real)
    const loaded = load(cx, file, text => parseMcpJson(text, 'plugin', install.id))
    if (loaded.result.ok) mcp.push(...loaded.result.value)
  }
  addMcpFile(join(root, '.mcp.json'))
  for (const s of Array.isArray(m?.mcpServers) ? m!.mcpServers as unknown[] : m?.mcpServers === undefined ? [] : [m!.mcpServers]) {
    if (typeof s === 'string') { const p = insideRoot(cx, root, manifestPath, s); if (p) addMcpFile(p) }
    else {
      const inline = readMcpServers(s, where)
      if (inline.ok) mcp.push(...inline.value)
      else cx.issue(manifestPath, inline.reason)
    }
  }

  return { name, rootExists: true, manifest, items: sink.out, hooks, mcp }
}

function scanMarketplace(cx: Cx, configDir: string, marketplace: Marketplace): ScannedMarketplace {
  const root = marketplace.installLocation ?? join(configDir, 'plugins', 'marketplaces', marketplace.name)
  const manifestPath = join(root, '.claude-plugin', 'marketplace.json')
  return { marketplace, manifestPath, manifest: load(cx, manifestPath, parseMarketplaceManifest) }
}

// ─── projects ─────────────────────────────────────────────────────────────────

type Sighting = { path: string, source: 'pin' | 'transcript', lastActive: number | null, transcripts: number }

/** The first `cwd` string on a parseable line in a transcript's head; the last line of a cut head will not parse. */
function cwdFromHead(file: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (!line.includes('"cwd"')) continue
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd
        if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd
      } catch { /* a line cut at the head boundary, or not JSON */ }
    }
  } catch { /* a transcript that cannot be opened names no project */ }
  finally { if (fd !== null) try { closeSync(fd) } catch { /* nothing to release */ } }
  return null
}

function transcriptProjects(cx: Cx, configDir: string): Sighting[] {
  const root = join(configDir, 'projects')
  const out: Sighting[] = []
  for (const dirName of listDir(cx, root)) {
    const dir = join(root, dirName)
    if (!isDir(dir)) continue
    const files = listDir(cx, dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ path: join(dir, f), mtime: statOf(join(dir, f))?.mtimeMs ?? 0 }))
      .sort((a, b) => b.mtime - a.mtime)
    if (files.length === 0) continue

    let cwd: string | null = null
    for (const f of files.slice(0, HEAD_FILES)) { cwd = cwdFromHead(f.path); if (cwd) break }
    if (!cwd) { cx.issue(dir, 'no cwd in the head of the newest transcripts; project not listed'); continue }
    out.push({ path: resolve(cwd), source: 'transcript', lastActive: files[0].mtime, transcripts: files.length })
  }
  return out
}

function unionProjects(pins: string[], seen: Sighting[]): Map<string, Sighting & { both: boolean }> {
  const map = new Map<string, Sighting & { both: boolean }>()
  for (const p of pins) {
    const path = resolve(p)
    map.set(path, { path, source: 'pin', lastActive: null, transcripts: 0, both: false })
  }
  for (const t of seen) {
    const have = map.get(t.path)
    if (!have) { map.set(t.path, { ...t, both: false }); continue }
    // Two encoded folders can name one project; the counts add and the later activity wins.
    have.transcripts += t.transcripts
    have.lastActive = Math.max(have.lastActive ?? 0, t.lastActive ?? 0) || null
    if (have.source === 'pin') have.both = true
  }
  return map
}

function scanProject(cx: Cx, found: Sighting & { both: boolean }, user: Loaded<Settings>, configDir: string, userClaudeMd: string): ProjectScan {
  const path = found.path
  const source = found.both ? 'both' : found.source
  const exists = isDir(path)
  const lastActive = found.lastActive ? new Date(found.lastActive).toISOString() : null
  const base = { path, source, exists, lastActive, transcripts: found.transcripts } as const

  const settingsPath = join(path, '.claude', 'settings.json')
  const localPath    = join(path, '.claude', 'settings.local.json')
  if (!exists) {
    return {
      ...base,
      settings: { project: notRead(settingsPath), local: notRead(localPath), merged: emptySettings() },
      enabledPlugins: [], items: [], hooks: [], mcpJson: notRead(join(path, '.mcp.json')), memory: [],
    }
  }

  // A session started in the home folder finds the config dir as its `.claude/`;
  // reading it again as the project's would list every user skill and hook twice.
  const isConfigDir = realOf(join(path, '.claude')) === realOf(configDir)
  const project = isConfigDir ? notRead<Settings>(settingsPath) : load(cx, settingsPath, parseSettings)
  const local   = load(cx, localPath, parseSettings)
  const layers  = [user, project, local].flatMap(l => l.result.ok ? [l.result.value] : [])
  const merged  = mergeSettings(layers)

  const origin: Origin = { scope: 'project', project: path, plugin: null }
  return {
    ...base,
    settings: { project, local, merged },
    enabledPlugins: Object.keys(merged.enabledPlugins).filter(id => pluginEnabled(id, merged.enabledPlugins)),
    items:   isConfigDir ? [] : itemsUnder(cx, join(path, '.claude'), origin),
    hooks:   [...settingsHooks(origin, project), ...settingsHooks(origin, local)],
    mcpJson: load(cx, join(path, '.mcp.json'), text => parseMcpJson(text, 'project', path)),
    memory:  projectMemory(cx, path, userClaudeMd),
  }
}

// ─── scan ─────────────────────────────────────────────────────────────────────

/** Where Claude Code keeps its files: the option, else `CLAUDE_CONFIG_DIR`, else `<home>/.claude`. */
export function claudeConfigDir(opts: { home?: string, configDir?: string } = {}): string {
  return opts.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(opts.home ?? homedir(), '.claude')
}

/**
 * Read the whole configuration once. Synchronous: a few hundred small files and
 * the heads of one transcript per project.
 *
 * `configDir` is the option, else `CLAUDE_CONFIG_DIR`, else `<home>/.claude`.
 * Claude Code keeps `.claude.json` beside the config dir when one is set and in
 * the home folder otherwise; reading the wrong one shows an empty server list.
 */
export function scanClaude(opts: ScanOptions = {}): ClaudeConfig {
  const t0 = performance.now()
  const cx = makeCx()

  const home = opts.home ?? homedir()
  const custom = opts.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? null
  const configDir = claudeConfigDir({ home, configDir: opts.configDir })
  const claudeJson = custom ? join(custom, '.claude.json') : join(home, '.claude.json')

  const userSettings = load(cx, join(configDir, 'settings.json'), parseSettings)
  const userEnabled = userSettings.result.ok ? userSettings.result.value.enabledPlugins : {}
  const userOrigin: Origin = { scope: 'user', project: null, plugin: null }
  const userClaudeMd = join(configDir, 'CLAUDE.md')

  const mcp = load(cx, claudeJson, parseClaudeJsonMcp)

  const projects = [...unionProjects(opts.pinPaths ?? [], transcriptProjects(cx, configDir)).values()]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(f => scanProject(cx, f, userSettings, configDir, userClaudeMd))

  const installed    = load(cx, join(configDir, 'plugins', 'installed_plugins.json'), parseInstalledPlugins)
  const marketplaces = load(cx, join(configDir, 'plugins', 'known_marketplaces.json'), parseKnownMarketplaces)

  // One install folder is scanned once however many installs point at it.
  const byRoot = new Map<string, Components>()
  const list: ScannedPlugin[] = (installed.result.ok ? installed.result.value.plugins : []).map(install => {
    const key = `${install.id}\n${install.installPath ?? ''}`
    let parts = byRoot.get(key)
    if (!parts) { parts = scanPlugin(cx, install); byRoot.set(key, parts) }
    return {
      install,
      ...parts,
      enabled:   pluginEnabled(install.id, userEnabled),
      enabledIn: projects.filter(p => p.enabledPlugins.includes(install.id)).map(p => p.path),
    }
  })

  const catalogs = (marketplaces.result.ok ? marketplaces.result.value.marketplaces : [])
    .map(m => scanMarketplace(cx, configDir, m))

  return {
    scannedAt:  new Date().toISOString(),
    durationMs: Math.round((performance.now() - t0) * 10) / 10,
    home, configDir, claudeJson,
    user: {
      settings: userSettings,
      items:    itemsUnder(cx, configDir, userOrigin),
      hooks:    settingsHooks(userOrigin, userSettings),
      memory:   [
        memoryFile('managed', managedMemoryPath()),
        memoryFile('user', userClaudeMd),
        ...rulesIn(cx, join(configDir, 'rules')),
      ],
    },
    mcp,
    plugins: { installed, marketplaces, list, catalogs },
    projects,
    issues: cx.issues,
  }
}

// ─── flat views ───────────────────────────────────────────────────────────────

/** Every item once: two installs of one plugin share their scan and must not list twice. */
export function allItems(c: ClaudeConfig): ScannedItem[] {
  return [...new Set([...c.user.items, ...c.projects.flatMap(p => p.items), ...c.plugins.list.flatMap(p => p.items)])]
}

export function allHooks(c: ClaudeConfig): ScannedHooks[] {
  return [...new Set([...c.user.hooks, ...c.projects.flatMap(p => p.hooks), ...c.plugins.list.flatMap(p => p.hooks)])]
}

/** Every MCP server once, tagged by its own `scope`, `project` and `plugin`. */
export function allMcpServers(c: ClaudeConfig): McpServer[] {
  const json = c.mcp.result.ok ? [...c.mcp.result.value.user, ...c.mcp.result.value.local] : []
  const project = c.projects.flatMap(p => p.mcpJson.result.ok ? p.mcpJson.result.value : [])
  return [...new Set([...json, ...project, ...c.plugins.list.flatMap(p => p.mcp)])]
}

// ─── one listed file ──────────────────────────────────────────────────────────

/** A detail view's file: a skill, agent or command, or a memory file. Shown, never parsed. */
export type ListedFile = { path: string, bytes: number, text: string }

/** Past this a detail view draws a file nobody reads; none of these is near it. */
const MAX_SHOWN_BYTES = 1024 * 1024

/**
 * A file's text, only when `c` listed it as an item or a memory file. The path
 * arrives from a browser, and the scan's own list is what keeps a request from
 * naming `~/.ssh/id_ed25519` or a `../` walk out of a plugin folder.
 */
export function readListedFile(c: ClaudeConfig, path: string): Read<ListedFile> {
  const listed = new Set([
    ...allItems(c).map(i => i.file),
    ...c.user.memory.filter(m => m.exists).map(m => m.path),
    ...c.projects.flatMap(p => p.memory.filter(m => m.exists).map(m => m.path)),
  ])
  if (!listed.has(path)) return unreadable('not a file this scan listed')
  const st = statOf(path)
  if (st && st.size > MAX_SHOWN_BYTES) return unreadable(`${st.size} bytes, over the ${MAX_SHOWN_BYTES} shown`)
  const t = loadText(path)
  if (t.kind === 'absent') return unreadable('gone since the scan')
  if (t.kind === 'error')  return unreadable(t.reason)
  return read({ path, bytes: Buffer.byteLength(t.text), text: t.text })
}
