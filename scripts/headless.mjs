// ============================================================
// One headless `claude -p` session per register item — what the
// loops share
//
// `fix-loop.mjs` works down the open issues and `frame-loop.mjs`
// down the open questions. Everything that measured well in the
// first is here so the second inherits it rather than copying it:
// the session flags, the stream, the per-attempt log, the effort
// ladder, and the lookups a pre-brief is built from. What each loop does with an item — how it is
// picked, briefed, and read back as done — stays in the loop.
// ============================================================

import { spawnSync }                                           from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync }             from 'node:fs'
import { stateDir }                                             from '../packages/cli/core/paths.js'
import { dirname, join }                                        from 'node:path'
import { fileURLToPath }                                        from 'node:url'
import { fetchUsage, runAsk }                                  from '../packages/claude/index.ts'

import { SOURCE, LOOPS, logFiles, readSchedule, spentToday, overDayCap } from '../packages/cli/core/autopilot.js'

export const ROOT    = dirname(dirname(fileURLToPath(import.meta.url)))
export const LOG_DIR = stateDir()

/** A loop's own log under LOG_DIR; the names are the schedule reader's (`LOG_NAMES`). */
export const logOf = loop => join(LOG_DIR, LOOPS[loop].log)

// An item that does not finish is retried once on the next rung. The outcome is
// checkable, so paying for high effort only where low failed is cheaper per
// finished item than running everything high. Model and effort are set per
// session, never inside one, since a mid-session change drops the prompt cache.
export const LADDER = [{ model: 'opus', effort: 'low' }, { model: 'opus', effort: 'high' }]

const FLI       = join(ROOT, 'packages', 'cli', 'bin', 'fli.js')

// ─── the session ────────────────────────────────────────────

/**
 * Run one session and answer what it cost and where its turns went.
 *
 * Project settings only and no MCP servers: a user plugin's skills and a
 * connector's tools are context every turn pays for and no loop item uses. It
 * streams, printing each tool call as it happens, because a session runs for
 * minutes and one JSON answer at the end is indistinguishable from a hang.
 *
 * `where` heads every waiting line (`FJS-1036 [4/5]`), since a long wait
 * scrolls the item's own header out of view.
 *
 * `phaseOf(toolUse, edited)` names the phase a call belongs to and `phases` is
 * the starting tally; both are the loop's, since what counts as proving a fix
 * and verifying a framing differ.
 *
 * `cwd`, `addDirs` and `env` are a lane's (`lanes.mjs`): its worktree, the
 * main tree its linked register lives in, and its own `fli` first on PATH.
 */
export function runSession(prompt, { model, effort, cap, permission, tag, phases, phaseOf, where = '', cwd = ROOT, addDirs = [], env = {} }) {
  let result   = {}
  let session  = null
  let edited   = false
  const errors = {}                       // tool name → failed calls
  let transient = 0                       // calls the auto-mode check answered with no verdict
  const tally  = { ...phases }

  // A silent stretch is either a tool running, which costs nothing, or the
  // model holding the turn, which is what the budget pays for; from outside
  // the two look the same, so the heartbeat names which one it is.
  // A beat per two whole minutes of one state, checked often so a stretch
  // that starts mid-interval is not left unreported for nearly four.
  const BEAT_S  = 120
  const pending = new Map()               // tool_use id → { name, at }
  let turnAt    = Date.now()
  let told      = { at: 0, beats: 0 }
  const beat    = setInterval(() => {
    const [call]  = pending.values()
    const since   = call?.at ?? turnAt
    const s       = Math.round((Date.now() - since) / 1000)
    const beats   = Math.floor(s / BEAT_S)
    if (told.at !== since) told = { at: since, beats: 0 }
    if (beats <= told.beats) return
    told.beats = beats
    console.log(`[${tag}]       … ${where ? `${where} - ` : ''}${call ? `${call.name} running` : 'model thinking'} ${clock(s)}`)
  }, 5_000)

  const onFrame = event => {
    if (event.type === 'result') result = event
    if (event.type === 'system' && event.subtype === 'init') session = event.session_id
    if (event.type === 'user') for (const part of event.message?.content ?? []) {
      if (part.type !== 'tool_result' || !pending.has(part.tool_use_id)) continue
      const s = Math.round((Date.now() - pending.get(part.tool_use_id).at) / 1000)
      if (part.is_error) errors[pending.get(part.tool_use_id).name] = (errors[pending.get(part.tool_use_id).name] ?? 0) + 1
      if (part.is_error && NO_VERDICT.test(resultText(part))) transient++
      pending.delete(part.tool_use_id)
      if (s >= 5) console.log(`[${tag}]       ↳ ${where ? `${where} - ` : ''}${clock(s)}${part.is_error ? ' · error' : ''}`)
      if (!pending.size) turnAt = Date.now()
    }
    if (event.type !== 'assistant') return
    for (const part of event.message?.content ?? []) {
      if (part.type !== 'tool_use') continue
      pending.set(part.id, { name: part.name, at: Date.now() })
      edited ||= writes(part)
      const phase = phaseOf(part, edited)
      tally[phase] = (tally[phase] ?? 0) + 1
      console.log(`[${tag}]     ${part.name}: ${describe(part.input, cwd)}`)
    }
  }

  // The Stop hook is off: each skill runs `fli done` as its own step, and the
  // hook was that report a second time, after a `--baseline` run of it before
  // the session, at forty seconds each.
  const run = runAsk({
    root: cwd, prompt, model, effort, work: { budget: cap, hooks: true, permission, settingSources: 'project,local', mcp: false, addDirs },
    env: { ...process.env, FLI_DONE_STOP: 'off', ...env }, onFrame,
    onEvent: e => { if (e.type === 'error') console.log(`[${tag}]   ${e.text.split('\n').join(`\n[${tag}]   `)}`) },
  })
  if ('error' in run) { clearInterval(beat); throw new Error(run.error) }

  return run.done.then(code => {
    clearInterval(beat)
    if (!result.type) console.log(`[${tag}]   claude ended with no result (exit ${code})`)
    return {
      cost:    result.total_cost_usd ?? 0,
      turns:   result.num_turns,
      stop:    result.subtype,
      denied:  result.permission_denials?.length ?? 0,
      sessionId:   result.session_id ?? session,
      deniedTools: (result.permission_denials ?? []).map(d => d.tool_name),
      errors,
      transient,
      edited,
      usage:   result.usage && {
        input:      result.usage.input_tokens,
        cacheWrite: result.usage.cache_creation_input_tokens,
        cacheRead:  result.usage.cache_read_input_tokens,
        output:     result.usage.output_tokens,
      },
      report:  result.result ?? '',
      phases:  tally,
      minutes: result.duration_ms ? +(result.duration_ms / 60000).toFixed(1) : null,
    }
  })
}

// A heuristic over the command text: a Bash call that writes a source or
// register file counts as the first edit as much as an Edit does.
export function writes(part) {
  if (['Edit', 'Write', 'NotebookEdit'].includes(part.name)) return true
  return part.name === 'Bash' && /\bsed -i\b|python3? - <<|\btee\b|(^|[^0-9&>])>\s*[^&\s/][^\s]*\.(m?[jt]s|md|lite|mesa|json)\b/.test(part.input?.command ?? '')
}

// The auto-mode classifier failing to answer, which says nothing about the call.
const NO_VERDICT = /classifier gave no verdict|transient failure of the check/i

function resultText(part) {
  return typeof part.content === 'string' ? part.content : (part.content ?? []).map(c => c.text ?? '').join(' ')
}

function clock(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Sessions run at their root yet prefix most commands with a cd to it; the
// path is the same on every line and pushes the command itself past the cut.
export function atRoot(text, root = ROOT) {
  const cd = new RegExp(`^cd ['"]?${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*(&&|;)\\s*`)
  return text.replace(cd, '').replaceAll(`${root}/`, '')
}

function describe(input = {}, root) {
  const text = input.description ?? input.file_path ?? input.pattern ?? input.skill ?? input.command ?? input.prompt ?? ''
  return atRoot(String(text).split('\n')[0], root).slice(0, 110)
}

// One line per attempt: cost per SOLVED item is the number to tune the budget
// and LADDER against, and it is read off this file rather than a transcript.
export function printAttempt(tag, { model, effort }, outcome, run) {
  const split = Object.entries(run.phases).map(([k, n]) => `${k} ${n}`).join(' · ')
  console.log(`[${tag}]   ${model}/${effort}: ${outcome} · $${run.cost.toFixed(2)} · ${run.minutes ?? '?'} min · ${run.turns ?? '?'} turns (${split})${run.denied ? ` · ${run.denied} tool calls denied` : ''}`)
  if (run.report) console.log(run.report.trim().split('\n').map(l => `[${tag}]   │ ${l}`).join('\n'))
}

// ─── the log ────────────────────────────────────────────────

// What `loop-review.mjs` needs to find an attempt's transcript and read why it
// went the way it did, without every loop spelling the fields out.
export function trace(run) {
  return {
    sessionId:   run.sessionId,
    errors:      Object.keys(run.errors).length ? run.errors : undefined,
    deniedTools: run.deniedTools.length ? run.deniedTools : undefined,
    usage:       run.usage,
    report:      run.report ? run.report.trim().slice(-500) : undefined,
  }
}

export function appendLog(file, entry) {
  mkdirSync(LOG_DIR, { recursive: true })
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
}

/** Every entry, oldest first; a missing log is an empty one. */
export function readLog(file) {
  let lines = []
  try { lines = readFileSync(file, 'utf8').trim().split('\n') } catch {}
  return lines.map(l => { try { return JSON.parse(l) } catch { return {} } })
}

/** The last entry the log holds for `id`, or undefined. */
export function lastEntry(file, id) {
  return readLog(file).filter(e => e.id === id).at(-1)
}

// Busy is a collision and an interrupted run no verdict, so neither counts;
// blocked, failed and corrected each mean a session looked and handed the row
// back. Two is the bar: fix-loop stops picking such a row, and loop-review
// counts it against its package.
export function sentBack(id, log) {
  const verdicts = log.filter(e => e.id === id && e.cost !== undefined && e.outcome && !['closed', 'busy'].includes(e.outcome)).map(e => e.outcome)
  return verdicts.length >= 2 ? verdicts : null
}

// ─── lookups a pre-brief is built from ──────────────────────

// This checkout's own fli, under the runtime running this script. A bare `fli`
// is whatever global install the machine has, which is a different build.
export function fli(argv, cwd = ROOT) {
  const out = spawnSync(process.execPath, [FLI, ...argv], { cwd, encoding: 'utf8', maxBuffer: 64 << 20 })
  if (out.status !== 0) throw new Error(`fli ${argv[0]} failed: ${out.stderr}`)
  return out.stdout
}

// A user's ~/.ripgreprc (--smart-case, --max-columns) would change what matches and truncate a citation.
export function rg(argv) {
  const out = spawnSync('rg', ['--no-config', ...argv], { cwd: ROOT, encoding: 'utf8' })
  return out.stdout ? out.stdout.trim().split('\n').filter(Boolean) : []
}

/** What a ruling or a row says, in one line, and which register holds it. */
export function citation(id) {
  const anchor = `id="${id.toLowerCase()}"`
  for (const file of ['DECISIONS.md', 'ISSUES.md', 'ISSUES_ARCHIVE.md']) {
    const hit = rg(['-F', '--no-filename', '--max-count', '1', anchor, file])[0]
    if (!hit) continue
    const said = /\*\*(.+?)\*\*/.exec(hit)?.[1] ?? hit.replace(/^#+\s*<a[^>]*><\/a>/, '').replace(/^.*?—\s*/, '')
    return `${said.slice(0, 220)}${said.length > 220 ? '…' : ''} (${file})`
  }
  return null
}

// ─── --source ───────────────────────────────────────────────

/** `--source autopilot` or nothing: a scheduled run is a hand run in the log plus this field, and any other value is refused by name. */
export function sourceOf(args) {
  if (args.source === undefined) return undefined
  if (args.source !== SOURCE) { console.error(`--source takes '${SOURCE}' and nothing else; a hand run names no source`); process.exit(1) }
  return SOURCE
}

// A scheduled run holds the day's cap itself, off the schedule file and the
// logs, so the cap holds with the Basecamp that started it down. Answers why
// one more attempt is refused, or null; a hand run is never refused.
export function dayCapRefusal(source, logs = logFiles(LOG_DIR)) {
  if (source !== SOURCE) return null
  let schedule
  try { schedule = readSchedule() } catch (err) { return err.message }
  if (!schedule.exists) return `${schedule.file} does not exist, and a scheduled run reads its day cap there`
  return overDayCap(schedule.day, spentToday(logs.flatMap(readLog)))
}

// ─── arguments ──────────────────────────────────────────────

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '')
    const val = argv[i + 1]
    if (val === undefined || val.startsWith('--')) out[key] = true
    else { out[key] = val; i++ }
  }
  return out
}

// A loop's usage is its own header block, between the first two rule lines.
export function printHelp(url) {
  const lines = readFileSync(fileURLToPath(url), 'utf8').split('\n')
  const open  = lines.findIndex(l => /^\/\/ ={10,}/.test(l))
  const close = lines.indexOf(lines[open], open + 1)
  console.log(lines.slice(open + 1, close).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))
}

// ─── plan usage ─────────────────────────────────────────────

// What /usage reads, through `@frontierjs/claude`'s `fetchUsage`: the one
// reader of the login token. A failure answers null and the loop prints
// nothing rather than dying at its last line.
export async function planUsage() {
  const q = await fetchUsage({ force: true })
  return q.ok ? q.value : null
}

// The session and weekly windows, then each model's weekly, by name.
const meters = q => [
  ...(q.session ? [['session', q.session]] : []),
  ...(q.weekly ? [['weekly', q.weekly]] : []),
  ...q.models.map(m => [`weekly (${m.label})`, m]),
]

// A window whose resetsAt moved between the two reads rolled over mid-loop,
// so its delta would be a lie and is left out.
export function printPlanUsage(tag, label, quota, before) {
  if (!quota) return
  const min  = t => Math.floor(Date.parse(t) / 60_000)
  const prev = new Map(before ? meters(before) : [])
  for (const [name, m] of meters(quota)) {
    const was  = prev.get(name)
    const diff = !was ? '' : min(was.resetsAt) !== min(m.resetsAt) ? ' · window reset' : ` · ${m.utilization - was.utilization >= 0 ? '+' : ''}${m.utilization - was.utilization}%`
    console.log(`[${tag}] ${label} ${name}: ${m.utilization}%${diff} · resets ${m.resetsAt ? new Date(m.resetsAt).toLocaleString() : '—'}`)
  }
}
