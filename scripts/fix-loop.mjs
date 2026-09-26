#!/usr/bin/env node
// ============================================================
// Work down the open register, one row per headless session
//
//   bun run fix:loop                       # up to 5 rows
//   bun run fix:loop -- --rows 10 --pkg sierra
//   bun run fix:loop -- --budget 3 --dry-run
//
// Each row runs `/fix-next <id>` in a FRESH `claude -p` session on the first
// rung of LADDER, and a row that does not close is retried once on the next —
// the outcome is checkable (the row moves to § Closed or it does not), so
// paying for high effort only on the rows that need it is cheaper per solved
// row than running everything high. Model and effort are set per
// session, never changed inside one, since a mid-session change drops the
// prompt cache.
//
// Every turn re-reads the whole context, so a session costs roughly turns ×
// context. Both are cut before the session starts: the prompt carries a
// pre-brief (the row, what it cites, where its identifiers live), which is
// the work the first third of an unbriefed run spends turns finding; and the
// session loads project settings only, with no MCP servers — a user plugin's
// skills and a connector's tools are context every turn pays for and no fix
// uses.
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
// One line per attempt goes to ~/.fli/fix-loop.jsonl: id, model, effort,
// cost, turns and where they went (orient · fix · prove · close), outcome. Cost per SOLVED row is the number to tune --budget and
// LADDER against; the defaults here are guesses until that log says otherwise.
//
// A failed or interrupted attempt leaves its edits in the tree, and the next
// attempt at that row is told so rather than handed a clean tree — the partial
// work is usually most of the fix. Untold, the skill reads those edits as
// another session's and stops (\`busy\`), which is right for a real collision:
// a busy row is skipped, never retried at high effort. What counts as an
// earlier attempt is the log — an entry for the id whose outcome is not closed. Rows run serially; a second loop in the same tree picks the
// same top row.
// ============================================================

import { spawn, spawnSync }                                     from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir }                                              from 'node:os'
import { join, dirname }                                        from 'node:path'
import { createInterface }                                      from 'node:readline'
import { fileURLToPath }                                        from 'node:url'

const ROOT      = dirname(dirname(fileURLToPath(import.meta.url)))
const LOG_DIR   = join(homedir(), '.fli')
const LOG       = join(LOG_DIR, 'fix-loop.jsonl')
const LADDER    = [{ model: 'opus', effort: 'low' }, { model: 'opus', effort: 'high' }]
const STOP_HOOK = join(ROOT, '.claude', 'hooks', 'fli-done-stop.mjs')

const args       = parseArgs(process.argv.slice(2))
const rows       = Number(args.rows ?? 5)
const budget     = Number(args.budget ?? 5)
const permission = args['permission-mode'] ?? 'auto'
const dryRun     = Boolean(args['dry-run'])

if (args.help) {
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
  console.log(lines.slice(3, lines.indexOf(lines[2], 3)).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))
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
  if (dryRun) { console.log(preBrief(row)); skipped.add(row.id); continue }

  const brief = preBrief(row)
  let outcome
  for (const [rung, { model, effort }] of LADDER.entries()) {
    const prompt = attemptedBefore(row.id)
      ? `/fix-next ${row.id} — an earlier fix-loop attempt at this row did not close it; the edits under its packages in the working tree are that attempt's, so read git diff and build on them`
      : `/fix-next ${row.id}`

    log({ id: row.id, severity: row.severity, model, effort, outcome: 'started' })
    const run = await attempt(`${prompt}\n\n${brief}`, { model, effort, cap: rung === 0 ? budget : budget * 2 })
    outcome   = isClosed(row.id) ? 'closed' : run.status ?? 'failed'
    spent    += run.cost

    log({ id: row.id, severity: row.severity, model, effort, cost: run.cost, turns: run.turns, phases: run.phases, outcome, stop: run.stop, denied: run.denied })
    const split = Object.entries(run.phases).map(([k, n]) => `${k} ${n}`).join(' · ')
    console.log(`[fix-loop]   ${model}/${effort}: ${outcome} · $${run.cost.toFixed(2)} · ${run.turns ?? '?'} turns (${split})${run.denied ? ` · ${run.denied} tool calls denied` : ''}`)
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

// Located, not read: a location is cheap to find by script and costs a turn
// each to find by model, while deciding what a location means is the session's.
function preBrief(row) {
  const register = readFileSync(join(ROOT, row.file), 'utf8').split('\n')
  const line     = register[row.line - 1] ?? ''
  const text     = line.replace(/<a id="[^"]*"><\/a>/, '')
  const out      = ['## Pre-brief (fix-loop, by script)', '', `Row, verbatim: ${text}`]

  const cited = [...new Set(text.match(/FJS-D?\d+/g) ?? [])].filter(id => id !== row.id)
  const said  = cited.map(id => `- ${id}: ${citation(id) ?? 'not found in DECISIONS.md, ISSUES.md or ISSUES_ARCHIVE.md'}`)
  if (said.length) out.push('', 'Cited:', ...said)

  const dirs  = row.pkg.map(p => join('packages', p)).filter(d => existsSync(join(ROOT, d)))
  const src   = dirs.map(d => join(d, 'src'))
  const found = [...new Set([...text.matchAll(/`([^`\s]{4,60})`/g)].map(m => m[1]))]
    .filter(t => /^[@$]?[A-Za-z_][\w.$]*$/.test(t) && /[A-Z_.$@]/.test(t) && !/^FJS-/.test(t))
    .map(term => ({ term, hits: where(term, src) ?? (term.includes('.') ? where(term.split('.').at(-1), src) : null) }))
    // A plain word (`version`, `base`) matches everywhere and says nothing.
    .filter(f => f.hits && (f.term.startsWith('@') || f.hits.defined))
    .slice(0, 8)
  const code  = found.flatMap(f => [`- \`${f.term}\``, ...f.hits.lines.map(h => `    ${h}`)])
  if (code.length) out.push('', 'Where the row\'s identifiers are (src, definitions first):', ...code)

  const tally = new Map()
  for (const { term } of found) for (const file of rg(['-l', '-F', term, ...dirs.map(d => join(d, 'test'))])) tally.set(file, (tally.get(file) ?? 0) + 1)
  const tests = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 6)
  if (tests.length) out.push('', 'Tests naming the most of them:', ...tests.map(([file, n]) => `- ${file} (${n})`))

  out.push('', 'Start from this rather than re-finding it; the hazards, whether it still reproduces and the red test are still yours.')
  return out.join('\n')
}

function citation(id) {
  const anchor = `id="${id.toLowerCase()}"`
  for (const file of ['DECISIONS.md', 'ISSUES.md', 'ISSUES_ARCHIVE.md']) {
    const hit = rg(['-F', '--no-filename', '--max-count', '1', anchor, file])[0]
    if (!hit) continue
    const said = /\*\*(.+?)\*\*/.exec(hit)?.[1] ?? hit.replace(/^#+\s*<a[^>]*><\/a>/, '').replace(/^.*?—\s*/, '')
    return `${said.slice(0, 220)}${said.length > 220 ? '…' : ''} (${file})`
  }
  return null
}

// Definition-shaped lines first — the declaration is the line the session opens.
function where(term, dirs) {
  const hits = rg(['-n', '-F', '--max-columns', '160', '--max-columns-preview', term, ...dirs])
  if (!hits.length) return null
  const name    = term.replace(/[$.]/g, '\\$&')
  const defines = new RegExp(`(function|const|let|class|interface|type|export)\\s+\\*?\\s*${name}\\b|(^|[^\\w$.])${name}\\s*[(:=]`)
  const own     = hits.filter(h => defines.test(h.replace(/^[^:]+:\d+:/, '')))
  const lines   = [...own, ...hits.filter(h => !own.includes(h))].slice(0, 4)
  return { defined: own.length > 0, lines: lines.map(h => h.replace(/\s+/g, ' ').trim()) }
}

// A user's ~/.ripgreprc (--smart-case, --max-columns) would change what matches and truncate a citation.
function rg(argv) {
  const out = spawnSync('rg', ['--no-config', ...argv], { cwd: ROOT, encoding: 'utf8' })
  return out.stdout ? out.stdout.trim().split('\n').filter(Boolean) : []
}

function attempt(prompt, { model, effort, cap }) {
  // Not awaited: it takes ~25s, and a session spends longer than that reading
  // before its first edit. Lost the race, the session's own item goes unshown —
  // which is the backstop only, since fix-next runs `fli done` itself.
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
  const phases = { orient: 0, fix: 0, prove: 0, close: 0 }
  let edited   = false
  createInterface({ input: child.stdout }).on('line', line => {
    let event
    try { event = JSON.parse(line) } catch { return }
    if (event.type === 'result') result = event
    if (event.type !== 'assistant') return
    for (const part of event.message?.content ?? []) {
      if (part.type !== 'tool_use') continue
      edited ||= writes(part)
      phases[phaseOf(part, edited)]++
      console.log(`[fix-loop]     ${part.name}: ${describe(part.input)}`)
    }
  })

  return new Promise(done => child.on('close', async code => {
    await baselined
    if (!result.type) console.log(`[fix-loop]   claude ended with no result (exit ${code})`)
    const status = /fix-next: \S+ (closed|ruling|corrected|busy|failed)\s*$/.exec(result.result ?? '')?.[1]
    done({ cost: result.total_cost_usd ?? 0, turns: result.num_turns, stop: result.subtype, denied: result.permission_denials?.length ?? 0, status, report: result.result, phases })
  }))
}

// Where a session's turns went, so the next *what is slow* is read off the log
// rather than a transcript replay. A heuristic over the command text: a call is
// PROVE or CLOSE by what it runs, otherwise ORIENT until the first write and FIX
// after it.
function phaseOf(part, edited) {
  const text = `${part.input?.command ?? ''} ${part.input?.file_path ?? ''}`
  if (/\bfli proves?\b|\bverify[:\w-]*|\bbun run (api|web)\b|test:browser/.test(text)) return 'prove'
  if (/\bfli (close|file|done)\b|register:(close|file)|CHANGES\.md/.test(text)) return 'close'
  return edited ? 'fix' : 'orient'
}

function writes(part) {
  if (['Edit', 'Write', 'NotebookEdit'].includes(part.name)) return true
  return part.name === 'Bash' && /\bsed -i\b|python3? - <<|\btee\b|(^|[^0-9&>])>\s*[^&\s/][^\s]*\.(m?[jt]s|md|lite|mesa|json)\b/.test(part.input?.command ?? '')
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
