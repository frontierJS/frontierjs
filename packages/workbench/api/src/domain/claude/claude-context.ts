// src/domain/claude/claude-context.ts — what a Claude Code session carries before the first word is typed.
//
// A transcript written by Claude Code records the first request twice over:
// an `api-request-shape` line holds the system blocks and tool list exactly as
// sent, `attachment` lines hold the always-on message content (CLAUDE.md
// memory, the skill and agent listings, MCP instructions, the deferred-tool
// name list), and the first assistant line's `usage` holds what that request
// really cost. This reads those, so the figure is the session's own and not a
// re-estimate of the configuration.
//
// **The parts are counted by the API when it answers** (`FJS-D1734`):
// `countContext` sends each part's text to `count_tokens`, and the counts sum
// to the measured total within about 1%. Characters per token run 2.3 to 3.5
// by kind and by content, so a character-share split was off by up to 31% on
// tool schemas. When a count is refused the parts stay that split, `basis:
// 'estimated'` with the reason, never shown as counted.
//
// **Not the same number as `/context`.** `/context` counts the schemas of
// DEFERRED tools (loaded on demand through ToolSearch) as their own lines; the
// first request carries only their names, so those schemas are not in
// `measuredTotal` and not in `parts`. Its *System tools* line runs about 4k
// under a count of the same schemas and its *Messages* is the remainder, so
// the two agree on system prompt, memory files and skills, not on tools. The
// agent listing here holds the built-in agents its *Custom agents* leaves out.
// The measured total also includes the first prompt the user typed, which is
// its own part and left out of `alwaysOn`.
//
// **Older transcripts have no shape line** and are unreadable here, said so
// rather than estimated. The window is reported only when the transcript names
// it (a `[1m]` model id or a 1M context beta); a model's default window is not
// in the file, so otherwise it is `null`, never a guess.
//
// `readContext` is pure. The fs half reads a bounded head of a transcript —
// the shape and first turns sit at the top and a transcript reaches hundreds
// of MB.

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { countTokens, type CountBody } from './claude-quota.ts'
import { read, unreadable, type Read } from './claude-read.ts'
import { claudeConfigDir } from './claude-scan.ts'

export type ContextPart = { name: string, chars: number, tokens: number }

/** What a part was sent as — what a count is asked about. */
type Sent = { system: string } | { tools: Record<string, unknown>[] } | { text: string }

export type Context = {
  /** Whether `parts[].tokens` came from `count_tokens` or from character share. */
  basis:         'counted' | 'estimated'
  /** Why the parts are estimated; null when counted. */
  estimatedWhy:  string | null
  /** input + cache creation + cache read of the first request, as the API counted them. */
  measuredTotal: number
  /** measuredTotal less the first prompt: what every session of this setup starts with. */
  alwaysOn:      number
  parts:         ContextPart[]
  model:         string | null
  version:       string | null
  /** When the first request was made. */
  at:            string | null
  /** 1,000,000 when the transcript says so, else null. */
  window:        number | null
}

/** A Context as read, before it is counted: what each part was sent as rides beside it, never to the page. */
export type Measured = Context & { sent: Map<string, Sent> }

export type ContextFor = Context & { file: string, sessionId: string }

const HEAD_BYTES = 2 * 1024 * 1024

// ─── the pure half ────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The text of a rendered attachment: the `content` strings it was sent as. */
function renderedText(rendered: unknown): string {
  if (!Array.isArray(rendered)) return ''
  let s = ''
  for (const r of rendered) {
    const c = isObj(r) ? r.content : null
    if (typeof c === 'string') s += c
    else if (Array.isArray(c)) for (const b of c) if (isObj(b) && typeof b.text === 'string') s += b.text
  }
  return s
}

/** Which part an attachment type fills. A type not named here (hook output, IDE selection) is not always-on. */
const ATTACHMENT_PART: Record<string, string> = {
  instructions:          'Memory files',
  skill_listing:         'Skills',
  agent_listing_delta:   'Agent listing',
  deferred_tools_delta:  'Deferred tool list',
  mcp_instructions_delta:'MCP server instructions',
  environment:           'Other',
  model:                 'Other',
  auto_mode:             'Other',
  session_context:       'Other',
  date:                  'Other',
  remote_session_change: 'Other',
}

const PART_ORDER = [
  'System prompt', 'System tools', 'MCP tools', 'MCP server instructions', 'Agent listing',
  'Memory files', 'Skills', 'Deferred tool list', 'Other', 'First prompt',
]

const mcpServer = (tool: string): string => tool.split('__')[1] || 'unknown'

/** The text of the first human prompt: a string, or the `text` blocks of an array. */
function promptText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let s = ''
  for (const b of content) if (isObj(b) && b.type === 'text' && typeof b.text === 'string') s += b.text
  return s
}

/**
 * The context from the head of one transcript, its parts split by character
 * share until `countContext` counts them. A last line cut off by the head's
 * end fails to parse and is skipped.
 */
export function readContext(text: string): Read<Measured> {
  const chars = new Map<string, number>()
  const sent = new Map<string, Sent>()
  const add = (name: string, n: number) => { if (n > 0) chars.set(name, (chars.get(name) ?? 0) + n) }
  const addText = (name: string, s: string) => {
    if (!s) return
    add(name, s.length)
    const had = sent.get(name)
    sent.set(name, { text: (had && 'text' in had ? had.text : '') + s })
  }

  let shape: Record<string, any> | null = null
  let request: Record<string, any> | null = null
  let usage: Record<string, any> | null = null
  let requestedModel: string | null = null
  let assistantModel: string | null = null
  let sawPrompt = false

  for (const line of text.split('\n')) {
    if (!line) continue
    let o: any
    try { o = JSON.parse(line) } catch { continue }
    if (!isObj(o) || o.isSidechain === true) continue

    if (o.type === 'api-request-shape' && !shape) shape = o
    else if (o.type === 'api-request' && !request) request = o
    else if (o.type === 'user' && !sawPrompt && o.isMeta !== true && isObj(o.message)) {
      const c = o.message.content
      // A tool result is not a prompt; the first typed prompt is.
      if (typeof c === 'string' || (Array.isArray(c) && !c.some(b => isObj(b) && b.type === 'tool_result'))) {
        sawPrompt = true
        addText('First prompt', promptText(c))
      }
    }
    else if (o.type === 'attachment' && isObj(o.attachment)) {
      const part = ATTACHMENT_PART[o.attachment.type]
      if (part) addText(part, renderedText(o.rendered))
    }
    else if (o.type === 'assistant' && isObj(o.message)) {
      usage = isObj(o.message.usage) ? o.message.usage : null
      assistantModel = typeof o.message.model === 'string' ? o.message.model : null
      requestedModel = typeof o.requestedModel === 'string' ? o.requestedModel : null
      break
    }
  }

  if (!shape || !isObj(shape.shape)) return unreadable('this transcript predates the request shape')
  if (!usage) return unreadable('no first assistant reply in the part of the transcript read')
  const total = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
    .reduce((n, k) => n + (typeof usage![k] === 'number' ? usage![k] : 0), 0)
  if (total <= 0) return unreadable('the first reply recorded no input tokens')

  let system = ''
  for (const b of Array.isArray(shape.shape.system) ? shape.shape.system : []) {
    if (isObj(b) && typeof b.text === 'string') system += b.text
  }
  if (system) { add('System prompt', system.length); sent.set('System prompt', { system }) }
  // Per server, so a screen can name the one server eating the budget.
  const tools = new Map<string, Record<string, unknown>[]>()
  for (const t of Array.isArray(shape.shape.tools) ? shape.shape.tools : []) {
    // The shape lists the deferred tools a session has loaded, which are charged,
    // and a placeholder that only keeps deferral on, which is not. `count_tokens`
    // refuses `defer_loading` without the tool-search beta, so it is dropped.
    if (!isObj(t) || t.name === 'DeferredToolPlaceholder') continue
    const { defer_loading: _, ...schema } = t
    const name = typeof t.name === 'string' ? t.name : ''
    const part = name.startsWith('mcp__') ? `MCP tools: ${mcpServer(name)}` : 'System tools'
    add(part, JSON.stringify(schema).length)
    tools.set(part, [...(tools.get(part) ?? []), schema])
  }
  for (const [part, list] of tools) sent.set(part, { tools: list })

  const sum = [...chars.values()].reduce((a, b) => a + b, 0)
  if (sum <= 0) return unreadable('the request shape holds no content')
  const rank = (name: string) => {
    const i = PART_ORDER.indexOf(name.startsWith('MCP tools') ? 'MCP tools' : name)
    return i === -1 ? PART_ORDER.length : i
  }
  const parts = [...chars].map(([name, n]) => ({ name, chars: n, tokens: Math.round(total * n / sum) }))
    .sort((a, b) => rank(a.name) - rank(b.name) || b.chars - a.chars)

  const model = typeof request?.params?.model === 'string' ? request.params.model : assistantModel
  const betas: unknown[] = Array.isArray(request?.params?.betas) ? request!.params.betas : []
  const oneM = [model, requestedModel].some(m => typeof m === 'string' && m.endsWith('[1m]'))
    || betas.some(b => typeof b === 'string' && b.startsWith('context-1m'))

  return read({
    basis:         'estimated',
    estimatedWhy:  'not counted yet',
    sent,
    measuredTotal: total,
    alwaysOn:      total - (parts.find(p => p.name === 'First prompt')?.tokens ?? 0),
    parts,
    model:         model ?? null,
    version:       typeof shape.version === 'string' ? shape.version : null,
    at:            typeof shape.timestamp === 'string' ? shape.timestamp : null,
    window:        oneM ? 1_000_000 : null,
  })
}

// ─── the fs half ──────────────────────────────────────────────────────────────

/** Claude Code names a project's folder by turning every non-alphanumeric character of its path into `-`. */
export const projectFolderName = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

/** At most `bytes` from the start of a file, cut at the last whole line. null when it cannot be read. */
export function readHead(path: string, bytes: number = HEAD_BYTES): string | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    const text = buf.subarray(0, n).toString('utf8')
    // A file shorter than the head is whole; a longer one ends mid-line.
    return n < bytes ? text : text.slice(0, text.lastIndexOf('\n') + 1)
  } catch { return null }
  finally { if (fd !== null) try { closeSync(fd) } catch { /* nothing to release */ } }
}

/** How many of a project's newest transcripts are tried before giving up on finding a shape. */
const TRY_FILES = 15

/**
 * The context of the newest transcript for `cwd` that has a request shape.
 * Subagent transcripts live in a folder beside the session file and are not
 * listed; a sidechain line inside one is skipped by the reader.
 */
export function contextFor(cwd: string, opts: { configDir?: string } = {}): Read<Measured & { file: string, sessionId: string }> {
  const dir = join(opts.configDir ?? claudeConfigDir(), 'projects', projectFolderName(cwd))
  let names: string[]
  try { names = readdirSync(dir).filter(f => f.endsWith('.jsonl')) }
  catch { return unreadable(`no Claude Code transcripts for ${cwd}`) }
  const files = names
    .map(f => { try { return { path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs } } catch { return null } })
    .filter((f): f is { path: string, mtime: number } => f !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, TRY_FILES)
  if (files.length === 0) return unreadable(`no Claude Code transcripts for ${cwd}`)

  let why = ''
  for (const f of files) {
    const head = readHead(f.path)
    if (head === null) { why = 'a transcript could not be read'; continue }
    const ctx = readContext(head)
    if (ctx.ok) return read({ ...ctx.value, file: f.path, sessionId: f.path.slice(dir.length + 1, -'.jsonl'.length) })
    why = ctx.reason
  }
  return unreadable(`none of the ${files.length} newest transcripts for ${cwd} has a request shape (${why})`)
}

// ─── the count ────────────────────────────────────────────────────────────────

type Counter = (model: string, bodies: CountBody[]) => Promise<Read<number[]>>

/** Counted parts by transcript: a first request never changes, so each is asked once per process. */
const counted = new Map<string, ContextPart[]>()
const KEEP = 64

/**
 * `m` with its parts counted by the API, or as read with the reason the count
 * was refused. Each part is a count of a request holding it less a count of
 * the same request without it, so the tool-use preamble the API adds lands
 * once, on *System tools*, and an MCP server is counted on top of those.
 */
export async function countContext<T extends Measured>(m: T, key: string, count: Counter = countTokens): Promise<Omit<T, 'sent'>> {
  const { sent, ...ctx } = m
  const asCounted = (parts: ContextPart[]) => ({
    ...ctx, parts, basis: 'counted' as const, estimatedWhy: null,
    alwaysOn: ctx.measuredTotal - (parts.find(p => p.name === 'First prompt')?.tokens ?? 0),
  })
  const hit = counted.get(key)
  if (hit) return asCounted(hit)
  if (!ctx.model) return { ...ctx, estimatedWhy: 'the transcript names no model to count under' }

  const probe = { role: 'user', content: 'x' }
  const bare: CountBody = { messages: [probe] }
  const own = sent.get('System tools')
  const systemTools = own && 'tools' in own ? own.tools : []
  const bodies: CountBody[] = [bare, systemTools.length ? { tools: systemTools, messages: [probe] } : bare]
  // [body index, the index it is less, tokens added back]: a text part replaces the probe's one token.
  const plan = ctx.parts.map((p): [number, number, number] => {
    const s = sent.get(p.name)
    if (!s) return [0, 0, 0]
    if (p.name === 'System tools') return [1, 0, 0]
    if ('tools' in s) return [bodies.push({ tools: [...systemTools, ...s.tools], messages: [probe] }) - 1, 1, 0]
    if ('system' in s) return [bodies.push({ system: s.system, messages: [probe] }) - 1, 0, 0]
    return [bodies.push({ messages: [{ role: 'user', content: s.text }] }) - 1, 0, 1]
  })

  // A window suffix (`[1m]`) names a beta, not a model the endpoint knows.
  const r = await count(ctx.model.replace(/\[[^\]]*\]$/, ''), bodies)
  if (!r.ok) return { ...ctx, estimatedWhy: r.reason }
  const parts = ctx.parts.map((p, i) => {
    const [at, less, back] = plan[i]
    return { ...p, tokens: Math.max(0, r.value[at] - r.value[less] + back) }
  })
  if (counted.size >= KEEP) counted.delete(counted.keys().next().value!)
  counted.set(key, parts)
  return asCounted(parts)
}
