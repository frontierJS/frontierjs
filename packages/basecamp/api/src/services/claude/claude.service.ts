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
// `context`, `account` and `quota` answer `{ ok, value }` or `{ ok: false, reason }`: Claude Code changes
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
// added there shows here on the next call. `file` scans again rather than
// trusting a path the browser remembers: only a file this scan lists is read.

import { createService, BadRequest, NotFound, $ } from '@frontierjs/junction'
import { LEVELS }                  from '@frontierjs/litestone'
import { WORKSPACE_QUERY }         from '../../core/hooks.ts'
import { localMachineRefusal }     from '../../core/env.ts'
import { readListedFile, scanClaude } from '../../domain/claude/claude-scan.ts'
import { contextFor }              from '../../domain/claude/claude-context.ts'
import { fetchUsage }              from '../../domain/claude/claude-quota.ts'
import { readTranscript }          from '../../domain/claude/claude-transcript.ts'
import { claudeAuthStatus }        from '../../domain/local/local-claude.ts'
import { INSIGHT_WINDOWS, readInsights, readSessions, readStats, type InsightWindow } from '../../domain/claude/claude-spend.ts'

function offered() {
  const refused = localMachineRefusal()
  if (refused) throw new NotFound(`Claude Code is ${refused}`)
}

const body = (): Record<string, unknown> => ($.data ?? {}) as Record<string, unknown>
const db   = (): any => $.db

const scan = () => scanClaude({ pinPaths: $.app.workbench.readPins().map(p => p.path) })

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
  ],

  async config() {
    offered()
    return scan()
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
})
