// src/services/claude/claude.service.ts
// Claude Code's configuration on this machine, read (`domain/claude/claude-scan.ts`).
//
// No model and nothing in the database: the config is files under the account's
// home and the pinned checkouts, so this is offered only where the Workbench is
// (LOCAL_MACHINE=1, never under NODE_ENV=production) and at ADMINISTRATOR like
// it. Nothing here writes.
//
//   POST /claude   config   plugins, marketplaces, skills, agents, commands, hooks, MCP servers, settings and
//                           memory files, user-level and per project — one call, because the screen renders every section from it
//   POST /claude   file     { path } — a skill, agent, command or memory file's text, for a detail drawer
//   POST /claude   stats    { days? } — per local day, per model and per project: messages, tokens and an
//                           estimated cost (30 days by default, 0 = all); with when the index last moved
//   POST /claude   insights { window: '24h' | '7d' } — the share of cost-weighted use per project, model and
//                           tool, a message's cost split evenly across the tools it called
//   POST /claude   sessions { cwd?, limit? } — sessions per project, newest first, with their spend
//   POST /claude   transcript { sessionId } — one session folded into turns, read from the file the index lists
//   POST /claude   context  { cwd } — what the project's newest session sent before its first prompt, per part
//   POST /claude   account  — `claude auth status`: plan, email, org, auth method
//   POST /claude   quota    { force? } — the session and weekly limits, from the account's usage endpoint
//
// Live and health (Phase 4) — `rev` is what an open screen polls, the rest run Claude Code or a server:
//
//   POST /claude   rev        — the digest `config` also carries; a moved one means the files changed under the screen
//   POST /claude   mcpHealth  { project? } — `claude mcp list` from that checkout (else home): which servers start
//   POST /claude   mcpTools   { name, scope, project?, plugin? } — one server started, its tool list read, stopped
//   POST /claude   hookTools  — the programs each hook command calls, each found on the API's PATH or not
//   POST /claude   doctor     { project? } — `claude doctor` from that checkout (else home), as facts and findings
//
// The writes (IDEAS/claude-code.md Phase 3), each one `ClaudeWrite` row through `domain/claude/claude-write.ts`,
// which the call trail names and `undo` takes back:
//
//   POST /claude   writes      { limit? } — the newest writes, each with whether it can be undone, and the
//                              user and local MCP servers disabled here
//   POST /claude   undo        { id }
//   POST /claude   plugin      { id, action: enable|disable|install|update|uninstall, scope?, project? }
//   POST /claude   marketplace { action: add|update|remove, source? | name? }
//   POST /claude   mcp         { action: add|remove|disable|enable|logout, name, scope, project?, config? }
//   POST /claude   settings    { scope: user|project|local, project?, patch } — the editor's keys; null clears
//   POST /claude   permissions { scope, project?, allow, ask, deny, check? } — check answers the rule checks only
//   POST /claude   save        { path, text } — a skill, agent, command or memory file this scan lists
//   POST /claude   trash       { path } — a user or project skill, agent or command, into the writer's trash
//
// `context`, `account`, `quota`, `mcpHealth`, `mcpTools` and `doctor` answer `{ ok, value }` or `{ ok: false, reason }`: Claude Code changes
// these formats without notice, and the screen shows *unavailable* with the reason rather than a wrong number.
// `quota` reads the OAuth token Claude Code keeps and never refreshes it (`FJS-D1711`), and a 429 there
// stops reads for minutes — the endpoint shares the account's limit with every running `claude`.
//
// `stats`, `insights` and `sessions` read the usage INDEX (`ClaudeMessage`, `ClaudeTranscript`), which
// `jobs/claude-index.job.ts` keeps within five minutes of the transcripts — `indexedAt` says how stale —
// and which still holds what Claude Code has since deleted. The dollars are an estimate at list price
// (`domain/claude/claude-pricing.ts`) and every answer carries the page and the date they were read.
//
// The Workbench's pins are the checkouts whose project layer is read, so a pin
// added there shows here on the next call. `file`, `save` and `trash` scan again
// rather than trusting a path the browser remembers: only a file this scan
// lists is read or written, and a plugin's own files are neither written nor
// trashed — its next update would put them back.

import { accessSync, constants } from 'node:fs'
import { homedir }                from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createService, BadRequest, Conflict, NotFound, Unprocessable, $ } from '@frontierjs/junction'
import { LEVELS }                  from '@frontierjs/litestone'
import { WORKSPACE_QUERY }         from '../../core/hooks.ts'
import { localMachineRefusal }     from '../../core/env.ts'
import { allHooks, allItems, claudeConfigDir, claudeJsonPath, configRev, readListedFile, scanClaude, type ClaudeConfig } from '../../domain/claude/claude-scan.ts'
import { read, readJsonObject, unreadable } from '../../domain/claude/claude-read.ts'
import { commandTools }          from '../../domain/claude/claude-hooks.ts'
import { expandMcpVars }         from '../../domain/claude/claude-mcp.ts'
import { listMcpTools, type McpRaw } from '../../domain/local/local-mcp.ts'
import {
  checkRules, checkSettingsPatch, cliFailure, patchJson, patchPermissions, readOrNull, recordCli, saveFile, trashPath, undoable, undoWrite,
  WRITE_SELECT, type RuleList,
} from '../../domain/claude/claude-write.ts'
import { contextFor }              from '../../domain/claude/claude-context.ts'
import { fetchUsage }              from '../../domain/claude/claude-quota.ts'
import { readTranscript }          from '../../domain/claude/claude-transcript.ts'
import { claudeAuthStatus, readDoctor, readMcpList, runClaude } from '../../domain/local/local-claude.ts'
import { INSIGHT_WINDOWS, readInsights, readSessions, readStats, type InsightWindow } from '../../domain/claude/claude-spend.ts'

function offered() {
  const refused = localMachineRefusal()
  if (refused) throw new NotFound(`Claude Code is ${refused}`)
}

const body = (): Record<string, unknown> => ($.data ?? {}) as Record<string, unknown>
const db   = (): any => $.db

const scan = () => scanClaude({ pinPaths: $.app.workbench.readPins().map(p => p.path) })

// ─── the writes' guards ───────────────────────────────────────────────────────

// What reaches argv is a name, never a flag: `claude` parses a leading `-`.
const NAME   = /^\w[\w.-]{0,99}$/
const PLUGIN = /^\w[\w.-]{0,99}(@\w[\w.-]{0,99})?$/
const SCOPES = { plugin: ['user', 'project', 'local'], mcp: ['user', 'local', 'project'], settings: ['user', 'project', 'local'] }

function named(value: unknown, what: string, shape = NAME): string {
  if (typeof value !== 'string' || !shape.test(value)) throw new BadRequest(`${what} starts with a letter or digit, then letters, digits, dot, dash and underscore`)
  return value
}

/** The scope, and the project a project or local scope is run from — one the scan lists. */
function scoped(c: ClaudeConfig, kind: keyof typeof SCOPES, b: Record<string, unknown>): { scope: string, project: string | null } {
  const scope = String(b.scope ?? 'user')
  if (!SCOPES[kind].includes(scope)) throw new BadRequest(`scope is one of ${SCOPES[kind].join(', ')}`)
  if (scope === 'user') return { scope, project: null }
  const project = c.projects.find(p => p.path === b.project && p.exists)
  if (!project) throw new BadRequest(`a ${scope} scope names a project this tab lists`)
  return { scope, project: project.path }
}

function settingsPath(c: ClaudeConfig, scope: string, project: string | null): string {
  if (scope === 'user') return c.user.settings.path
  const p = c.projects.find(x => x.path === project)!
  return scope === 'project' ? p.settings.project.path : p.settings.local.path
}

/** Run the CLI and refuse with what it said; the screen shows the refusal as the reason. */
async function cli(args: string[], cwd: string | null, timeoutMs = 30_000) {
  const r = await runClaude(args, { cwd: cwd ?? undefined, timeoutMs })
  if (!r.ok) throw new Unprocessable(r.reason)
  if (r.value.code !== 0) throw new Unprocessable(cliFailure(r.value))
  return r.value
}

function refused<T>(r: { ok: true, value: T } | { ok: false, reason: string }, as: 'conflict' | 'unprocessable' = 'unprocessable'): T {
  if (r.ok) return r.value
  throw as === 'conflict' ? new Conflict(r.reason) : new Unprocessable(r.reason)
}

/** A user or local MCP server's config as Claude Code wrote it, for undo to add back. */
function mcpConfig(scope: string, project: string | null, name: string): string | null {
  const path = scope === 'project' ? join(project!, '.mcp.json') : claudeJsonPath()
  const json = readJsonObject(readOrNull(path) ?? '')
  if (!json.ok) return null
  const at: any = scope === 'local' ? (json.value.projects as any)?.[project!] : json.value
  const server = at?.mcpServers?.[name]
  return server && typeof server === 'object' ? JSON.stringify(server) : null
}

/** A marketplace's source as `claude plugin marketplace add` takes it back. */
function marketplaceSource(name: string): string | null {
  const json = readJsonObject(readOrNull(join(claudeConfigDir(), 'plugins', 'known_marketplaces.json')) ?? '')
  const src: any = json.ok ? (json.value[name] as any)?.source : null
  return src?.repo ?? src?.url ?? src?.path ?? null
}

const marketplaceNames = (): Set<string> => {
  const json = readJsonObject(readOrNull(join(claudeConfigDir(), 'plugins', 'known_marketplaces.json')) ?? '')
  return new Set(json.ok ? Object.keys(json.value) : [])
}

// ─── live and health ─────────────────────────────────────────────────────────

/** A checkout the scan lists and finds on disk, else home: where `claude` is run from. */
function cwdOf(c: ClaudeConfig, project: unknown): string {
  if (project === undefined || project === null || project === '') return c.home
  const p = c.projects.find(x => x.path === project && x.exists)
  if (!p) throw new BadRequest('project is a checkout this tab lists')
  return p.path
}

/**
 * A project's `.mcp.json` server runs only once someone approved it in Claude Code;
 * the checkout's own files are third-party text, and starting one unapproved runs
 * whatever it names. Approval is `~/.claude.json`'s list or a settings layer's.
 */
function approvedProjectServer(c: ClaudeConfig, project: string, name: string): boolean {
  const choice = c.mcp.result.ok ? c.mcp.result.value.projectChoices.find(x => x.project === project) : undefined
  if (choice?.disabled.includes(name)) return false
  if (choice?.enabled.includes(name)) return true
  const p = c.projects.find(x => x.path === project)
  for (const path of [p?.settings.local.path, p?.settings.project.path, c.user.settings.path]) {
    const json = readJsonObject(path ? readOrNull(path) ?? '' : '')
    if (!json.ok) continue
    const off = json.value.disabledMcpjsonServers
    if (Array.isArray(off) && off.includes(name)) return false
    const on = json.value.enabledMcpjsonServers
    if (json.value.enableAllProjectMcpServers === true || (Array.isArray(on) && on.includes(name))) return true
  }
  return false
}

/** A plugin's server config as its `.mcp.json` writes it; a manifest-inline one is read from `plugin.json`. */
function pluginServer(root: string, name: string): Record<string, unknown> | null {
  for (const file of [join(root, '.mcp.json'), join(root, '.claude-plugin', 'plugin.json')]) {
    const json = readJsonObject(readOrNull(file) ?? '')
    if (!json.ok) continue
    const map: any = json.value.mcpServers ?? (file.endsWith('.mcp.json') ? json.value : null)
    const server = map && typeof map === 'object' ? map[name] : null
    if (server && typeof server === 'object' && !Array.isArray(server)) return server
  }
  return null
}

/** A program a hook calls, found: a path checked as executable, a bare name looked up on PATH. */
function findTool(tool: string, vars: Record<string, string | undefined>): { found: string | null, unknown: string | null } {
  if (!tool.includes('/')) return { found: Bun.which(tool) ?? null, unknown: null }
  const path = expandMcpVars(tool.replace(/\$([A-Za-z_]\w*)/g, '${$1}'), vars).replace(/^~(?=\/)/, homedir())
  if (/\$\{/.test(path)) return { found: null, unknown: `${path.match(/\$\{(\w+)/)![1]} is set per session` }
  try { accessSync(path, constants.X_OK); return { found: path, unknown: null } }
  catch { return { found: null, unknown: null } }
}

/** A file the scan lists that the tab may write: a user or project item, or a memory file Claude Code would load. */
function writable(c: ClaudeConfig, path: string): { kind: 'item' | 'memory', project: string | null, folder: string | null } | null {
  const item = allItems(c).find(i => i.file === path && i.origin.scope !== 'plugin')
  if (item) return { kind: 'item', project: item.origin.project, folder: item.kind === 'skill' && basename(path) === 'SKILL.md' ? dirname(path) : null }
  if (c.user.memory.some(m => m.path === path && m.kind !== 'managed')) return { kind: 'memory', project: null, folder: null }
  const p = c.projects.find(x => x.memory.some(m => m.path === path && m.kind !== 'managed'))
  return p ? { kind: 'memory', project: p.path, folder: null } : null
}

export default createService({
  name: 'claude',
  reservedQuery: [...WORKSPACE_QUERY],

  methods: [
    { method: 'config', read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'file',   read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'stats',    read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'insights', read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'sessions', read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'transcript', read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'context',  read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'account',  read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'quota',    read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'writes',   read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'rev',       read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'mcpHealth', read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'mcpTools',  read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'hookTools', read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'doctor',    read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'undo',        gate: LEVELS.ADMINISTRATOR },
    { method: 'plugin',      gate: LEVELS.ADMINISTRATOR },
    { method: 'marketplace', gate: LEVELS.ADMINISTRATOR },
    { method: 'mcp',         gate: LEVELS.ADMINISTRATOR },
    { method: 'settings',    gate: LEVELS.ADMINISTRATOR },
    { method: 'permissions', gate: LEVELS.ADMINISTRATOR },
    { method: 'save',        gate: LEVELS.ADMINISTRATOR },
    { method: 'trash',       gate: LEVELS.ADMINISTRATOR },
  ],

  async config() {
    offered()
    const c = scan()
    return { ...c, rev: configRev(c) }
  },

  async rev() {
    offered()
    return { rev: configRev(scan()) }
  },

  async file() {
    offered()
    const path = String(($.data as { path?: unknown } | null)?.path ?? '')
    if (!path) throw new BadRequest('file needs a path')
    const r = readListedFile(scan(), path)
    if (!r.ok) throw new NotFound(`${path}: ${r.reason}`)
    return r.value
  },

  async stats() {
    offered()
    const days = body().days === undefined ? 30 : Number(body().days)
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw new BadRequest('days is a whole number of days, 0 for all of it')
    return readStats(db(), days)
  },

  async insights() {
    offered()
    const window = String(body().window ?? '7d')
    if (!(window in INSIGHT_WINDOWS)) throw new BadRequest(`window is one of ${Object.keys(INSIGHT_WINDOWS).join(', ')}`)
    return readInsights(db(), window as InsightWindow)
  },

  async sessions() {
    offered()
    const { cwd, limit } = body()
    if (cwd !== undefined && typeof cwd !== 'string') throw new BadRequest('cwd is a path')
    const n = limit === undefined ? undefined : Number(limit)
    if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 1000)) throw new BadRequest('limit is 1 to 1000')
    return readSessions(db(), { cwd, limit: n })
  },

  async transcript() {
    offered()
    const sessionId = body().sessionId
    if (typeof sessionId !== 'string' || !sessionId) throw new BadRequest('transcript needs a sessionId')
    const row = await db().claudeTranscript.findFirst({ where: { sessionId, subagent: false }, select: { path: true, gone: true } })
    if (!row) throw new NotFound(`${sessionId}: not a session the index lists`)
    if (row.gone) throw new NotFound(`${sessionId}: Claude Code has deleted this transcript; its spend is still counted`)
    const r = readTranscript(row.path)
    if (!r.ok) throw new NotFound(`${sessionId}: ${r.reason}`)
    return r.value
  },

  async context() {
    offered()
    const cwd = body().cwd
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new BadRequest('context needs a project path')
    return contextFor(cwd)
  },

  async account() {
    offered()
    return claudeAuthStatus()
  },

  async quota() {
    offered()
    return fetchUsage({ force: body().force === true })
  },

  // ─── live and health ────────────────────────────────────────────────────

  async mcpHealth() {
    offered()
    const cwd = cwdOf(scan(), body().project)
    // Every configured server is started to answer; a slow one holds the list.
    const r = await runClaude(['mcp', 'list'], { cwd, timeoutMs: 90_000 })
    if (!r.ok) return r
    if (r.value.code !== 0) return unreadable(cliFailure(r.value))
    const servers = readMcpList(r.value.out)
    return servers.ok ? read({ cwd, servers: servers.value, checkedAt: new Date().toISOString() }) : servers
  },

  async mcpTools() {
    offered()
    const b = body()
    const name = named(b.name, 'a server name')
    const c = scan()
    const scope = String(b.scope ?? '')
    const vars: Record<string, string | undefined> = { ...process.env }
    let raw: Record<string, unknown> | null = null
    let cwd = c.home
    if (scope === 'plugin') {
      const p = c.plugins.list.find(x => x.install.id === b.plugin)
      if (!p?.install.installPath || !p.rootExists) throw new BadRequest('plugin is an installed plugin this tab lists')
      raw = pluginServer(p.install.installPath, name)
      vars.CLAUDE_PLUGIN_ROOT = p.install.installPath
    } else {
      const { project } = scoped(c, 'mcp', b)
      if (scope === 'project' && !approvedProjectServer(c, project!, name))
        return unreadable(`${name} is not approved in Claude Code for this project; it is not started from here until it is`)
      raw = JSON.parse(mcpConfig(scope, project, name) ?? 'null')
      if (project) cwd = project
    }
    if (!raw) throw new NotFound(`${name} is not a ${scope} server this tab lists`)
    // Claude Code skips a server naming a variable it cannot fill; started here, it would run with the literal text.
    const cfg = expandMcpVars(raw, vars)
    const unset = [...new Set([...JSON.stringify(cfg).matchAll(/\$\{([A-Za-z_]\w*)\}/g)].map(m => m[1]))]
    if (unset.length) return unreadable(`Missing environment variables: ${unset.join(', ')}; Claude Code skips this server too`)
    return listMcpTools(cfg as McpRaw, { cwd })
  },

  async hookTools() {
    offered()
    const c = scan()
    const roots = new Map(c.plugins.list.map(p => [p.install.id, p.install.installPath ?? undefined]))
    const hooks = []
    for (const sh of allHooks(c)) {
      if (!sh.entries.ok) continue
      const vars = {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: sh.origin.plugin ? roots.get(sh.origin.plugin) : undefined,
        // A user hook runs in whichever project the session is in.
        CLAUDE_PROJECT_DIR: sh.origin.scope === 'user' ? undefined : sh.origin.project ?? undefined,
      }
      for (const e of sh.entries.value) for (const h of e.handlers) {
        if (!h.command) continue
        hooks.push({ file: sh.file, command: h.command, tools: commandTools(h.command).map(tool => ({ tool, ...findTool(tool, vars) })) })
      }
    }
    return { path: process.env.PATH ?? '', hooks }
  },

  async doctor() {
    offered()
    const cwd = cwdOf(scan(), body().project)
    const r = await runClaude(['doctor'], { cwd, timeoutMs: 60_000 })
    if (!r.ok) return r
    const parsed = readDoctor(r.value.out)
    if (!parsed.ok) return r.value.code !== 0 ? unreadable(cliFailure(r.value)) : parsed
    return read({ cwd, ...parsed.value })
  },

  // ─── writes ─────────────────────────────────────────────────────────────

  async writes() {
    offered()
    const n = body().limit === undefined ? 50 : Number(body().limit)
    if (!Number.isInteger(n) || n < 1 || n > 500) throw new BadRequest('limit is 1 to 500')
    const sys = db().asSystem().claudeWrite
    const rows = await sys.findMany({ orderBy: { createdAt: 'desc' }, limit: n, select: WRITE_SELECT })
    const disabled = await sys.findMany({ where: { action: 'mcp.disable', undoneAt: null }, orderBy: { createdAt: 'desc' }, select: WRITE_SELECT })
    return { rows: rows.map((r: any) => ({ ...r, undoable: undoable(r) })), disabled }
  },

  async undo() {
    offered()
    const id = body().id
    if (typeof id !== 'string' || !id) throw new BadRequest('undo needs the write id')
    return refused(await undoWrite(db(), id), 'conflict')
  },

  async plugin() {
    offered()
    const b = body()
    const action = String(b.action)
    if (!['enable', 'disable', 'install', 'update', 'uninstall'].includes(action)) throw new BadRequest('action is enable, disable, install, update or uninstall')
    const id = named(b.id, 'a plugin id', PLUGIN)
    const { scope, project } = scoped(scan(), 'plugin', b)
    const slow = action === 'install' || action === 'update'
    await cli(['plugin', action, id, '-s', scope, '--json'], project, slow ? 180_000 : 30_000)
    return recordCli(db(), { action: `plugin.${action}`, target: id, scope, project })
  },

  async marketplace() {
    offered()
    const b = body()
    const action = String(b.action)
    if (action === 'add') {
      const source = b.source
      if (typeof source !== 'string' || !source.trim() || source.startsWith('-') || /\s/.test(source.trim()) || source.length > 500)
        throw new BadRequest('source is owner/repo, a git URL or a local path')
      const had = marketplaceNames()
      await cli(['plugin', 'marketplace', 'add', source.trim()], null, 180_000)
      const added = [...marketplaceNames()].filter(n => !had.has(n))
      // Re-adding a known one changes nothing to undo, so it leaves no row to take back.
      if (added.length !== 1) return recordCli(db(), { action: 'marketplace.update', target: source.trim() })
      return recordCli(db(), { action: 'marketplace.add', target: added[0] })
    }
    if (action !== 'update' && action !== 'remove') throw new BadRequest('action is add, update or remove')
    const name = named(b.name, 'a marketplace name')
    const before = action === 'remove' ? marketplaceSource(name) : null
    await cli(['plugin', 'marketplace', action, name], null, 180_000)
    return recordCli(db(), { action: `marketplace.${action}`, target: name, before })
  },

  async mcp() {
    offered()
    const b = body()
    const action = String(b.action)
    const name = named(b.name, 'a server name')
    const c = scan()
    const { scope, project } = scoped(c, 'mcp', b)

    if (action === 'add') {
      const config = b.config
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new BadRequest('add needs the server config')
      const cfg = config as Record<string, unknown>
      if (typeof cfg.command !== 'string' && typeof cfg.url !== 'string') throw new BadRequest('a server is a command or a url')
      await cli(['mcp', 'add-json', name, JSON.stringify(cfg), '-s', scope], project)
      return recordCli(db(), { action: 'mcp.add', target: name, scope, project })
    }

    // A project's `.mcp.json` is checked in; it is turned off in the uncommitted local layer, as Claude Code does.
    if ((action === 'disable' || action === 'enable') && scope === 'project') {
      const path = settingsPath(c, 'local', project)
      const text = readOrNull(path)
      const cur = readJsonObject(text ?? '{}')
      const list = (k: string) => cur.ok && Array.isArray(cur.value[k]) ? (cur.value[k] as unknown[]).filter(x => x !== name) as string[] : []
      const on = action === 'enable'
      const enabled  = on ? [...list('enabledMcpjsonServers'), name] : list('enabledMcpjsonServers')
      const disabled = on ? list('disabledMcpjsonServers') : [...list('disabledMcpjsonServers'), name]
      const patched = refused(patchJson(text, {
        enabledMcpjsonServers:  enabled.length ? enabled : null,
        disabledMcpjsonServers: disabled.length ? disabled : null,
      }))
      return refused(await saveFile(db(), { action: 'settings', path, text: patched.text, keys: patched.keys, scope: 'local', project }))
    }

    if (action === 'enable') {
      const row = await db().asSystem().claudeWrite.findFirst({
        where: { action: 'mcp.disable', target: name, scope, project, undoneAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true },
      })
      if (!row) throw new NotFound(`${name} was not disabled here`)
      return refused(await undoWrite(db(), row.id), 'conflict')
    }

    if (action === 'remove' || action === 'disable') {
      const before = mcpConfig(scope, project, name)
      if (!before) throw new NotFound(`${name} is not a ${scope} server${project ? ` of ${project}` : ''}`)
      await cli(['mcp', 'remove', name, '-s', scope], project)
      return recordCli(db(), { action: `mcp.${action}`, target: name, scope, project, before })
    }

    if (action === 'logout') {
      await cli(['mcp', 'logout', name], project)
      return recordCli(db(), { action: 'mcp.logout', target: name, scope, project })
    }
    throw new BadRequest('action is add, remove, disable, enable or logout')
  },

  async settings() {
    offered()
    const b = body()
    const c = scan()
    const { scope, project } = scoped(c, 'settings', b)
    if (!b.patch || typeof b.patch !== 'object' || Array.isArray(b.patch)) throw new BadRequest('settings needs a patch')
    const patch = checkSettingsPatch(b.patch as Record<string, unknown>)
    if (!patch.ok) throw new BadRequest(patch.reason)
    const path = settingsPath(c, scope, project)
    const patched = refused(patchJson(readOrNull(path), patch.value))
    return refused(await saveFile(db(), { action: 'settings', path, text: patched.text, keys: patched.keys, scope, project }))
  },

  async permissions() {
    offered()
    const b = body()
    const c = scan()
    const { scope, project } = scoped(c, 'settings', b)
    const checks = checkRules({ allow: b.allow ?? [], ask: b.ask ?? [], deny: b.deny ?? [] })
    if (b.check === true) return { checks }
    const bad = checks.filter(x => x.error)
    if (bad.length) throw new BadRequest(bad.map(x => `${x.list} ${x.rule}: ${x.error}`).join('; '))
    const lists = Object.fromEntries((['allow', 'ask', 'deny'] as RuleList[]).map(l => [l, checks.filter(x => x.list === l).map(x => x.rule)])) as Record<RuleList, string[]>
    const path = settingsPath(c, scope, project)
    const patched = refused(patchPermissions(readOrNull(path), lists))
    const row = refused(await saveFile(db(), { action: 'permissions', path, text: patched.text, keys: patched.keys, scope, project }))
    return { ...row, checks }
  },

  async save() {
    offered()
    const { path, text } = body()
    if (typeof path !== 'string' || !path) throw new BadRequest('save needs a path')
    if (typeof text !== 'string') throw new BadRequest('save needs the text')
    const where = writable(scan(), path)
    if (!where) throw new NotFound(`${path}: not a file this tab writes`)
    return refused(await saveFile(db(), { action: 'file.save', path, text, keys: [], project: where.project }))
  },

  async trash() {
    offered()
    const path = body().path
    if (typeof path !== 'string' || !path) throw new BadRequest('trash needs a path')
    const where = writable(scan(), path)
    if (!where || where.kind !== 'item') throw new NotFound(`${path}: not a skill, agent or command this tab trashes`)
    return refused(await trashPath(db(), { path: where.folder ?? path, project: where.project }))
  },
})
