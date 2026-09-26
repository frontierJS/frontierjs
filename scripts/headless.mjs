// ============================================================
// One headless `claude -p` session per register item — what the
// loops share
//
// `fix-loop.mjs` works down the open issues and `frame-loop.mjs`
// down the open questions. Everything that measured well in the
// first is here so the second inherits it rather than copying it:
// the session flags, the stream, the Stop-hook baseline, the
// per-attempt log, the effort ladder, and the lookups a pre-brief
// is built from. What each loop does with an item — how it is
// picked, briefed, and read back as done — stays in the loop.
// ============================================================

import { spawn, spawnSync }                                     from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync }             from 'node:fs'
import { homedir }                                              from 'node:os'
import { dirname, join }                                        from 'node:path'
import { createInterface }                                      from 'node:readline'
import { fileURLToPath }                                        from 'node:url'

export const ROOT    = dirname(dirname(fileURLToPath(import.meta.url)))
export const LOG_DIR = join(homedir(), '.fli')

// An item that does not finish is retried once on the next rung. The outcome is
// checkable, so paying for high effort only where low failed is cheaper per
// finished item than running everything high. Model and effort are set per
// session, never inside one, since a mid-session change drops the prompt cache.
export const LADDER = [{ model: 'opus', effort: 'low' }, { model: 'opus', effort: 'high' }]

const STOP_HOOK = join(ROOT, '.claude', 'hooks', 'fli-done-stop.mjs')
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
 * `phaseOf(toolUse, edited)` names the phase a call belongs to and `phases` is
 * the starting tally; both are the loop's, since what counts as proving a fix
 * and verifying a framing differ.
 */
export function runSession(prompt, { model, effort, cap, permission, tag, phases, phaseOf }) {
  // Not awaited: it takes ~25s, and a session spends longer than that reading
  // before its first edit. Lost the race, the session's own item goes unshown —
  // which is the backstop only, since each skill runs `fli done` itself.
  const baseline = spawn('node', [STOP_HOOK, '--baseline'], { cwd: ROOT, stdio: ['pipe', 'ignore', 'ignore'] })
  baseline.stdin.end('{}')
  const baselined = new Promise(r => baseline.on('close', r))

  const child = spawn('claude', [
    '-p', prompt,
    '--model',           model,
    '--effort',          effort,
    '--output-format',   'stream-json',
    '--verbose',
    '--max-budget-usd',  String(cap),
    '--permission-mode', permission,
    '--setting-sources', 'project,local',
    '--strict-mcp-config',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] })

  let result   = {}
  let edited   = false
  const tally  = { ...phases }
  createInterface({ input: child.stdout }).on('line', line => {
    let event
    try { event = JSON.parse(line) } catch { return }
    if (event.type === 'result') result = event
    if (event.type !== 'assistant') return
    for (const part of event.message?.content ?? []) {
      if (part.type !== 'tool_use') continue
      edited ||= writes(part)
      const phase = phaseOf(part, edited)
      tally[phase] = (tally[phase] ?? 0) + 1
      console.log(`[${tag}]     ${part.name}: ${describe(part.input)}`)
    }
  })

  return new Promise(done => child.on('close', async code => {
    await baselined
    if (!result.type) console.log(`[${tag}]   claude ended with no result (exit ${code})`)
    done({
      cost:    result.total_cost_usd ?? 0,
      turns:   result.num_turns,
      stop:    result.subtype,
      denied:  result.permission_denials?.length ?? 0,
      report:  result.result ?? '',
      phases:  tally,
      minutes: result.duration_ms ? +(result.duration_ms / 60000).toFixed(1) : null,
    })
  }))
}

// A heuristic over the command text: a Bash call that writes a source or
// register file counts as the first edit as much as an Edit does.
export function writes(part) {
  if (['Edit', 'Write', 'NotebookEdit'].includes(part.name)) return true
  return part.name === 'Bash' && /\bsed -i\b|python3? - <<|\btee\b|(^|[^0-9&>])>\s*[^&\s/][^\s]*\.(m?[jt]s|md|lite|mesa|json)\b/.test(part.input?.command ?? '')
}

function describe(input = {}) {
  const text = input.description ?? input.file_path ?? input.pattern ?? input.skill ?? input.command ?? input.prompt ?? ''
  return String(text).split('\n')[0].slice(0, 110)
}

// One line per attempt: cost per SOLVED item is the number to tune the budget
// and LADDER against, and it is read off this file rather than a transcript.
export function printAttempt(tag, { model, effort }, outcome, run) {
  const split = Object.entries(run.phases).map(([k, n]) => `${k} ${n}`).join(' · ')
  console.log(`[${tag}]   ${model}/${effort}: ${outcome} · $${run.cost.toFixed(2)} · ${run.minutes ?? '?'} min · ${run.turns ?? '?'} turns (${split})${run.denied ? ` · ${run.denied} tool calls denied` : ''}`)
  if (run.report) console.log(run.report.trim().split('\n').map(l => `[${tag}]   │ ${l}`).join('\n'))
}

// ─── the log ────────────────────────────────────────────────

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

// ─── lookups a pre-brief is built from ──────────────────────

// This checkout's own fli, under the runtime running this script. A bare `fli`
// is whatever global install the machine has, which is a different build.
export function fli(argv) {
  const out = spawnSync(process.execPath, [FLI, ...argv], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
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
  console.log(lines.slice(3, lines.indexOf(lines[2], 3)).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))
}
