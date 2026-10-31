// src/domain/claude/claude-mcp.ts — the MCP servers Claude Code is configured with.
//
// Four places declare them, one shape each time: `~/.claude.json` at the top
// (user scope) and under `projects[<path>]` (local scope), a project's
// `.mcp.json` (project scope), and a plugin's `.mcp.json` or the `mcpServers`
// of its `plugin.json` (plugin scope).
//
// `~/.claude.json` is Claude Code's whole state file — OAuth account, caches,
// feature flags — and this file reads only `mcpServers` and the per-project
// `.mcp.json` approval lists from it. The rest is never copied onto a value.
//
// **Nothing returned carries a secret.** A server's `env` and `headers` hold
// tokens, so only their KEY names leave; an `oauth` block is reported as
// present. A URL loses its credentials and query string, and an argument that
// reads as a secret is replaced — `--api-key sk-…` is how a token reaches a
// stdio server that takes it from argv, and the screen draws args.

import { read, readJsonObject, unreadable, type Read } from './claude-read.ts'

export type McpScope     = 'user' | 'local' | 'project' | 'plugin'
export type McpTransport = 'stdio' | 'http' | 'sse'

export type McpServer = {
  name:       string
  scope:      McpScope
  /** The absolute path a local or project server belongs to. */
  project:    string | null
  /** The plugin id a plugin server comes from. */
  plugin:     string | null
  /** null when the entry names neither a command nor a url. */
  transport:  McpTransport | null
  command:    string | null
  args:       string[]
  /** Without credentials or query string. */
  url:        string | null
  envKeys:    string[]
  headerKeys: string[]
  /** An `oauth` block exists; its contents are not returned. */
  hasOauth:   boolean
  issues:     string[]
}

/** What a project said about the servers its `.mcp.json` declares. */
export type McpProjectChoice = {
  project:  string
  enabled:  string[]
  disabled: string[]
}

export type ClaudeJsonMcp = {
  user:           McpServer[]
  local:          McpServer[]
  projectChoices: McpProjectChoice[]
}

export type McpWhere = {
  scope:    McpScope
  project?: string | null
  plugin?:  string | null
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

// ─── redaction ────────────────────────────────────────────────────────────────

const SECRET_FLAG  = /(token|secret|password|passwd|api[-_]?key|apikey|auth|bearer|credential)/i
const SECRET_SHAPE = /^(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|glpat|AKIA)[-_A-Za-z0-9]{12,}$/

function safeArgs(args: string[]): string[] {
  const out: string[] = []
  let hide = false
  for (const arg of args) {
    if (hide) { out.push('[redacted]'); hide = false; continue }
    const eq = arg.indexOf('=')
    if (arg.startsWith('-') && eq > 0 && SECRET_FLAG.test(arg.slice(0, eq))) { out.push(`${arg.slice(0, eq)}=[redacted]`); continue }
    if (arg.startsWith('-') && eq < 0 && SECRET_FLAG.test(arg)) { out.push(arg); hide = true; continue }
    out.push(SECRET_SHAPE.test(arg) ? '[redacted]' : arg)
  }
  return out
}

function safeUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`
  } catch { return null }
}

// ─── one server ───────────────────────────────────────────────────────────────

function readServer(name: string, raw: unknown, where: McpWhere): McpServer {
  const server: McpServer = {
    name,
    scope:      where.scope,
    project:    where.project ?? null,
    plugin:     where.plugin ?? null,
    transport:  null,
    command:    null,
    args:       [],
    url:        null,
    envKeys:    [],
    headerKeys: [],
    hasOauth:   false,
    issues:     [],
  }
  if (!isObject(raw)) { server.issues.push('the entry is not an object'); return server }

  if (typeof raw.command === 'string' && raw.command) server.command = raw.command
  server.args       = safeArgs(strings(raw.args))
  server.envKeys    = isObject(raw.env) ? Object.keys(raw.env) : []
  server.headerKeys = isObject(raw.headers) ? Object.keys(raw.headers) : []
  server.hasOauth   = raw.oauth !== undefined && raw.oauth !== null

  if (typeof raw.url === 'string' && raw.url) {
    server.url = safeUrl(raw.url)
    if (server.url === null) server.issues.push('url does not parse')
  }

  const type = typeof raw.type === 'string' ? raw.type : null
  if (type === 'stdio' || type === 'http' || type === 'sse') server.transport = type
  else if (type !== null) server.issues.push(`unknown transport ${type}`)

  if (server.transport === null) {
    if (server.command)  server.transport = 'stdio'
    else if (server.url) server.transport = 'http'
  }
  if (!server.command && !server.url) server.issues.push('names neither a command nor a url')
  else if (server.transport === 'stdio' && !server.command) server.issues.push('stdio server has no command')
  else if (server.transport !== 'stdio' && server.transport !== null && !server.url) server.issues.push(`${server.transport} server has no url`)

  return server
}

/**
 * An `mcpServers` map, already parsed. A plugin's `plugin.json` may hold a path
 * string here instead; that is unreadable and the caller reads the file it names.
 */
export function readMcpServers(value: unknown, where: McpWhere): Read<McpServer[]> {
  if (typeof value === 'string') return unreadable(`mcpServers names a file: ${value}`)
  if (!isObject(value)) return unreadable('mcpServers is not an object')
  return read(Object.entries(value).map(([name, raw]) => readServer(name, raw, where)))
}

/**
 * A `.mcp.json`. A project's is `{ mcpServers: {…} }`; a plugin's may be the
 * same or the bare map of servers.
 *
 * @param origin the project's absolute path, or the plugin id
 */
export function parseMcpJson(text: string, scope: 'project' | 'plugin', origin: string): Read<McpServer[]> {
  const json = readJsonObject(text)
  if (!json.ok) return json
  const where: McpWhere = scope === 'project' ? { scope, project: origin } : { scope, plugin: origin }
  if (json.value.mcpServers !== undefined) return readMcpServers(json.value.mcpServers, where)
  if (scope === 'plugin') return readMcpServers(json.value, where)
  return unreadable('no mcpServers key')
}

/** `~/.claude.json`: user servers, every project's local servers, and each project's `.mcp.json` choices. */
export function parseClaudeJsonMcp(text: string): Read<ClaudeJsonMcp> {
  const json = readJsonObject(text)
  if (!json.ok) return json

  const out: ClaudeJsonMcp = { user: [], local: [], projectChoices: [] }

  if (json.value.mcpServers !== undefined) {
    const user = readMcpServers(json.value.mcpServers, { scope: 'user' })
    if (!user.ok) return unreadable(`user ${user.reason}`)
    out.user = user.value
  }

  const projects = json.value.projects
  if (projects !== undefined && !isObject(projects)) return unreadable('projects is not an object')
  for (const [path, entry] of Object.entries(projects ?? {})) {
    if (!isObject(entry)) continue
    if (isObject(entry.mcpServers) && Object.keys(entry.mcpServers).length > 0) {
      const local = readMcpServers(entry.mcpServers, { scope: 'local', project: path })
      if (local.ok) out.local.push(...local.value)
    }
    const enabled  = strings(entry.enabledMcpjsonServers)
    const disabled = strings(entry.disabledMcpjsonServers)
    if (enabled.length || disabled.length) out.projectChoices.push({ project: path, enabled, disabled })
  }
  return read(out)
}

// ─── a server's own config, expanded ──────────────────────────────────────────

/**
 * `${NAME}` and `${NAME:-default}` replaced through a server's command, args, env,
 * url and headers, as Claude Code expands a `.mcp.json` before starting it; a
 * plugin's also names `${CLAUDE_PLUGIN_ROOT}`. A name with no value and no
 * default is left as written, so the server fails the way Claude Code's would.
 */
export function expandMcpVars<T>(value: T, vars: Record<string, string | undefined>): T {
  const one = (s: string) => s.replace(/\$\{([A-Za-z_]\w*)(?::-([^}]*))?\}/g, (all, name: string, dflt?: string) => vars[name] ?? dflt ?? all)
  const walk = (v: unknown): unknown =>
    typeof v === 'string' ? one(v)
      : Array.isArray(v) ? v.map(walk)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
      : v
  return walk(value) as T
}
