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
// The session, its log and the ladder are `headless.mjs`, shared with every
// loop of this shape; what is here is the row — picked, briefed, read back.
//
// The session streams (stream-json): each tool call prints one line as it
// happens, since a fix runs for minutes and a single JSON answer at the end
// is indistinguishable from a hang.
//
// One line per attempt goes to ~/.fli/fix-loop.jsonl: id, model, effort,
// cost, minutes, turns and where they went (orient · fix · prove · close), outcome. Cost per SOLVED row is the number to tune --budget and
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

import { existsSync, readFileSync } from 'node:fs'
import { join }                     from 'node:path'
import { pathToFileURL }            from 'node:url'

import { ROOT, LOG_DIR, LADDER, runSession, printAttempt, appendLog, lastEntry, fli, rg, citation, parseArgs, printHelp } from './headless.mjs'

const LOG     = join(LOG_DIR, 'fix-loop.jsonl')
const OUTLINE = import(pathToFileURL(join(ROOT, 'packages', 'cli', 'core', 'outline.js')).href).catch(() => null)

const args       = parseArgs(process.argv.slice(2))
const rows       = Number(args.rows ?? 5)
const budget     = Number(args.budget ?? 5)
const permission = args['permission-mode'] ?? 'auto'
const dryRun     = Boolean(args['dry-run'])

if (args.help) { printHelp(import.meta.url); process.exit(0) }

// ─── the loop ───────────────────────────────────────────────

const skipped = new Set()
let spent     = 0
let closed    = 0

for (let n = 0; n < rows; n++) {
  const row = nextRow()
  if (!row) { console.log('[fix-loop] nothing ready'); break }

  console.log(`\n[fix-loop] ${n + 1}/${rows} ${row.id} (${row.severity}, ${row.pkg.join(' · ')}) — ${row.title.slice(0, 100)}`)
  if (dryRun) { console.log(await preBrief(row)); skipped.add(row.id); continue }

  const brief = await preBrief(row)
  let outcome
  for (const [rung, { model, effort }] of LADDER.entries()) {
    const prompt = attemptedBefore(row.id)
      ? `/fix-next ${row.id} — an earlier fix-loop attempt at this row did not close it; the edits under its packages in the working tree are that attempt's, so read git diff and build on them`
      : `/fix-next ${row.id}`

    appendLog(LOG, { id: row.id, severity: row.severity, model, effort, outcome: 'started' })
    const run = await runSession(`${prompt}\n\n${brief}`, {
      model, effort, permission, cap: rung === 0 ? budget : budget * 2,
      tag: 'fix-loop', phases: { orient: 0, fix: 0, prove: 0, close: 0 }, phaseOf,
    })
    const status = /fix-next: \S+ (closed|ruling|corrected|busy|failed)\s*$/.exec(run.report)?.[1]
    outcome   = isClosed(row.id) ? 'closed' : status ?? 'failed'
    spent    += run.cost

    appendLog(LOG, { id: row.id, severity: row.severity, model, effort, cost: run.cost, turns: run.turns, minutes: run.minutes, phases: run.phases, outcome, stop: run.stop, denied: run.denied })
    printAttempt('fix-loop', { model, effort }, outcome, run)

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
  return JSON.parse(fli(argv)).ready.find(r => !skipped.has(r.id))
}

// Located, not read: a location is cheap to find by script and costs a turn
// each to find by model, while deciding what a location means is the session's.
async function preBrief(row) {
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
  const spans = new Map()
  const code  = []
  for (const f of found) {
    code.push(`- \`${f.term}\``)
    for (const h of f.hits.lines) code.push(`    ${h}`, ...await span(h, spans))
  }
  if (code.length) out.push('', 'Where the row\'s identifiers are (src, definitions first; → the function holding each, read whole with its comment; paths from the repo root):', ...code)

  const tally = new Map()
  for (const { term } of found) for (const file of rg(['-l', '-F', term, ...dirs.map(d => join(d, 'test'))])) tally.set(file, (tally.get(file) ?? 0) + 1)
  const tests = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 6)
  if (tests.length) out.push('', 'Tests naming the most of them:', ...tests.map(([file, n]) => `- ${file} (${n})`))

  out.push('', 'Start from this rather than re-finding it; the hazards, whether it still reproduces and the red test are still yours.')
  return out.join('\n')
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

// The function a hit sits in, as the `fli outline` call that prints it. A bare
// line number invites a guessed `sed -n` window, and a session walked one
// 220-line function in three of them (FJS-1289).
async function span(hit, spans) {
  const [, path, line] = /^([^:]+):(\d+):/.exec(hit) ?? []
  if (!path) return []
  const outline = await OUTLINE
  if (!outline?.outlinable(path)) return []
  if (!spans.has(path)) spans.set(path, await outline.outlineFile(join(ROOT, path)).catch(() => ({ refused: true })))
  const got = spans.get(path)
  const row = got.refused ? null : outline.findRows(got.rows, line)[0]
  const key = `${path}:${row?.start}`
  if (!row || spans.has(key)) return []
  spans.set(key, true)
  return [`      → ${outline.pathOf(row)} ${row.start}-${row.end}: fli outline ${path} ${line}`]
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

function attemptedBefore(id) {
  const last = lastEntry(LOG, id)
  return Boolean(last) && !['closed', 'corrected', 'busy'].includes(last.outcome)
}

// The register is the authority: an anchor below the § Closed heading is closed.
function isClosed(id) {
  const lines  = readFileSync(join(ROOT, 'ISSUES.md'), 'utf8').split('\n')
  const header = lines.findIndex(l => l.startsWith('## Closed'))
  const anchor = lines.findIndex(l => l.includes(`id="${id.toLowerCase()}"`))
  return header !== -1 && anchor > header
}
