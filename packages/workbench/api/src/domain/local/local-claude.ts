// src/domain/local/local-claude.ts — who the operator's own `claude` is logged in as.
//
// The sibling of `local-git.ts`: one spawn of the Claude Code binary on the
// operator's machine, and the parse of what it prints in one place. Behind
// `LOCAL_MACHINE` at the service like the rest of `domain/local/`; a deployed
// control plane would be reading ITS server's login.
//
// `claude auth status --json` is a Claude Code output, so its fields move
// without notice. `readAuthStatus` is pure and names the fields it keeps; a
// field it does not keep is dropped rather than passed through, which is also
// why a token, should a later version print one, cannot reach a screen. A
// missing field is `null`, never a guess, and text that is not the expected
// object is `unreadable` with the reason.
//
// The spawn is argv only (no shell), the binary is `CLAUDE_BIN`, and it is
// killed at 10 s: a `claude` that wants a TTY or a browser must not hold a
// request open.

import { childEnv } from '@frontierjs/junction'
import { env } from '../../core/env.ts'
import { read, readJsonObject, unreadable, type Read } from '../claude/claude-read.ts'

export type AuthStatus = {
  loggedIn:         boolean
  /** `claude.ai`, `console`, `api-key`... as Claude Code spells it. */
  authMethod:       string | null
  apiProvider:      string | null
  email:            string | null
  orgId:            string | null
  orgName:          string | null
  /** `max`, `pro`, `team`... — absent for an API-key login. */
  subscriptionType: string | null
}

const TIMEOUT_MS = 10_000

const str = (v: unknown): string | null => typeof v === 'string' && v ? v : null

/** `claude auth status --json` output as an AuthStatus, keeping only the named fields. */
export function readAuthStatus(text: string): Read<AuthStatus> {
  const json = readJsonObject(text)
  if (!json.ok) return unreadable(`claude auth status: ${json.reason}`)
  const o = json.value
  if (typeof o.loggedIn !== 'boolean') return unreadable("claude auth status: no 'loggedIn' field")
  return read({
    loggedIn:         o.loggedIn,
    authMethod:       str(o.authMethod),
    apiProvider:      str(o.apiProvider),
    email:            str(o.email),
    orgId:            str(o.orgId),
    orgName:          str(o.orgName),
    subscriptionType: str(o.subscriptionType),
  })
}

/** Run `claude auth status --json`. Never throws. */
export async function claudeAuthStatus(bin: string = env.CLAUDE_BIN): Promise<Read<AuthStatus>> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([bin, 'auth', 'status', '--json'], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
      env:   childEnv(env),
    })
  } catch (e) { return unreadable(`could not start '${bin}': ${(e as Error).message}`) }

  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; proc.kill() }, TIMEOUT_MS)
  try {
    const out  = await new Response(proc.stdout as ReadableStream).text()
    const code = await proc.exited
    if (timedOut) return unreadable(`'${bin} auth status' took longer than ${TIMEOUT_MS / 1000}s`)
    // A logged-out `claude` may exit non-zero and still print the JSON, so the text is tried first.
    const parsed = readAuthStatus(out)
    if (parsed.ok || code === 0) return parsed
    return unreadable(`'${bin} auth status' exited ${code}`)
  } catch (e) { return unreadable(`'${bin} auth status' failed: ${(e as Error).message}`) }
  finally { clearTimeout(timer) }
}

// ─── a configuration change through the CLI ───────────────────────────────────

export type ClaudeRun = { code: number, out: string, err: string }

/**
 * Run `claude <args>` for a change Claude Code makes to its own files — a
 * plugin, a marketplace, an MCP server. Argv only, the binary `CLAUDE_BIN`, and
 * `CLAUDE_CONFIG_DIR` inherited, so the CLI writes the directory the scan reads.
 * An install clones a repository, so the caller sets the timeout. `unreadable`
 * only when it could not run; a non-zero exit is the caller's to word.
 */
export async function runClaude(args: string[], opts: { cwd?: string, timeoutMs?: number, bin?: string } = {}): Promise<Read<ClaudeRun>> {
  const bin = opts.bin ?? env.CLAUDE_BIN
  const ms  = opts.timeoutMs ?? 30_000
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([bin, ...args], {
      cwd: opts.cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: childEnv(env),
    })
  } catch (e) { return unreadable(`could not start '${bin}': ${(e as Error).message}`) }

  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; proc.kill() }, ms)
  try {
    const [out, err] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ])
    const code = await proc.exited
    if (timedOut) return unreadable(`'claude ${args[0]} ${args[1] ?? ''}' took longer than ${ms / 1000}s`)
    return read({ code, out, err })
  } catch (e) { return unreadable(`'claude ${args[0]}' failed: ${(e as Error).message}`) }
  finally { clearTimeout(timer) }
}

// ─── claude mcp list ──────────────────────────────────────────────────────────

export type McpHealthState = 'connected' | 'needs-auth' | 'failed' | 'other'

export type McpHealth = {
  name:   string
  /** As `claude` prints it: a command line, or a URL with its transport. */
  target: string
  state:  McpHealthState
  /** The status words, `Failed to connect` or `Needs authentication`. */
  status: string
  /** What follows the dash on a failure — the spawn error, the HTTP status. */
  detail: string | null
}

// `name: target - ✔ Connected`; a target is a command line and may hold ` - `, so the glyph anchors the split.
const HEALTH_LINE = /^(.+?): (.*) - ([✔✓✘✗!⚠])\s+(.+)$/

/**
 * `claude mcp list` output, one row per server it checked. It runs every server
 * to answer, which is the point — the scan says what is configured, this says
 * what starts. A line that is not a server is skipped; output with neither a
 * server nor the empty-list sentence is `unreadable`, since a changed format
 * would otherwise read as *no servers*.
 */
export function readMcpList(text: string): Read<McpHealth[]> {
  const out: McpHealth[] = []
  let empty = false
  for (const line of text.split('\n').map(l => l.trim())) {
    if (/^No MCP servers configured/i.test(line)) { empty = true; continue }
    const m = HEALTH_LINE.exec(line)
    if (!m) continue
    const [, name, target, , rest] = m
    const at = rest.indexOf(' — ')
    const status = (at < 0 ? rest : rest.slice(0, at)).trim()
    const state: McpHealthState = /^connected/i.test(status) ? 'connected'
      : /auth/i.test(status) ? 'needs-auth'
      : /fail/i.test(status) ? 'failed' : 'other'
    out.push({ name, target, state, status, detail: at < 0 ? null : rest.slice(at + 3).trim() || null })
  }
  if (!out.length && !empty) return unreadable('claude mcp list: no server lines and no empty-list message')
  return read(out)
}

// ─── claude doctor ────────────────────────────────────────────────────────────

export type DoctorFinding = {
  /** The heading it was listed under, `Invalid settings`. */
  section: string
  /** The file a settings finding names, else null. */
  path:    string | null
  /** The key path inside that file, `permissions.allow`. */
  key:     string | null
  message: string
  /** The indented `Fix:` or `Suggested fix:` line under it. */
  fix:     string | null
}

export type Doctor = {
  /** The `Key: value` lines under the title — version, install method, auto-updates. */
  facts:    { key: string, value: string }[]
  findings: DoctorFinding[]
  /** The sentence it ends on, `No installation issues found.` */
  summary:  string | null
}

/**
 * `claude doctor` output. It prints a title, `Key: value` facts, then sections —
 * a heading line and `- ` bullets, a fix indented under one — and a summary,
 * `No installation issues found.` or `1 warning found` with the installation
 * warnings as its bullets. A bullet is a finding; a settings one reads
 * `- <path> › <key>: <message>`. Prose under a heading is not a finding.
 */
export function readDoctor(text: string): Read<Doctor> {
  const lines = text.split('\n').map(l => l.trimEnd())
  if (!lines.some(l => /^Claude Code doctor/i.test(l.trim()))) return unreadable("claude doctor: no 'Claude Code doctor' title")
  const facts: Doctor['facts'] = []
  const findings: DoctorFinding[] = []
  let summary: string | null = null
  let section: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || /^Claude Code doctor/i.test(line) || /^For a full setup checkup/i.test(line)) continue
    const fix = /^(?:Suggested fix|Fix): (.+)$/.exec(line)
    if (fix && /^\s/.test(lines[i]) && findings.length) { findings[findings.length - 1].fix = fix[1]; continue }
    if (line.startsWith('- ')) {
      const body = line.slice(2)
      const m = /^(\S.*?) › ([^:]+): (.+)$/.exec(body)
      findings.push(m
        ? { section: section ?? 'Findings', path: m[1], key: m[2], message: m[3], fix: null }
        : { section: section ?? 'Findings', path: null, key: null, message: body, fix: null })
      continue
    }
    if (/^(no |\d+ )?(installation )?(issues?|warnings?|errors?) found/i.test(line)) { summary = line; section = 'Installation'; continue }
    const kv = /^([A-Z][^:]{0,60}): (.+)$/.exec(line)
    if (kv && section === null) { facts.push({ key: kv[1], value: kv[2] }); continue }
    // A heading is a line whose next line is not blank: the facts block has none.
    if (!/[.:]$/.test(line) && (lines[i + 1] ?? '').trim() !== '') section = line
  }
  return read({ facts, findings, summary })
}
