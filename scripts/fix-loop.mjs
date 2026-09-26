#!/usr/bin/env node
// ============================================================
// Work down the open register, one row per headless session
//
//   bun run fix:loop                       # up to 5 rows
//   bun run fix:loop -- --rows 10 --pkg sierra
//   bun run fix:loop -- --budget 3 --dry-run
//
// Each row runs `/fix-next <id>` in a FRESH `claude -p` session at low
// effort, and a row that does not close is retried once at high effort — the
// outcome is checkable (the row moves to § Closed or it does not), so paying
// for high effort only on the rows that need it is cheaper per solved row than
// running everything high. Effort is set per session, never changed inside
// one, since a mid-session change drops the prompt cache.
//
// Whether a row closed is read off ISSUES.md, not off what the session says:
// a session can report success over a row it never moved. The session's last
// line (`fix-next: <id> <status>`, written by the skill) is read only for what
// the register cannot show — a row that stopped for a ruling ends the loop,
// since every later row would be decided without the owner.
//
// The session streams (stream-json): each tool call prints one line as it
// happens, since a fix runs for minutes and a single JSON answer at the end
// is indistinguishable from a hang.
//
// One line per attempt goes to ~/.fli/fix-loop.jsonl: id, effort, cost,
// turns, outcome. Cost per SOLVED row is the number to tune --budget and the
// effort ladder against; the defaults here are guesses until that log says
// otherwise.
//
// A failed or interrupted attempt leaves its edits in the tree, and the next
// attempt at that row is told so rather than handed a clean tree — the partial
// work is usually most of the fix. Untold, the skill reads those edits as
// another session's and stops (\`busy\`), which is right for a real collision:
// a busy row is skipped, never retried at high effort. What counts as an
// earlier attempt is the log — an entry for the id whose outcome is not closed. Rows run serially; a second loop in the same tree picks the
// same top row.
// ============================================================

import { spawn, spawnSync }                         from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir }                                  from 'node:os'
import { join, dirname }                            from 'node:path'
import { createInterface }                          from 'node:readline'
import { fileURLToPath }                            from 'node:url'

const ROOT    = dirname(dirname(fileURLToPath(import.meta.url)))
const LOG_DIR = join(homedir(), '.fli')
const LOG     = join(LOG_DIR, 'fix-loop.jsonl')
const EFFORTS = ['low', 'high']

const args       = parseArgs(process.argv.slice(2))
const rows       = Number(args.rows ?? 5)
const budget     = Number(args.budget ?? 5)
const permission = args['permission-mode'] ?? 'auto'
const dryRun     = Boolean(args['dry-run'])

if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 30).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))
  process.exit(0)
}

// ─── the loop ───────────────────────────────────────────────

const skipped = new Set()
let spent     = 0
let closed    = 0

for (let n = 0; n < rows; n++) {
  const row = nextRow()
  if (!row) { console.log('[fix-loop] nothing ready'); break }

  console.log(`\n[fix-loop] ${n + 1}/${rows} ${row.id} (${row.severity}, ${row.pkg.join(' · ')}) — ${row.title.slice(0, 100)}`)
  if (dryRun) { skipped.add(row.id); continue }

  let outcome
  for (const effort of EFFORTS) {
    const prompt = attemptedBefore(row.id)
      ? `/fix-next ${row.id} — an earlier fix-loop attempt at this row did not close it; the edits under its packages in the working tree are that attempt's, so read git diff and build on them`
      : `/fix-next ${row.id}`

    log({ id: row.id, severity: row.severity, effort, outcome: 'started' })
    const run = await attempt(prompt, effort)
    outcome   = isClosed(row.id) ? 'closed' : run.status ?? 'failed'
    spent    += run.cost

    log({ id: row.id, severity: row.severity, effort, cost: run.cost, turns: run.turns, outcome, stop: run.stop, denied: run.denied })
    console.log(`[fix-loop]   ${effort}: ${outcome} · $${run.cost.toFixed(2)} · ${run.turns ?? '?'} turns${run.denied ? ` · ${run.denied} tool calls denied` : ''}`)
    if (run.report) console.log(run.report.trim().split('\n').map(l => `[fix-loop]   │ ${l}`).join('\n'))

    if (outcome !== 'failed') break
  }

  if (outcome === 'busy') console.log(`[fix-loop] ${row.id} is another session's work in progress — skipped`)

  if (outcome === 'closed') closed++
  if (outcome === 'ruling') {
    console.log(`[fix-loop] ${row.id} needs a ruling — stopping; answer it with fli decisions, then rerun`)
    break
  }
  skipped.add(row.id)
}

console.log(`\n[fix-loop] ${closed} closed · $${spent.toFixed(2)} spent · log ${LOG}`)

// ─── steps ──────────────────────────────────────────────────

function nextRow() {
  const argv = ['next', '--json', '--limit', String(rows + skipped.size + 5)]
  if (args.pkg) argv.push('--pkg', args.pkg)
  const out = spawnSync('fli', argv, { cwd: ROOT, encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`fli next failed: ${out.stderr}`)
  return JSON.parse(out.stdout).ready.find(r => !skipped.has(r.id))
}

function attempt(prompt, effort) {
  const child = spawn('claude', [
    '-p', prompt,
    '--effort',          effort,
    '--output-format',   'stream-json',
    '--verbose',
    '--max-budget-usd',  String(effort === 'low' ? budget : budget * 2),
    '--permission-mode', permission,
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] })

  let result = {}
  createInterface({ input: child.stdout }).on('line', line => {
    let event
    try { event = JSON.parse(line) } catch { return }
    if (event.type === 'result') result = event
    if (event.type !== 'assistant') return
    for (const part of event.message?.content ?? []) {
      if (part.type === 'tool_use') console.log(`[fix-loop]     ${part.name}: ${describe(part.input)}`)
    }
  })

  return new Promise(done => child.on('close', code => {
    if (!result.type) console.log(`[fix-loop]   claude ended with no result (exit ${code})`)
    const status = /fix-next: \S+ (closed|ruling|corrected|busy|failed)\s*$/.exec(result.result ?? '')?.[1]
    done({ cost: result.total_cost_usd ?? 0, turns: result.num_turns, stop: result.subtype, denied: result.permission_denials?.length ?? 0, status, report: result.result })
  }))
}

function describe(input = {}) {
  const text = input.description ?? input.file_path ?? input.pattern ?? input.skill ?? input.command ?? input.prompt ?? ''
  return String(text).split('\n')[0].slice(0, 110)
}

function attemptedBefore(id) {
  let lines = []
  try { lines = readFileSync(LOG, 'utf8').trim().split('\n') } catch {}
  const last = lines.map(l => { try { return JSON.parse(l) } catch { return {} } }).filter(e => e.id === id).at(-1)
  return Boolean(last) && !['closed', 'corrected', 'busy'].includes(last.outcome)
}

// The register is the authority: an anchor below the § Closed heading is closed.
function isClosed(id) {
  const lines  = readFileSync(join(ROOT, 'ISSUES.md'), 'utf8').split('\n')
  const header = lines.findIndex(l => l.startsWith('## Closed'))
  const anchor = lines.findIndex(l => l.includes(`id="${id.toLowerCase()}"`))
  return header !== -1 && anchor > header
}

function log(entry) {
  mkdirSync(LOG_DIR, { recursive: true })
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '')
    const val = argv[i + 1]
    if (val === undefined || val.startsWith('--')) out[key] = true
    else { out[key] = val; i++ }
  }
  return out
}
