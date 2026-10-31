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
// **The parts are an apportionment, not a tokenizer.** The API reports one
// total. Each part's `tokens` is that total split by the part's share of
// characters, so a part is as right as its characters-per-token matches the
// whole prompt's. The total is measured; the split is not.
//
// **Not the same number as `/context`.** `/context` counts the schemas of
// DEFERRED tools (loaded on demand through ToolSearch) as their own lines; the
// first request carries only their names, so those schemas are not in
// `measuredTotal` and not in `parts`. The parts that map are named as
// `/context` names them. The measured total also includes the first prompt the
// user typed, which is its own part and left out of `alwaysOn`.
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
import { read, unreadable, type Read } from './claude-read.ts'
import { claudeConfigDir } from './claude-scan.ts'

export type ContextPart = { name: string, chars: number, tokens: number }

export type Context = {
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

export type ContextFor = Context & { file: string, sessionId: string }

const HEAD_BYTES = 2 * 1024 * 1024

// ─── the pure half ────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Characters of a rendered attachment: the `content` strings it was sent as. */
function renderedChars(rendered: unknown): number {
  if (!Array.isArray(rendered)) return 0
  let n = 0
  for (const r of rendered) {
    const c = isObj(r) ? r.content : null
    if (typeof c === 'string') n += c.length
    else if (Array.isArray(c)) for (const b of c) if (isObj(b) && typeof b.text === 'string') n += b.text.length
  }
  return n
}

/** Which part an attachment type fills. A type not named here (hook output, IDE selection) is not always-on. */
const ATTACHMENT_PART: Record<string, string> = {
  instructions:          'Memory files',
  skill_listing:         'Skills',
  agent_listing_delta:   'Custom agents',
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
  'System prompt', 'System tools', 'MCP tools', 'MCP server instructions', 'Custom agents',
  'Memory files', 'Skills', 'Deferred tool list', 'Other', 'First prompt',
]

const mcpServer = (tool: string): string => tool.split('__')[1] || 'unknown'

/** The text of the first human prompt: a string, or the `text` blocks of an array. */
function promptChars(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const b of content) if (isObj(b) && b.type === 'text' && typeof b.text === 'string') n += b.text.length
  return n
}

/**
 * The context estimate from the head of one transcript. A last line cut off by
 * the head's end fails to parse and is skipped.
 */
export function readContext(text: string): Read<Context> {
  const chars = new Map<string, number>()
  const add = (name: string, n: number) => { if (n > 0) chars.set(name, (chars.get(name) ?? 0) + n) }

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
        add('First prompt', promptChars(c))
      }
    }
    else if (o.type === 'attachment' && isObj(o.attachment)) {
      const part = ATTACHMENT_PART[o.attachment.type]
      if (part) add(part, renderedChars(o.rendered))
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

  for (const b of Array.isArray(shape.shape.system) ? shape.shape.system : []) {
    if (isObj(b) && typeof b.text === 'string') add('System prompt', b.text.length)
  }
  const mcpChars = new Map<string, number>()
  for (const t of Array.isArray(shape.shape.tools) ? shape.shape.tools : []) {
    if (!isObj(t)) continue
    const size = JSON.stringify(t).length
    const name = typeof t.name === 'string' ? t.name : ''
    if (name.startsWith('mcp__')) mcpChars.set(mcpServer(name), (mcpChars.get(mcpServer(name)) ?? 0) + size)
    else add('System tools', size)
  }
  // Per server, so a screen can name the one server eating the budget.
  for (const [server, n] of mcpChars) add(`MCP tools: ${server}`, n)

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
export function contextFor(cwd: string, opts: { configDir?: string } = {}): Read<ContextFor> {
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
