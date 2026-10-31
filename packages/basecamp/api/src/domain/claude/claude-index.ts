// src/domain/claude/claude-index.ts — the usage index: what Claude Code's transcripts say, kept in the database.
//
// Walks every `*.jsonl` under `<config dir>/projects/` — a session's own file and
// the `*/subagents/*.jsonl` of the agents it spawned — and keeps one
// `ClaudeTranscript` row per file (where it stopped reading) and one
// `ClaudeMessage` row per assistant message. The reading of a transcript is
// `readMessages` in `@frontierjs/cli/core/claude-usage.js`, the same one `fli git:history`
// tallies with; this file is the fs and database half.
//
// **An append reads only what it gained.** A file whose size equals the stored
// offset is skipped, a larger one is read from the offset, a smaller one was
// rewritten and is read from 0. The offset is only ever a position just past a
// newline, so a line Claude Code is still writing is read on the next pass.
//
// **Every write is idempotent on `messageId`.** A resumed session repeats earlier
// ids, a streamed reply's lines can land on either side of an offset, and a file
// re-read from 0 meets every row again; a repeat collapses onto its row, and one
// that names a tool the row lacks adds it. Messages are written BEFORE the offset
// moves, so a pass that dies midway re-reads and collapses.
//
// **A vanished file is marked, not deleted.** Claude Code removes transcripts
// after `cleanupPeriodDays`, and these rows are then the only record.
//
// The first fill reads gigabytes, so this runs from `jobs/claude-index.job.ts`
// and never inside a request. It writes through `asSystem()`.

import { closeSync, openSync, readdirSync, readSync, statSync, type Dirent } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { claudeConfigDir } from './claude-scan.ts'

type Fact = { sessionId: string | null, cwd: string | null, headless: boolean, title: string | null, firstPrompt: string | null, startedAt: string | null, lastAt: string | null }
type Msg = {
  id: string | null, model: string | null, at: string, sessionId: string | null, cwd: string | null,
  input: number, cacheWrite: number, cacheWrite1h: number, cacheRead: number, output: number, tools: string[]
}
type ReadMessages = (text: string, opts?: { final?: boolean }) => { consumed: number, file: Fact, messages: Msg[] }

let reader: Promise<ReadMessages> | undefined
const loadReader = () => reader ??= import('@frontierjs/cli/core/claude-usage.js').then(m => (m as { readMessages: ReadMessages }).readMessages)

export interface IndexResult {
  /** `*.jsonl` files found on disk. */
  files:    number
  /** Files read this pass (new, grown or rewritten). */
  read:     number
  /** Messages seen in what was read, repeats included. */
  seen:     number
  /** Message rows created. */
  added:    number
  /** Rows marked `gone` this pass. */
  gone:     number
  bytes:    number
  ms:       number
}

type Row = { id: string, path: string, offset: number, size: number, gone: boolean, cwd: string | null, headless: boolean, title: string | null, firstPrompt: string | null, startedAt: string | null, lastAt: string | null }

const SLICE = 64 * 1024 * 1024
const KEYS = 400
const IGNORED_DIRS = new Set(['tool-results', 'node_modules'])

/** Every transcript under `<configDir>/projects`, a session's own and its subagents'. */
export function listTranscripts(configDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    let entries: Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) { if (depth < 4 && !IGNORED_DIRS.has(e.name)) walk(full, depth + 1) }
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
    }
  }
  walk(join(configDir, 'projects'), 0)
  return out
}

const isSubagent = (path: string) => path.includes(`${sep}subagents${sep}`)
const sessionOfPath = (path: string) => isSubagent(path) ? basename(dirname(dirname(path))) : basename(path, '.jsonl')

/** Bytes [from, to) as text, and how many of them ended on a newline. Grows the slice for a line longer than it. */
function readSlice(fd: number, from: number, to: number, read: ReadMessages) {
  let want = Math.min(SLICE, to - from)
  for (;;) {
    const buf = Buffer.allocUnsafe(want)
    const n = readSync(fd, buf, 0, want, from)
    const r = read(buf.toString('utf8', 0, n), { final: false })
    if (r.consumed > 0 || from + want >= to) return { ...r, got: n }
    want = Math.min(want * 2, to - from)
  }
}

const sorted = (tools: Iterable<string>) => [...new Set(tools)].sort().join(',')
const union = (a: string, b: string[]) => sorted([...(a ? a.split(',') : []), ...b])

async function writeMessages(db: any, msgs: Msg[], subagent: boolean, sessionId: string, cwd: string | null): Promise<number> {
  const byId = new Map<string, Msg>()
  for (const m of msgs) {
    if (!m.id || !m.model || m.model === '<synthetic>') continue
    const had = byId.get(m.id)
    if (had) had.tools = [...new Set([...had.tools, ...m.tools])]
    else byId.set(m.id, { ...m })
  }
  const all = [...byId.values()]
  let added = 0
  for (let i = 0; i < all.length; i += KEYS) {
    const batch = all.slice(i, i + KEYS)
    const have = new Map<string, string>(
      (await db.claudeMessage.findMany({ where: { messageId: { in: batch.map(m => m.id) } }, select: { messageId: true, tools: true } }))
        .map((r: { messageId: string, tools: string }) => [r.messageId, r.tools]),
    )
    const fresh = batch.filter(m => !have.has(m.id!))
    for (const m of batch) {
      if (!have.has(m.id!) || !m.tools.length) continue
      const merged = union(have.get(m.id!)!, m.tools)
      if (merged !== have.get(m.id!)) await db.claudeMessage.update({ where: { messageId: m.id }, data: { tools: merged } })
    }
    if (fresh.length) {
      await db.claudeMessage.createMany({
        data: fresh.map(m => ({
          messageId: m.id, sessionId: m.sessionId ?? sessionId, cwd: m.cwd ?? cwd, model: m.model, at: m.at,
          input: m.input, cacheWrite: m.cacheWrite, cacheWrite1h: m.cacheWrite1h, cacheRead: m.cacheRead, output: m.output,
          tools: sorted(m.tools), subagent,
        })),
      })
      added += fresh.length
    }
  }
  return added
}

/**
 * One pass over the transcripts. `db` is the SYSTEM client — the index is the
 * installation's own history and nothing a caller may write.
 */
export async function indexClaude(db: any, opts: { configDir?: string } = {}): Promise<IndexResult> {
  const t0 = performance.now()
  const read = await loadReader()
  const configDir = claudeConfigDir({ configDir: opts.configDir })
  const onDisk = listTranscripts(configDir)
  const rows = new Map<string, Row>(
    (await db.claudeTranscript.findMany({
      select: { id: true, path: true, offset: true, size: true, gone: true, cwd: true, headless: true, title: true, firstPrompt: true, startedAt: true, lastAt: true },
    })).map((r: Row) => [r.path, r]),
  )
  const res: IndexResult = { files: onDisk.length, read: 0, seen: 0, added: 0, gone: 0, bytes: 0, ms: 0 }
  const present = new Set(onDisk)

  for (const path of onDisk) {
    let size: number
    try { size = statSync(path).size } catch { continue }
    const row = rows.get(path)
    if (row && row.size === size && row.offset === size && !row.gone) continue

    const rewritten = !!row && size < row.offset
    const from = !row || rewritten ? 0 : row.offset
    const fresh = !row || rewritten
    let offset = from
    const facts: Fact = { sessionId: null, cwd: null, headless: false, title: null, firstPrompt: null, startedAt: null, lastAt: null }
    const subagent = isSubagent(path)
    const fallbackSession = sessionOfPath(path)

    let fd: number
    try { fd = openSync(path, 'r') } catch { continue }
    try {
      while (offset < size) {
        const r = readSlice(fd, offset, size, read)
        if (r.consumed === 0) break
        const f = r.file
        facts.sessionId ??= f.sessionId
        if (!facts.cwd && f.cwd) { facts.cwd = f.cwd; facts.headless = f.headless }
        facts.title = f.title ?? facts.title
        facts.firstPrompt ??= f.firstPrompt
        facts.startedAt ??= f.startedAt
        facts.lastAt = f.lastAt ?? facts.lastAt
        res.seen += r.messages.length
        res.added += await writeMessages(db, r.messages, subagent, facts.sessionId ?? fallbackSession, facts.cwd ?? (fresh ? null : row!.cwd))
        offset += r.consumed
        res.bytes += r.consumed
      }
    } finally { closeSync(fd) }

    const keep = fresh ? null : row!
    const data = {
      cwd:         keep?.cwd ?? facts.cwd,
      headless:    keep?.cwd ? keep.headless : facts.headless,
      title:       facts.title ?? keep?.title ?? null,
      firstPrompt: keep?.firstPrompt ?? facts.firstPrompt,
      startedAt:   keep?.startedAt ?? facts.startedAt,
      lastAt:      facts.lastAt ?? keep?.lastAt ?? null,
      offset, size, gone: false,
    }
    if (row) await db.claudeTranscript.update({ where: { id: row.id }, data })
    else await db.claudeTranscript.create({ data: { path, sessionId: facts.sessionId ?? fallbackSession, subagent, ...data } })
    res.read++
  }

  const vanished = [...rows.values()].filter(r => !present.has(r.path) && !r.gone).map(r => r.id)
  for (let i = 0; i < vanished.length; i += KEYS)
    await db.claudeTranscript.updateMany({ where: { id: { in: vanished.slice(i, i + KEYS) } }, data: { gone: true } })
  res.gone = vanished.length
  res.ms = Math.round(performance.now() - t0)
  return res
}
