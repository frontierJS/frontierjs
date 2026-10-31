// src/domain/local/local-mcp.ts — one MCP server's tool list, asked of the server itself.
//
// `claude mcp list` says a server starts; this says what it offers. The server is
// started (stdio) or called (HTTP, SSE) as Claude Code would, an MCP handshake is
// made, `tools/list` is read, and the connection is closed — the stdio child is
// killed with it. Behind `LOCAL_MACHINE` at the service like the rest of
// `domain/local/`.
//
// The config handed in is the server's own, env and header VALUES included,
// because a server started without its token fails. None of it is returned: the
// answer is tool names, descriptions and argument names.
//
// An OAuth server is not signed in from here. Claude Code keeps that token in
// the OS keychain and refreshing it rotates it under every running `claude`, so a
// 401 answers *needs sign-in*, never a retry.

import { Client, SSEClientTransport, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'
import { read, unreadable, type Read } from '../claude/claude-read.ts'

export type McpTool = {
  name:        string
  description: string | null
  /** The input schema's property names; `required` ones carry no mark here. */
  args:        string[]
}

export type McpTools = {
  server:  { name: string | null, version: string | null }
  tools:   McpTool[]
  /** Milliseconds from start to the tool list. */
  tookMs:  number
}

export type McpRaw = {
  type?:    string
  command?: string
  args?:    string[]
  env?:     Record<string, string>
  url?:     string
  headers?: Record<string, string>
}

const TIMEOUT_MS = 20_000
const MAX_TOOLS  = 500

const strings = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) as Record<string, string> : {}

function transportFor(cfg: McpRaw, cwd: string | undefined) {
  if (typeof cfg.command === 'string' && cfg.command) {
    return new StdioClientTransport({
      command: cfg.command,
      args:    Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env:     { ...getDefaultEnvironment(), ...strings(cfg.env) },
      cwd,
      // A server's log on stderr would land in the API's own output.
      stderr:  'ignore',
    })
  }
  if (typeof cfg.url !== 'string') return null
  let url: URL
  try { url = new URL(cfg.url) } catch { return null }
  const requestInit = { headers: strings(cfg.headers) }
  return cfg.type === 'sse' ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit })
}

/** Start the server, list its tools, close it. Never throws. */
export async function listMcpTools(cfg: McpRaw, opts: { cwd?: string, timeoutMs?: number } = {}): Promise<Read<McpTools>> {
  const t0 = performance.now()
  const transport = transportFor(cfg, opts.cwd)
  if (!transport) return unreadable('the server names neither a command nor a valid url')
  const client = new Client({ name: 'basecamp-claude-tab', version: '1' })
  const ms = opts.timeoutMs ?? TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no tool list within ${ms / 1000}s`)), ms) })
  try {
    await Promise.race([client.connect(transport), late])
    const tools: McpTool[] = []
    let cursor: string | undefined
    do {
      const page: any = await Promise.race([client.listTools(cursor ? { cursor } : undefined), late])
      for (const t of page.tools ?? []) {
        tools.push({
          name:        String(t.name),
          description: typeof t.description === 'string' ? t.description : null,
          args:        Object.keys(t.inputSchema?.properties ?? {}),
        })
      }
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined
    } while (cursor && tools.length < MAX_TOOLS)
    const info = client.getServerVersion()
    return read({ server: { name: info?.name ?? null, version: info?.version ?? null }, tools, tookMs: Math.round(performance.now() - t0) })
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    // The SDK's HTTP error carries the status on `status` and an empty message.
    const status = (e as { status?: unknown })?.status
    if (e instanceof UnauthorizedError || status === 401 || status === 403 || /\b401\b|unauthorized/i.test(msg)) return unreadable('needs sign-in: Claude Code holds this server\'s OAuth token, and this tab does not read it')
    return unreadable(typeof status === 'number' ? `HTTP ${status}${msg.replace(/^Error POSTing to endpoint:\s*/, '') ? `: ${msg}` : ''}` : msg)
  } finally {
    clearTimeout(timer)
    await client.close().catch(() => {})
  }
}
