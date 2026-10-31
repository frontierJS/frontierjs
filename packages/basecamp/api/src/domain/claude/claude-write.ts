// src/domain/claude/claude-write.ts — the one writer of Claude Code's configuration (IDEAS/claude-code.md 3.1).
//
// Every change the Claude Code tab makes goes through here and leaves one
// `ClaudeWrite` row: what changed, and what taking it back needs. Two kinds:
//
// - **A file Basecamp writes** — a settings layer, a skill, an agent, a
//   `CLAUDE.md`. The text before is kept on the row (`@encrypted`: `env` and an
//   MCP server's headers carry tokens) and the sha256 of the text written. The
//   write goes through a rename, so a crash cannot leave half a settings file,
//   which Claude Code reads as no settings at all. Undo puts the text back, and
//   is refused once the file's digest has moved: a running `claude` edits these
//   files too, and replaying the old text over its edit would lose it.
// - **A change the `claude` CLI makes** — a plugin, a marketplace, an MCP
//   server. Claude Code owns those files (`~/.claude.json` is rewritten by every
//   running session), so the CLI makes the change and undo is the inverse
//   command. A removed MCP server's config is kept on the row so undo can add
//   it back; that is also how a user or local server is disabled, since Claude
//   Code has no disable for one.
//
// A trashed skill, agent or command is moved into a folder this writer owns,
// named for its row, and undo moves it back unless something took its place.
//
// The row never carries a value outside `before`, and `before` never leaves the
// server: the call trail names the row, the row names the file and the keys.

import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { runClaude } from '../local/local-claude.ts'
import { read, readJsonObject, unreadable, type Read } from './claude-read.ts'

// ─── shapes ───────────────────────────────────────────────────────────────────

/** A `ClaudeWrite` row as the screen sees it — never `before`. */
export type WriteRow = {
  id:        string
  action:    string
  target:    string
  project:   string | null
  scope:     string | null
  keys:      string
  undoneAt:  string | null
  createdAt: string
}

export const WRITE_SELECT = {
  id: true, action: true, target: true, project: true, scope: true, keys: true, undoneAt: true, createdAt: true,
} as const

/** What the `claude` CLI is asked to undo, per action; an action absent here cannot be undone. */
type Inverse = (row: { target: string, scope: string | null, before: string | null }) => string[] | null

const CLI_INVERSE: Record<string, Inverse> = {
  'plugin.enable':      r => ['plugin', 'disable', r.target, ...scopeArgs(r.scope), '--json'],
  'plugin.disable':     r => ['plugin', 'enable', r.target, ...scopeArgs(r.scope), '--json'],
  'plugin.install':     r => ['plugin', 'uninstall', r.target, ...scopeArgs(r.scope), '--json'],
  'plugin.uninstall':   r => ['plugin', 'install', r.target, ...scopeArgs(r.scope), '--json'],
  'marketplace.add':    r => ['plugin', 'marketplace', 'remove', r.target],
  'marketplace.remove': r => r.before ? ['plugin', 'marketplace', 'add', r.before] : null,
  'mcp.add':            r => ['mcp', 'remove', r.target, ...scopeArgs(r.scope)],
  'mcp.remove':         r => r.before ? ['mcp', 'add-json', r.target, r.before, ...scopeArgs(r.scope)] : null,
  'mcp.disable':        r => r.before ? ['mcp', 'add-json', r.target, r.before, ...scopeArgs(r.scope)] : null,
}

const FILE_ACTIONS = new Set(['file.save', 'settings', 'permissions'])

const scopeArgs = (scope: string | null) => scope ? ['-s', scope] : []

export const undoable = (row: { action: string, undoneAt: unknown }): boolean =>
  !row.undoneAt && (FILE_ACTIONS.has(row.action) || row.action === 'file.trash' || row.action in CLI_INVERSE)

/** Where trashed items wait, beside the Workbench's own folder. A browser has no OS trash. */
export const TRASH_DIR = join(homedir(), '.config', 'basecamp', 'claude-trash')

/** The largest file the tab writes; a skill past this is not something a form should hold. */
export const MAX_WRITE_BYTES = 500 * 1024

// ─── pure: settings and permissions ───────────────────────────────────────────

/** The settings the editor offers, by the type Claude Code reads each as. */
export const SETTING_TYPES = {
  model:                 'string',
  theme:                 'string',
  language:              'string',
  alwaysThinkingEnabled: 'boolean',
  effortLevel:           'string',
  voiceEnabled:          'boolean',
} as const

/** A settings patch with every key one the editor offers; `null` clears (Invariant 9). */
export function checkSettingsPatch(patch: Record<string, unknown>): Read<Record<string, string | boolean | null>> {
  const out: Record<string, string | boolean | null> = {}
  for (const [k, v] of Object.entries(patch)) {
    const type = (SETTING_TYPES as Record<string, string>)[k]
    if (!type) return unreadable(`'${k}' is not a setting this editor writes`)
    if (v !== null && typeof v !== type) return unreadable(`'${k}' is a ${type}`)
    out[k] = v === '' ? null : v as string | boolean | null
  }
  return read(out)
}

/**
 * The file's text with `patch` merged at the top level: a key set to `null` is
 * removed, every other key replaced. `keys` names the ones that changed. A file
 * that does not parse is refused rather than replaced — it may be a hand edit
 * mid-save, and writing over it loses the edit.
 */
export function patchJson(text: string | null, patch: Record<string, unknown>): Read<{ text: string, keys: string[] }> {
  let obj: Record<string, unknown> = {}
  if (text !== null && text.trim()) {
    const parsed = readJsonObject(text)
    if (!parsed.ok) return unreadable(`the file does not read, so it is not written over: ${parsed.reason}`)
    obj = parsed.value
  }
  const keys: string[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      if (!(k in obj)) continue
      delete obj[k]
    } else {
      if (JSON.stringify(obj[k]) === JSON.stringify(v)) continue
      obj[k] = v
    }
    keys.push(k)
  }
  return read({ text: JSON.stringify(obj, null, 2) + '\n', keys })
}

export type RuleList = 'allow' | 'ask' | 'deny'
export type RuleCheck = { list: RuleList, rule: string, error: string | null, warning: string | null }

/** Claude Code's built-in tools; an `mcp__server__tool` name is a tool too. */
const KNOWN_TOOLS = new Set([
  'Agent', 'Bash', 'BashOutput', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'KillShell', 'LS', 'MultiEdit',
  'NotebookEdit', 'NotebookRead', 'Read', 'Skill', 'SlashCommand', 'Task', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write',
])

const RULE = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/s

/**
 * Each rule as `Tool` or `Tool(specifier)`. A malformed rule is an error — Claude
 * Code ignores it, so the deny it was meant to be is not in force. An unknown
 * tool and an allow that grants a whole tool are warnings: both are legal.
 */
export function checkRules(lists: Partial<Record<RuleList, unknown>>): RuleCheck[] {
  const out: RuleCheck[] = []
  for (const list of ['allow', 'ask', 'deny'] as const) {
    const rules = lists[list]
    if (rules === undefined) continue
    if (!Array.isArray(rules)) { out.push({ list, rule: String(rules), error: `${list} is a list of rules`, warning: null }); continue }
    for (const raw of rules) {
      const rule = typeof raw === 'string' ? raw.trim() : ''
      const m = RULE.exec(rule)
      if (!m) { out.push({ list, rule: String(raw), error: 'not Tool or Tool(specifier)', warning: null }); continue }
      const [, tool, spec] = m
      let warning: string | null = null
      if (!KNOWN_TOOLS.has(tool) && !tool.startsWith('mcp__')) warning = `${tool} is not a tool Claude Code ships`
      else if (list === 'allow' && (spec === undefined || /^\*?$|^:\*$/.test(spec.trim()))) warning = `allows every ${tool} call`
      out.push({ list, rule, error: null, warning })
    }
  }
  return out
}

/** The settings text with `permissions.allow/ask/deny` replaced, the rest of `permissions` kept. */
export function patchPermissions(text: string | null, lists: Record<RuleList, string[]>): Read<{ text: string, keys: string[] }> {
  const current = text && text.trim() ? readJsonObject(text) : read({} as Record<string, unknown>)
  if (!current.ok) return unreadable(`the file does not read, so it is not written over: ${current.reason}`)
  const was = current.value.permissions
  const base = was && typeof was === 'object' && !Array.isArray(was) ? was as Record<string, unknown> : {}
  const next: Record<string, unknown> = { ...base }
  for (const list of ['allow', 'ask', 'deny'] as const) {
    if (lists[list].length) next[list] = lists[list]
    else delete next[list]
  }
  return patchJson(text, { permissions: Object.keys(next).length ? next : null })
}

// ─── fs ───────────────────────────────────────────────────────────────────────

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** The file's text, or null when there is none. Any other failure throws: it is not "absent". */
export function readOrNull(path: string): string | null {
  try { return readFileSync(path, 'utf8') }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
}

function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  let mode: number | undefined
  try { mode = statSync(path).mode & 0o777 } catch {}
  const tmp = `${path}.${process.pid}.basecamp.tmp`
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode })
  renameSync(tmp, path)
}

/** A rename, else a copy and delete: the trash may sit on another filesystem. */
function move(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true })
  try { renameSync(from, to) }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    cpSync(from, to, { recursive: true, preserveTimestamps: true })
    rmSync(from, { recursive: true, force: true })
  }
}

const sys = (db: any) => db.asSystem().claudeWrite

type Where = { project?: string | null, scope?: string | null }

/** Write `text` to `path` and record it. Refused when it would change nothing. */
export async function saveFile(db: any, o: Where & { action: string, path: string, text: string, keys: string[] }): Promise<Read<WriteRow>> {
  if (Buffer.byteLength(o.text) > MAX_WRITE_BYTES) return unreadable(`over the ${MAX_WRITE_BYTES / 1024} KB a file here is written at`)
  const before = readOrNull(o.path)
  if (before === o.text) return unreadable('nothing changed')
  writeAtomic(o.path, o.text)
  return read(await sys(db).create({
    data:   { action: o.action, target: o.path, project: o.project ?? null, scope: o.scope ?? null, keys: o.keys.join(','), before, digest: sha(o.text) },
    select: WRITE_SELECT,
  }))
}

/** Move a file or folder into the trash and record where it came from. */
export async function trashPath(db: any, o: Where & { path: string, trashDir?: string }): Promise<Read<WriteRow>> {
  if (!existsSync(o.path)) return unreadable('gone since the scan')
  const id = randomUUID()
  move(o.path, join(o.trashDir ?? TRASH_DIR, id))
  return read(await sys(db).create({
    data:   { id, action: 'file.trash', target: o.path, project: o.project ?? null, scope: o.scope ?? null },
    select: WRITE_SELECT,
  }))
}

/** Record a change the CLI already made; `before` is what its undo needs back. */
export async function recordCli(db: any, o: Where & { action: string, target: string, before?: string | null }): Promise<WriteRow> {
  return sys(db).create({
    data:   { action: o.action, target: o.target, project: o.project ?? null, scope: o.scope ?? null, before: o.before ?? null },
    select: WRITE_SELECT,
  })
}

/** A CLI result as one line of text, for a refusal the screen shows. */
export function cliFailure(r: { code: number, out: string, err: string }): string {
  const lastJson = r.out.trim().split('\n').reverse().find(l => l.startsWith('{'))
  if (lastJson) try { const j = JSON.parse(lastJson); if (j.message) return String(j.message) } catch {}
  return (r.err.trim() || r.out.trim()).split('\n').slice(-3).join(' ') || `exited ${r.code}`
}

/** Take a write back. Refused once the file moved since, or when the inverse cannot run. */
export async function undoWrite(db: any, id: string, opts: { trashDir?: string } = {}): Promise<Read<WriteRow>> {
  const row = await sys(db).findFirst({ where: { id }, select: { ...WRITE_SELECT, before: true, digest: true } })
  if (!row) return unreadable('not a write Basecamp made')
  if (row.undoneAt) return unreadable('already undone')

  if (FILE_ACTIONS.has(row.action)) {
    const now = readOrNull(row.target)
    if (now === null || sha(now) !== row.digest) return unreadable(`${row.target} has changed since; undo would lose that change`)
    if (row.before === null) rmSync(row.target)
    else writeAtomic(row.target, row.before)
  } else if (row.action === 'file.trash') {
    const held = join(opts.trashDir ?? TRASH_DIR, row.id)
    if (!existsSync(held)) return unreadable('no longer in the trash')
    if (existsSync(row.target)) return unreadable(`${row.target} exists again; move it before restoring`)
    move(held, row.target)
  } else {
    const args = CLI_INVERSE[row.action]?.(row)
    if (!args) return unreadable(`${row.action} cannot be undone`)
    const ran = await runClaude(args, { cwd: row.project ?? undefined, timeoutMs: 120_000 })
    if (!ran.ok) return ran
    if (ran.value.code !== 0) return unreadable(cliFailure(ran.value))
  }

  return read(await sys(db).update({ where: { id }, data: { undoneAt: new Date() }, select: WRITE_SELECT }))
}
