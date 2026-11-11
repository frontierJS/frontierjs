// api/src/domain/charter/live-record.ts
// The record Charter's builder/live.ts rewrites after every stage,
// runs/<date>-live-<case>.json, read on Workbench's side (FJS-D2025: nothing
// leaves Charter, so this file is the only place the shape is known here).
//
// A record names its version as `live` and its six stages by name. One this
// file does not know is refused by name rather than drawn half-right: a stage
// added in Charter would otherwise vanish from the page while the run reads as
// done.
//
// A record with no `finishedAt` is running only while its `pid` is still a
// live.ts process. A run killed mid-stage never writes `finishedAt`, and read
// on its own that record would say running forever.

import { spawnSync } from 'node:child_process'

export const LIVE_VERSIONS = [1] as const
export const STAGES        = ['charter', 'generate', 'feature', 'deploy', 'use', 'clean'] as const
export const OUTCOMES      = ['passed', 'failed', 'skipped', 'not reached'] as const

export type Stage   = (typeof STAGES)[number]
export type Outcome = (typeof OUTCOMES)[number]

export type StageRecord = {
  outcome:       Outcome
  ms:            number
  costUsd?:      number
  detail:        string
  afterFailure?: Stage
}

/** What the page draws; the rest of the record stays in Charter. */
export type LiveRecord = {
  live:        (typeof LIVE_VERSIONS)[number]
  case:        string
  charter:     string
  date:        string
  keep:        boolean
  from?:       Stage
  startedAt:   string
  finishedAt?: string
  pid?:        number
  outcome?:    'passed' | 'failed'
  costUsd?:    number
  stages:      Record<Stage, StageRecord>
  deploy?:     { basecamp?: string, appName?: string, appId?: string, hostname?: string | null }
}

/** running: the process is live. stopped: no finishedAt and the process is gone. */
export type LiveState = 'running' | 'passed' | 'failed' | 'stopped'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str   = (v: unknown) => typeof v === 'string' ? v : undefined
const num   = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** The record in `text` (read from `where`), or why it is refused. */
export function readLiveRecord(text: string, where: string): LiveRecord | { refused: string } {
  let raw: unknown
  try { raw = JSON.parse(text) } catch (e) { return { refused: `${where} is not JSON: ${(e as Error).message}` } }
  if (!isObj(raw)) return { refused: `${where} is not a live record: not an object` }

  if (!(LIVE_VERSIONS as readonly unknown[]).includes(raw.live)) {
    return { refused: `${where} is live record version ${JSON.stringify(raw.live ?? null)}, and Workbench reads ${LIVE_VERSIONS.join(', ')}` }
  }
  if (!isObj(raw.stages)) return { refused: `${where} has no stages` }
  const unknown = Object.keys(raw.stages).filter(s => !(STAGES as readonly string[]).includes(s))
  if (unknown.length) return { refused: `${where} names stage${unknown.length > 1 ? 's' : ''} ${unknown.map(s => `'${s}'`).join(', ')}, which Workbench does not know (it knows ${STAGES.join(', ')})` }

  const stages = {} as Record<Stage, StageRecord>
  for (const s of STAGES) {
    const r = raw.stages[s]
    if (!isObj(r)) return { refused: `${where} is missing stage '${s}'` }
    if (!(OUTCOMES as readonly unknown[]).includes(r.outcome)) return { refused: `${where} gives stage '${s}' the outcome ${JSON.stringify(r.outcome ?? null)}, which Workbench does not know` }
    const after = str(r.afterFailure)
    stages[s] = {
      outcome: r.outcome as Outcome,
      ms:      num(r.ms) ?? 0,
      detail:  str(r.detail) ?? '',
      ...(num(r.costUsd) != null ? { costUsd: num(r.costUsd) } : {}),
      ...(after && (STAGES as readonly string[]).includes(after) ? { afterFailure: after as Stage } : {}),
    }
  }

  const name = str(raw.case), startedAt = str(raw.startedAt), date = str(raw.date)
  if (!name || !startedAt || !date) return { refused: `${where} is missing ${!name ? 'case' : !startedAt ? 'startedAt' : 'date'}` }
  const from = str(raw.from)
  const d    = isObj(raw.deploy) ? raw.deploy : null
  return {
    live: raw.live as LiveRecord['live'], case: name, charter: str(raw.charter) ?? '', date, keep: raw.keep === true,
    startedAt,
    stages,
    ...(from && (STAGES as readonly string[]).includes(from) ? { from: from as Stage } : {}),
    ...(str(raw.finishedAt) ? { finishedAt: str(raw.finishedAt) } : {}),
    ...(num(raw.pid) != null ? { pid: num(raw.pid) } : {}),
    ...(raw.outcome === 'passed' || raw.outcome === 'failed' ? { outcome: raw.outcome } : {}),
    ...(num(raw.costUsd) != null ? { costUsd: num(raw.costUsd) } : {}),
    ...(d ? { deploy: { basecamp: str(d.basecamp), appName: str(d.appName), appId: str(d.appId), hostname: str(d.hostname) ?? null } } : {}),
  }
}

/** Whether `pid` is a process running builder/live.ts on this machine. */
export function runsLive(pid: number): boolean {
  // A pid alone can be reused by an unrelated process after the run died.
  const out = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })
  return out.status === 0 && out.stdout.includes('builder/live.ts')
}

/** passed or failed once finished; otherwise running only while its process is. */
export function stateOf(r: LiveRecord, alive: (pid: number) => boolean = runsLive): LiveState {
  if (r.finishedAt) return r.outcome === 'passed' ? 'passed' : 'failed'
  return r.pid != null && alive(r.pid) ? 'running' : 'stopped'
}
