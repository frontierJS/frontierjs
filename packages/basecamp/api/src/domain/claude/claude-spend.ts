// src/domain/claude/claude-spend.ts — the usage index, read as spend.
//
// What `claude.service.ts` answers `stats`, `insights` and `sessions` with. The
// rows are `ClaudeMessage` / `ClaudeTranscript` (`claude-index.ts` writes them),
// and the shape of every read is the same: the database groups and sums, then
// the sums are priced here, because a price is a function of the MODEL and the
// table has one row per message — so the groups always carry `model`, and a
// total over models is a fold of priced groups, never a price of the total.
//
// **Cost is the sum of the PRICED groups.** A model `claude-pricing.ts` has no
// row for contributes its tokens to `unpricedTokens` and nothing to `cost`, so a
// number is never a guess and never silently low.
//
// **A day is the machine's local day**, the reading `fli git:history` gives, so a
// reply and the commit it made land in one column.

import { costOf, READ_ON, SOURCE_URL } from './claude-pricing.ts'

/** A system or request client; every read here goes through litestone's `groupBy`, never raw SQL. */
type Db = any

const DAY = 86_400_000

export interface Spend {
  messages:       number
  input:          number
  cacheWrite:     number
  cacheRead:      number
  output:         number
  /** Dollars at list price, priced models only. */
  cost:           number
  /** Tokens of models with no published price: in none of `cost`. */
  unpricedTokens: number
}

export const zero = (): Spend => ({ messages: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, unpricedTokens: 0 })

const SUMS = { input: true, cacheWrite: true, cacheWrite1h: true, cacheRead: true, output: true }

interface Group { [key: string]: unknown, _count: number, _sum: Record<string, number | null> }

/** One group's sums as a `Spend`, priced as its model's. */
function spendOf(model: string, g: Group): Spend {
  const s = g._sum
  const m = { model, input: s.input ?? 0, cacheWrite: s.cacheWrite ?? 0, cacheWrite1h: s.cacheWrite1h ?? 0, cacheRead: s.cacheRead ?? 0, output: s.output ?? 0 }
  const cost = costOf(m, { tiered: false })
  return {
    messages: g._count, input: m.input, cacheWrite: m.cacheWrite, cacheRead: m.cacheRead, output: m.output,
    cost: cost ?? 0,
    unpricedTokens: cost === null ? m.input + m.cacheWrite + m.cacheRead + m.output : 0,
  }
}

export function add(into: Spend, s: Spend): Spend {
  into.messages += s.messages; into.input += s.input; into.cacheWrite += s.cacheWrite
  into.cacheRead += s.cacheRead; into.output += s.output; into.cost += s.cost; into.unpricedTokens += s.unpricedTokens
  return into
}

/** `by` keys with `model` always among them: priced groups folded by the first key. */
async function grouped(db: Db, by: string[], where: object, extra: object = {}): Promise<Group[]> {
  return db.claudeMessage.groupBy({ by: by.includes('model') ? by : [...by, 'model'], where, _count: true, _sum: SUMS, ...extra })
}

function foldBy(groups: Group[], key: string): Map<string, Spend> {
  const out = new Map<string, Spend>()
  for (const g of groups) {
    const k = String(g[key] ?? '')
    add(out.get(k) ?? out.set(k, zero()).get(k)!, spendOf(String(g.model), g))
  }
  return out
}

const byCost = <T extends { cost: number, output: number }>(a: T, b: T) => b.cost - a.cost || b.output - a.output

/** Local midnight `days - 1` days ago, so a window of N days is N whole day columns. */
export function windowStart(days: number, now = new Date()): Date {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (days - 1))
  return d
}

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

async function indexedAt(db: Db): Promise<string | null> {
  const row = await db.claudeTranscript.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } })
  return row ? new Date(row.updatedAt).toISOString() : null
}

export interface Stats {
  window:    { days: number, from: string | null }
  totals:    Spend & { sessions: number }
  days:      Array<Spend & { day: string, sessions: number }>
  models:    Array<Spend & { model: string }>
  projects:  Array<Spend & { cwd: string }>
  indexedAt: string | null
  pricing:   { sourceUrl: string, readOn: string }
}

/** Per local day, per model and per project over `days` (0 = all of it). */
export async function readStats(db: Db, days: number): Promise<Stats> {
  const from  = days > 0 ? windowStart(days) : null
  const where = from ? { at: { gte: from.toISOString() } } : {}
  const tz    = timeZone()

  const [byDay, byModel, byProject, started, active] = await Promise.all([
    grouped(db, ['at'], where, { interval: { at: 'day' }, timeZone: tz, fillGaps: false, orderBy: { at: 'asc' } }),
    grouped(db, ['model'], where),
    grouped(db, ['cwd'], where),
    db.claudeTranscript.groupBy({
      by: ['startedAt'], interval: { startedAt: 'day' }, timeZone: tz, fillGaps: false, orderBy: { startedAt: 'asc' }, _count: true,
      where: { subagent: false, ...(from ? { startedAt: { gte: from.toISOString() } } : {}) },
    }) as Promise<Array<{ startedAt: string, _count: number }>>,
    db.claudeTranscript.count({ where: { subagent: false, ...(from ? { lastAt: { gte: from.toISOString() } } : {}) } }) as Promise<number>,
  ])

  const sessionsOn = new Map(started.map(r => [r.startedAt, r._count]))
  const dayRows = [...foldBy(byDay, 'at')].map(([day, s]) => ({ day, ...s, sessions: sessionsOn.get(day) ?? 0 }))
  const models  = [...foldBy(byModel, 'model')].map(([model, s]) => ({ model, ...s })).sort(byCost)
  const projects = [...foldBy(byProject, 'cwd')].map(([cwd, s]) => ({ cwd, ...s })).sort(byCost)
  const totals = models.reduce((t, m) => add(t, m), zero())

  return {
    window: { days, from: from ? from.toISOString() : null },
    totals: { ...totals, sessions: active },
    days: dayRows,
    models, projects,
    indexedAt: await indexedAt(db),
    pricing: { sourceUrl: SOURCE_URL, readOn: READ_ON },
  }
}

export const INSIGHT_WINDOWS = { '24h': DAY, '7d': 7 * DAY } as const
export type InsightWindow = keyof typeof INSIGHT_WINDOWS

interface Share { cost: number, share: number, messages: number }

export interface Insights {
  window:         InsightWindow
  /** Dollars across the priced messages the shares divide. */
  cost:           number
  unpricedTokens: number
  messages:       number
  projects:       Array<Share & { cwd: string }>
  models:         Array<Share & { model: string }>
  tools:          Array<Share & { tool: string }>
  indexedAt:      string | null
  pricing:        { sourceUrl: string, readOn: string }
}

export const NO_TOOL = '(no tool)'

/**
 * Share of cost-weighted use per project, model and tool. A message's cost is
 * split EVENLY across the tools it called (none → `(no tool)`), subagent
 * messages included — a group's messages all name the same tools, so splitting
 * the group is splitting each of them.
 */
export async function readInsights(db: Db, window: InsightWindow, now = Date.now()): Promise<Insights> {
  const where  = { at: { gte: new Date(now - INSIGHT_WINDOWS[window]).toISOString() } }
  const groups = await grouped(db, ['tools', 'cwd'], where)

  const projects = new Map<string, Share>(), models = new Map<string, Share>(), tools = new Map<string, Share>()
  const put = (m: Map<string, Share>, k: string, cost: number, messages: number) => {
    const s = m.get(k) ?? m.set(k, { cost: 0, share: 0, messages: 0 }).get(k)!
    s.cost += cost; s.messages += messages
  }
  let cost = 0, unpricedTokens = 0, messages = 0
  for (const g of groups) {
    const s = spendOf(String(g.model), g)
    messages += s.messages
    unpricedTokens += s.unpricedTokens
    cost += s.cost
    put(projects, String(g.cwd ?? ''), s.cost, s.messages)
    put(models, String(g.model), s.cost, s.messages)
    const names = String(g.tools ?? '').split(',').filter(Boolean)
    const list = names.length ? names : [NO_TOOL]
    for (const t of list) put(tools, t, s.cost / list.length, s.messages / list.length)
  }

  const rank = <K extends string>(m: Map<string, Share>, key: K) =>
    [...m].map(([k, s]) => ({ [key]: k, ...s, share: cost ? s.cost / cost : 0 }) as Share & Record<K, string>)
      .sort((a, b) => b.cost - a.cost || b.messages - a.messages)

  return {
    window, cost, unpricedTokens, messages,
    projects: rank(projects, 'cwd'), models: rank(models, 'model'), tools: rank(tools, 'tool'),
    indexedAt: await indexedAt(db),
    pricing: { sourceUrl: SOURCE_URL, readOn: READ_ON },
  }
}

export interface SessionRow extends Spend {
  sessionId:   string
  title:       string | null
  firstPrompt: string | null
  startedAt:   string | null
  lastAt:      string | null
  /** The transcript file is gone from disk; the rows are all that is left. */
  gone:        boolean
  /** Transcript files of the agents this session spawned. */
  subagents:   number
}

export interface Sessions {
  projects:  Array<{ cwd: string | null, sessions: SessionRow[] }>
  indexedAt: string | null
  pricing:   { sourceUrl: string, readOn: string }
}

const KEYS = 400
const chunks = <T>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / KEYS) }, (_, i) => xs.slice(i * KEYS, (i + 1) * KEYS))

/**
 * Sessions per project, newest first. A session's spend includes its subagents'
 * (their messages carry the parent's `sessionId`).
 */
export async function readSessions(db: Db, { cwd, limit }: { cwd?: string, limit?: number } = {}): Promise<Sessions> {
  const rows: any[] = await db.claudeTranscript.findMany({
    where: { subagent: false, ...(cwd ? { cwd } : {}) },
    orderBy: { lastAt: 'desc' }, limit: limit ?? 200,
    select: { sessionId: true, cwd: true, title: true, firstPrompt: true, startedAt: true, lastAt: true, gone: true },
  })
  const ids = rows.map(r => r.sessionId as string)
  const spend = new Map<string, Spend>(), agents = new Map<string, number>()
  for (const part of chunks(ids)) {
    for (const g of await grouped(db, ['sessionId'], { sessionId: { in: part } }))
      add(spend.get(String(g.sessionId)) ?? spend.set(String(g.sessionId), zero()).get(String(g.sessionId))!, spendOf(String(g.model), g))
    const subs: Array<{ sessionId: string, _count: number }> =
      await db.claudeTranscript.groupBy({ by: ['sessionId'], where: { subagent: true, sessionId: { in: part } }, _count: true })
    for (const s of subs) agents.set(s.sessionId, s._count)
  }

  const out = new Map<string, SessionRow[]>()
  for (const r of rows) {
    const key = r.cwd ?? ''
    const row: SessionRow = {
      sessionId: r.sessionId, title: r.title, firstPrompt: r.firstPrompt,
      startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
      lastAt: r.lastAt ? new Date(r.lastAt).toISOString() : null,
      gone: !!r.gone, subagents: agents.get(r.sessionId) ?? 0,
      ...(spend.get(r.sessionId) ?? zero()),
    }
    ;(out.get(key) ?? out.set(key, []).get(key)!).push(row)
  }
  return {
    projects: [...out].map(([k, sessions]) => ({ cwd: k || null, sessions })),
    indexedAt: await indexedAt(db),
    pricing: { sourceUrl: SOURCE_URL, readOn: READ_ON },
  }
}
