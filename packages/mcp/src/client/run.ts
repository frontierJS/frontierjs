/*
 * src/client/run.ts — one command line, run against an app's `/mcp`.
 *
 * The command tree is `tools/list` at the caller's standing, read when the
 * program starts (`FJS-D396`), so a command the caller may not run is absent
 * rather than refused — and absent is said as *not offered at your standing, or
 * does not exist*, since the two cannot be told apart from here and *unknown
 * command* would be a claim this side cannot make.
 *
 * Four commands are the program's own and never reach the app: `login`,
 * `logout`, `profiles` and `use`. They win over a service of the same name.
 *
 * Global flags are read before the command, and after it only where the
 * command has no flag of that name: a model may have a column called
 * `workspace`, and its filter must not become the tenant switch.
 *
 * What a run connects with, first answer wins: the options the bin was given
 * (its environment), then the profile — `--profile`, else the current one.
 *
 * `--await` holds the call until the jobs it started are finished — the app
 * finds them by the call's correlation id and holds the call open
 * (`FJS-D406`); this side only asks, shows progress on stderr, and reports.
 *
 * A call answering one row is followed on stderr by its breadcrumbs — the moves
 * the row's state allows and the rows it points at, each as the command line
 * that runs it. The app computes them at the caller's standing (`FJS-D398`);
 * this side only spells them in its own argv, so stdout stays the data.
 *
 * Exit codes, so a script can branch without reading prose:
 *   0 ok · 1 the app refused or failed the call, or an awaited job failed or
 *   was still running when the wait gave up · 2 usage — an unknown command or
 *   flag, a value its type cannot hold, not signed in · 3 unreachable.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { commandFor, parseArgs, ArgvError, type Command, type ToolListing, type ParseOptions } from './argv.ts'
import { maskToken, type Profile, type ProfileFile, type ProfileStore } from './profiles.ts'
import { cacheKey, type ToolCache } from './cache.ts'
import { routeOffered, CallRefused, type Route } from './routes.ts'

export interface RunOptions extends ParseOptions {
  /** The app's MCP endpoint — `/mcp` under whatever prefix the app mounts. */
  url?:          string
  /** A Bearer credential: an API key (`FJS-D402`) or a session token. */
  token?:        string
  /** The header the app reads its tenant from, where it has one (`FJS-D399`). */
  tenantHeader?: string
  /** The tenant, unless `--workspace` or the profile names one. */
  tenant?:       string
  /** The endpoint `login` uses when none is given — the app's `cli/config/`. */
  defaultUrl?:   string
  /** The profile to use, unless `--profile` names one. */
  profile?:      string
  /** Where profiles live. Without one, `login` and its siblings are refused. */
  store?:        ProfileStore
  /** The command tree between runs of a deployed app. Without one, always live. */
  cache?:        ToolCache
  /** The app's hand-written commands (`cli/src/routes/`); each wins over a derived one of its name. */
  routes?:       Route[]
  /** One line per decision worth seeing — where the tree came from. */
  trace?:        (line: string) => void
  out:           (text: string) => void
  err:           (text: string) => void
  /** Injected by a test; the real one is `@modelcontextprotocol/client`. */
  connect?:      (url: URL, headers: Record<string, string>) => Promise<Session>
}

export interface Session {
  /** The build the app stated on its last response (`x-fjs-build`), or null. */
  build?(): string | null
  listTools(): Promise<ToolListing[]>
  callTool(name: string, args: Record<string, unknown>, opts?: CallOptions): Promise<CallAnswer>
  close(): Promise<void>
}

export interface CallOptions {
  /** Hold the call until the jobs it started are terminal (`FJS-D406`). */
  await?:      boolean
  onProgress?: (message: string) => void
}

export interface AwaitedJob { id: string; name: string; status: string; attempts: number; error: string | null }

/** One next step the app offered after a one-row answer — `_meta['frontierjs/breadcrumbs']`. */
export type Breadcrumb =
  | { kind: 'move';      tool: string; args: { id: unknown }; move: string; field: string; to: string }
  | { kind: 'belongsTo'; tool: string; args: { id: unknown }; relation: string }
  | { kind: 'hasMany';   tool: string; args: { query: Record<string, unknown> }; relation: string }

export interface CallAnswer {
  isError?: boolean
  text:     string
  /** Present when the call was awaited: where each job it started ended up. */
  jobs?:    AwaitedJob[]
  settled?: boolean
  /** Present when the call answered one row of a model. */
  breadcrumbs?: Breadcrumb[]
}

export const EXIT = { ok: 0, refused: 1, usage: 2, unreachable: 3 } as const

// The client's own timeout, past the server's longest hold, so the SERVER is
// the one that gives up and answers with where each job got to.
const AWAIT_TIMEOUT_MS = 11 * 60_000

const GLOBALS = new Set(['json', 'quiet', 'workspace', 'help', 'agent', 'profile', 'await'])
const LOCAL   = new Set(['login', 'logout', 'profiles', 'use'])
const DEFAULT_PROFILE = 'default'

interface Globals { json: boolean; quiet: boolean; help: boolean; agent: boolean; await: boolean; workspace?: string; profile?: string }

// ─── the run ─────────────────────────────────────────────────────────────────

export async function run(argv: string[], opts: RunOptions): Promise<number> {
  const g: Globals = { json: false, quiet: false, help: false, agent: false, await: false }

  // Globals before the command are always globals.
  let i = 0
  for (; i < argv.length && argv[i].startsWith('--'); i++) {
    const r = takeGlobal(argv, i, g)
    if (r < 0) { opts.err(`unknown option ${argv[i]} before the command`); return EXIT.usage }
    i = r
  }
  const words = argv.slice(i)

  let file: ProfileFile
  try { file = opts.store?.read() ?? { profiles: {} } }
  catch (e) { opts.err((e as Error).message); return EXIT.usage }
  const profileName = g.profile ?? opts.profile ?? file.current ?? DEFAULT_PROFILE
  const profile     = file.profiles[profileName] as Profile | undefined

  if (LOCAL.has(words[0])) return local(words, g, profileName, file, opts)

  const url = opts.url ?? profile?.url
  if (!url) {
    opts.err(g.profile || opts.profile
      ? `no profile named '${profileName}' — run: login --api-key - --url <the app's /mcp> --profile ${profileName}`
      : 'not signed in — run: login --api-key - --url <the app\'s /mcp>')
    return EXIT.usage
  }

  const headers: Record<string, string> = {}
  const token = opts.token ?? profile?.token
  if (token) headers.authorization = `Bearer ${token}`

  const tenant = g.workspace ?? lateWorkspace(words) ?? opts.tenant ?? profile?.tenant
  let session: Session
  try {
    session = await (opts.connect ?? connectMcp)(new URL(url), withTenant(opts, tenant, headers))
  } catch (e) {
    if (e instanceof ArgvError) { opts.err(e.message); return EXIT.usage }
    opts.err(`could not reach ${url}: ${(e as Error).message}`)
    return EXIT.unreachable
  }

  try {
    const key = cacheKey(url, token, tenant)
    let { tools, cached } = await treeFor(session, opts, key)
    const [service, method, ...tail] = words
    const routes = opts.routes ?? []
    const find = () => {
      // A route wins over the derived command of its name, and is offered only
      // while every tool it uses is in this caller's list.
      const own     = routes.filter(r => routeOffered(r, tools))
      const byName  = new Map(own.map(r => [`${r.service} ${r.method}`, r]))
      const derived = tools.map(commandFor).filter(c => !byName.has(`${c.service} ${c.method}`))
      const all     = [...derived, ...own.map(routeCommand)]
      const of      = all.filter(c => c.service === service)
      const cmd     = of.find(c => c.method === method)
      return { commands: all, ofService: of, cmd, route: cmd ? byName.get(`${cmd.service} ${cmd.method}`) : undefined }
    }
    let { commands, ofService, cmd, route } = find()

    // A cached tree answers for the build, not for a standing that moved since:
    // before anything is called *not offered*, the live list is asked.
    if (cached && service && (!ofService.length || (method && !method.startsWith('--') && !cmd))) {
      tools = await live(session, opts, key)
      ;({ commands, ofService, cmd, route } = find())
    }

    if (!service) { opts.out(helpAll(commands)); return g.help ? EXIT.ok : EXIT.usage }

    if (!method || method.startsWith('--')) {
      if (!ofService.length) { opts.err(notOffered(service)); return EXIT.usage }
      opts.out(helpService(service, ofService))
      return g.help || method === '--help' ? EXIT.ok : EXIT.usage
    }

    if (!cmd) { opts.err(notOffered(`${service} ${method}`)); return EXIT.usage }

    // The tenant went out on the connection, before the command was known. A
    // command with a `workspace` column of its own makes the late flag mean two
    // things, and the header has already been sent under one of them.
    if (lateWorkspace(words) !== undefined && cmd.flags.some(f => f.name === 'workspace')) {
      opts.err(`${service} ${method} has a --workspace of its own; put the tenant before the command: --workspace <id> ${service} ${method} …`)
      return EXIT.usage
    }

    // After the command, a global is one only where the command has no flag of
    // that name.
    const own  = new Set([...cmd.flags.map(f => f.name), ...(cmd.whole ? [cmd.whole.name] : []), ...(cmd.id ? ['id'] : [])])
    const rest: string[] = []
    for (let j = 0; j < tail.length; j++) {
      const name = tail[j].startsWith('--') ? tail[j].slice(2).split('=')[0] : ''
      if (name && GLOBALS.has(name) && !own.has(name)) { j = takeGlobal(tail, j, g); continue }
      rest.push(tail[j])
    }

    if (g.help) {
      const schema = route ? route.input ?? null : tools.find(t => t.name === cmd!.tool)?.inputSchema ?? null
      opts.out(g.agent ? JSON.stringify(schema, null, 2) : helpCommand(cmd))
      return EXIT.ok
    }

    let args: Record<string, unknown>
    try { args = parseArgs(cmd, rest, opts) }
    catch (e) {
      if (e instanceof ArgvError) { opts.err(e.message); return EXIT.usage }
      throw e
    }

    if (route) return await runRoute(route, args, session, g, opts)

    const result = await session.callTool(cmd.tool, args,
      g.await ? { await: true, onProgress: m => opts.err(`· ${m}`) } : undefined)
    return print(result, g, opts, commands)
  } catch (e) {
    opts.err(`${(e as Error).message}`)
    return EXIT.refused
  } finally {
    await session.close().catch(() => {})
  }
}

/** A route as a command: its `input` read by the same parser as a tool's. */
function routeCommand(r: Route): Command {
  const tool = `${r.service}_${r.method}`
  if (!r.input) return { tool, service: r.service, method: r.method, description: r.description, id: null, flags: [], whole: null, payload: 'none' }
  return { ...commandFor({ name: tool, description: r.description, inputSchema: r.input }), service: r.service, method: r.method }
}

async function runRoute(route: Route, args: Record<string, unknown>, session: Session, g: Globals, opts: RunOptions): Promise<number> {
  const call = async (tool: string, a: Record<string, unknown> = {}) => {
    // Undeclared is refused rather than allowed: `uses` is what the offer and
    // `checkRoutes` both read, so a call outside it is one neither can see.
    if (!route.uses.includes(tool))
      throw new Error(`${route.file}: calls ${tool}, which is not in its uses — add it there`)
    const r = await session.callTool(tool, a)
    if (r.isError) throw new CallRefused(tool, r.text)
    try { return JSON.parse(r.text) } catch { return r.text }
  }
  try {
    return (await route.run({ args, call, out: opts.out, err: opts.err, json: g.json })) ?? EXIT.ok
  } catch (e) {
    if (e instanceof CallRefused) {
      if (g.json) opts.out(JSON.stringify({ ok: false, error: { message: e.message, tool: e.tool } }))
      else        opts.err(e.message)
      return EXIT.refused
    }
    throw e
  }
}

/** The command tree: the cache when the app's build matches it, else live. */
async function treeFor(session: Session, opts: RunOptions, key: string): Promise<{ tools: ToolListing[]; cached: boolean }> {
  const build = session.build?.() ?? null
  const hit   = build && opts.cache ? opts.cache.get(key) : null
  if (hit && hit.build === build) {
    opts.trace?.(`tools: cache, build ${build}`)
    return { tools: hit.tools, cached: true }
  }
  return { tools: await live(session, opts, key), cached: false }
}

async function live(session: Session, opts: RunOptions, key: string): Promise<ToolListing[]> {
  const tools = await session.listTools()
  const build = session.build?.() ?? null
  if (build && opts.cache) opts.cache.set(key, { build, tools })
  opts.trace?.(`tools: live, build ${build ?? '(none — not cached)'}`)
  return tools
}

/** Reads one global at `i`; answers the index it consumed up to, or -1. */
function takeGlobal(argv: string[], i: number, g: Globals): number {
  const [name, inline] = argv[i].slice(2).split(/=(.*)/s)
  switch (name) {
    case 'json':  g.json  = true; return i
    case 'quiet': g.quiet = true; return i
    case 'help':  g.help  = true; return i
    case 'agent': g.agent = true; return i
    case 'await': g.await = true; return i
    case 'workspace':
    case 'profile':
      if (inline !== undefined) { g[name] = inline; return i }
      g[name] = argv[i + 1]
      return i + 1
    default: return -1
  }
}

/**
 * The tenant travels on every call, including `tools/list` — the list itself is
 * graded at the role the tenant's membership row gives (`FJS-D399`).
 */
function withTenant(opts: RunOptions, tenant: string | undefined, base: Record<string, string>): Record<string, string> {
  if (tenant === undefined) return base
  if (!opts.tenantHeader)
    throw new ArgvError('--workspace needs the header this app reads its tenant from, and none is configured', 'workspace')
  return { ...base, [opts.tenantHeader]: tenant }
}

/** A `--workspace` written after the command, which is read before the command is known. */
function lateWorkspace(words: string[]): string | undefined {
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '--workspace') return words[i + 1]
    if (words[i].startsWith('--workspace=')) return words[i].slice('--workspace='.length)
  }
  return undefined
}

async function connectMcp(url: URL, headers: Record<string, string>): Promise<Session> {
  // The build rides every response, `initialize` included, so it is known before
  // the tree would be asked for — read off the transport's own fetch.
  let build: string | null = null
  const fetchNoting = async (input: string | URL | Request, init?: RequestInit) => {
    const res = await fetch(input, init)
    build = res.headers.get('x-fjs-build') ?? build
    return res
  }
  const client = new Client({ name: 'frontierjs-cli', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: fetchNoting }))
  return {
    build: () => build,
    listTools: async () => (await client.listTools()).tools as ToolListing[],
    callTool:  async (name, args, o) => {
      const r = await client.callTool(
        { name, arguments: args, ...(o?.await ? { _meta: { 'frontierjs/await': true } } : {}) },
        o?.await ? {
          timeout: AWAIT_TIMEOUT_MS, resetTimeoutOnProgress: true,
          onprogress: (p: { message?: string }) => { if (p.message) o.onProgress?.(p.message) },
        } : undefined,
      ) as { isError?: boolean; content?: Array<{ text?: string }>; _meta?: Record<string, unknown> }
      const crumbs = r._meta?.['frontierjs/breadcrumbs']
      return {
        isError: r.isError,
        text:    r.content?.[0]?.text ?? '',
        ...(Array.isArray(crumbs) ? { breadcrumbs: crumbs as Breadcrumb[] } : {}),
        ...(o?.await ? { jobs: (r._meta?.['frontierjs/jobs'] ?? []) as AwaitedJob[], settled: r._meta?.['frontierjs/settled'] !== false } : {}),
      }
    },
    close: () => client.close(),
  }
}

// ─── the program's own commands ──────────────────────────────────────────────

/** `--name value` / `--name=value` pairs, for the four commands that are not tools. */
function ownFlags(words: string[], known: string[]): Record<string, string> | string {
  const out: Record<string, string> = {}
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (!w.startsWith('--')) return `unexpected argument '${w}'`
    const [name, inline] = w.slice(2).split(/=(.*)/s)
    if (!known.includes(name)) return `unknown flag --${name}. It takes: ${known.map(k => `--${k}`).join(' ')}`
    const v = inline ?? words[++i]
    if (v === undefined) return `--${name} needs a value`
    out[name] = v
  }
  return out
}

async function local(words: string[], g: Globals, name: string, file: ProfileFile, opts: RunOptions): Promise<number> {
  const store = opts.store
  if (!store) { opts.err(`${words[0]} needs somewhere to keep profiles, and none is configured`); return EXIT.usage }
  const save = (f: ProfileFile) => store.write(f)

  switch (words[0]) {
    case 'login': {
      const f = ownFlags(words.slice(1), ['api-key', 'url'])
      if (typeof f === 'string') { opts.err(`login: ${f}`); return EXIT.usage }
      const url = f.url ?? opts.url ?? file.profiles[name]?.url ?? opts.defaultUrl
      if (!url) { opts.err('login needs --url <the app\'s /mcp>'); return EXIT.usage }
      if (!f['api-key']) { opts.err('login needs --api-key <key>, or --api-key - to read it from stdin'); return EXIT.usage }
      const key = f['api-key'] === '-' ? (opts.readStdin?.() ?? '').trim() : f['api-key']
      if (!key) { opts.err('login: the key is empty'); return EXIT.usage }
      const tenant = g.workspace ?? file.profiles[name]?.tenant

      // A Bearer the app cannot verify is read as NOBODY rather than refused, so
      // a mistyped key would sign in and answer a stranger's list forever. The
      // honest check is the comparison: with the key, and with nothing.
      let withKey: ToolListing[], without: ToolListing[]
      try {
        const base = withTenant(opts, tenant, {})
        withKey = await listOnce(opts, url, { ...base, authorization: `Bearer ${key}` })
        without = await listOnce(opts, url, base)
      } catch (e) {
        if (e instanceof ArgvError) { opts.err(e.message); return EXIT.usage }
        opts.err(`could not reach ${url}: ${(e as Error).message}`)
        return EXIT.unreachable
      }
      const names = (ts: ToolListing[]) => ts.map(t => t.name).sort().join()
      if (names(withKey) === names(without)) {
        opts.err('the app read this key as nobody — it is mistyped, revoked or expired. Nothing was saved.')
        return EXIT.refused
      }

      save({ current: file.current ?? name, profiles: { ...file.profiles, [name]: { url, token: key, ...(tenant ? { tenant } : {}) } } })
      opts.out(`signed in as profile '${name}' — ${withKey.length} commands at this key's standing. Saved to ${store.where}`)
      return EXIT.ok
    }

    case 'logout': {
      if (!file.profiles[name]) { opts.err(`no profile named '${name}'`); return EXIT.usage }
      const { [name]: _gone, ...profiles } = file.profiles
      save({ ...(file.current === name ? {} : { current: file.current }), profiles })
      opts.out(`signed out of '${name}'. The key itself is still valid until it is revoked in the app.`)
      return EXIT.ok
    }

    case 'profiles': {
      const rows = Object.entries(file.profiles)
      if (!rows.length) { opts.out('no profiles — run: login --api-key - --url <the app\'s /mcp>'); return EXIT.ok }
      if (g.json) {
        opts.out(JSON.stringify({ ok: true, data: rows.map(([n, p]) => ({ name: n, current: n === file.current, url: p.url, tenant: p.tenant ?? null, key: maskToken(p.token) })) }))
        return EXIT.ok
      }
      opts.out(rows.map(([n, p]) => `${n === file.current ? '*' : ' '} ${n.padEnd(12)} ${p.url}  ${p.tenant ? `tenant ${p.tenant}  ` : ''}key ${maskToken(p.token)}`).join('\n'))
      return EXIT.ok
    }

    case 'use': {
      const [, tenant, ...extra] = words
      if (!tenant || extra.length) { opts.err('use <tenant> — the tenant this profile acts in from now on'); return EXIT.usage }
      const p = file.profiles[name]
      if (!p) { opts.err(`no profile named '${name}' — sign in first`); return EXIT.usage }
      if (!opts.tenantHeader) { opts.err('this app names no tenant header, so there is no tenant to use'); return EXIT.usage }
      save({ ...file, profiles: { ...file.profiles, [name]: { ...p, tenant } } })
      opts.out(`profile '${name}' now acts in ${tenant}`)
      return EXIT.ok
    }
  }
  return EXIT.usage
}

async function listOnce(opts: RunOptions, url: string, headers: Record<string, string>): Promise<ToolListing[]> {
  const s = await (opts.connect ?? connectMcp)(new URL(url), headers)
  try { return await s.listTools() } finally { await s.close().catch(() => {}) }
}

// ─── output ──────────────────────────────────────────────────────────────────

function print(result: CallAnswer, g: { json: boolean; quiet: boolean }, opts: RunOptions, commands: Command[] = []): number {
  let data: unknown = result.text
  try { data = JSON.parse(result.text) } catch { /* a refusal is prose */ }

  if (result.isError) {
    if (g.json) opts.out(JSON.stringify({ ok: false, error: { message: result.text } }))
    else        opts.err(result.text)
    return EXIT.refused
  }

  // An awaited call succeeded when the method did AND every job it started
  // finished `done` — a provision whose job failed is not a provisioned server.
  const jobs     = result.jobs
  const jobsOk   = !jobs || (result.settled !== false && jobs.every(j => j.status === 'done'))

  const crumbs = result.breadcrumbs
  if (g.json)       opts.out(JSON.stringify({ ok: jobsOk, data, ...(crumbs ? { breadcrumbs: crumbs } : {}), ...(jobs ? { jobs, settled: result.settled !== false } : {}) }))
  else if (g.quiet) opts.out(JSON.stringify(rowsOf(data) ?? data))
  else              opts.out(human(data))

  if (crumbs && !g.json && !g.quiet) {
    for (const b of crumbs) {
      const line = commandLine(b, commands.find(c => c.tool === b.tool))
      if (line) opts.err(`· ${line}  — ${b.kind === 'move' ? `${b.move}: ${b.field} → ${b.to}` : b.kind === 'belongsTo' ? `the ${b.relation} this points at` : `its ${b.relation}`}`)
    }
  }

  if (jobs && !g.json) {
    if (!jobs.length) opts.err('· this call started no job to wait on')
    for (const j of jobs) opts.err(`· ${j.name} ${j.status}${j.error ? ` — ${j.error}` : ''}`)
    if (result.settled === false) opts.err('· stopped waiting before every job finished')
  }
  return jobsOk ? EXIT.ok : EXIT.refused
}

/**
 * A breadcrumb as the command line that runs it, in this program's own argv —
 * the id positional, a filter as its flag, and `--query` for a column that has
 * none. `null` when no command carries the tool, which a list read at the same
 * standing as the breadcrumbs should never be.
 */
function commandLine(b: Breadcrumb, cmd: Command | undefined): string | null {
  if (!cmd) return null
  const words = [cmd.service, cmd.method]
  if ('id' in b.args) words.push(shellWord(b.args.id))
  if ('query' in b.args) {
    const rest: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(b.args.query)) {
      if (cmd.flags.some(f => f.slot === 'query' && f.name === k)) words.push(`--${k}`, shellWord(v))
      else rest[k] = v
    }
    if (Object.keys(rest).length) words.push('--query', shellWord(JSON.stringify(rest)))
  }
  return words.join(' ')
}

const shellWord = (v: unknown) => {
  const s = String(v)
  return /^[\w.:@/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** A `find` answers the list envelope; its rows are `.data`. */
function rowsOf(data: unknown): unknown[] | null {
  const d = data as { kind?: string; data?: unknown }
  return d && d.kind === 'list' && Array.isArray(d.data) ? d.data : null
}

const SCALAR = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v)

function human(data: unknown): string {
  const rows = rowsOf(data)
  if (rows) {
    if (!rows.length) return '(no rows)'
    const cols = Object.keys(rows[0] as object).filter(k => SCALAR((rows[0] as Record<string, unknown>)[k])).slice(0, 6)
    const cell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return s.length > 36 ? s.slice(0, 35) + '…' : s }
    const width = cols.map(c => Math.max(c.length, ...rows.map(r => cell((r as Record<string, unknown>)[c]).length)))
    const line = (vals: string[]) => vals.map((v, k) => v.padEnd(width[k])).join('  ').trimEnd()
    return [line(cols), ...rows.map(r => line(cols.map(c => cell((r as Record<string, unknown>)[c]))))].join('\n')
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const entries = Object.entries(data).filter(([, v]) => SCALAR(v))
    const w = Math.max(...entries.map(([k]) => k.length))
    return entries.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join('\n')
  }
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2)
}

// ─── help ────────────────────────────────────────────────────────────────────

const notOffered = (what: string) =>
  `'${what}' is not offered at your standing, or does not exist. Run with --help for what is.`

function helpAll(commands: Command[]): string {
  const services = [...new Set(commands.map(c => c.service))].sort()
  const shadowed = services.filter(s => LOCAL.has(s))
  return ['Commands at your standing — <service> <method>:', '',
    ...services.map(s => `  ${s.padEnd(28)} ${commands.filter(c => c.service === s).map(c => c.method).join(' ')}`),
    '', 'This program\'s own: login --api-key <key|-> --url <mcp> · logout · profiles · use <tenant>',
    ...(shadowed.length ? [`(${shadowed.join(', ')} ${shadowed.length === 1 ? 'is a service' : 'are services'} this program's own command hides)`] : []),
  ].join('\n')
}

function helpService(service: string, commands: Command[]): string {
  return [`${service} — at your standing:`, '',
    ...commands.map(c => `  ${service} ${c.method}${c.id ? (c.id.required ? ' <id>' : ' [id]') : ''}`.padEnd(44) + ` ${c.description}`)].join('\n')
}

function helpCommand(cmd: Command): string {
  const usage = `${cmd.service} ${cmd.method}${cmd.id ? (cmd.id.required ? ' <id>' : ' [id]') : ''}`
  const lines = [usage, '', cmd.description, '']
  for (const f of cmd.flags) {
    const t = f.enum ? f.enum.join('|') : f.type
    lines.push(`  --${f.name} <${t}>${f.required ? ' (required)' : ''}${f.filter ? '  [op] too' : ''}`)
  }
  if (cmd.whole) lines.push(`  --${cmd.whole.name} <json|@file|->  the whole ${cmd.whole.name === 'query' ? 'filter' : 'payload'}; flags win over it`)
  if (cmd.payload === 'undescribed') lines.push('', 'The seed does not describe this payload; --data is the way in.')
  return lines.join('\n')
}
