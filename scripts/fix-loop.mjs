#!/usr/bin/env node
// ============================================================
// Work down the open register, one row per headless session
//
//   bun run fix:loop                       # up to 5 rows
//   bun run fix:loop -- --rows 10 --pkg sierra
//   bun run fix:loop -- --budget 3 --dry-run
//
// Each row runs `/fix-next <id>` in a FRESH `claude -p` session on the first
// rung of FIX_LADDER, and a row that does not close is retried once on the next —
// the outcome is checkable (the row moves to § Closed or it does not), so
// paying for Opus only on the rows Sonnet did not close is cheaper per solved
// row than running everything high. An S1 or S2 row skips the Sonnet rung and
// runs once, on Opus. Model and effort are set per
// session, never changed inside one, since a mid-session change drops the
// prompt cache.
//
// Every turn re-reads the whole context, so a session costs roughly turns ×
// context. Both are cut before the session starts: the prompt carries a
// pre-brief (the row, what it cites, where its identifiers live, the hazards
// naming them), which is the work the first third of an unbriefed run spends
// turns finding, and which stands in for the skill's Explore brief; and the
// session loads project settings only, with no MCP servers — a user plugin's
// skills and a connector's tools are context every turn pays for and no fix
// uses.
//
// Whether a row closed is read off ISSUES.md, not off what the session says:
// a session can report success over a row it never moved. So is whether it is
// BLOCKED — the session met a choice, filed it with `fli file --sev decision
// --blocks <row>`, and `fli next` now sets the row aside until the owner rules;
// the loop goes on to the next row. The session's last line (`fix-next: <id>
// <status>`, written by the skill) is read only for what the register cannot
// show: `busy`, and `ruling`, a session that asked instead of filing, which
// ends the loop since nobody is there to answer.
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
// It also carries the session id, failed and denied tools, token usage and the
// report's tail, which is what `loop-review.mjs` reads the transcripts back by.
//
// A failed or interrupted attempt leaves its edits in the tree, and the next
// attempt at that row is told so rather than handed a clean tree — the partial
// work is usually most of the fix. Untold, the skill reads those edits as
// another session's and stops (\`busy\`), which is right for a real collision:
// a busy row is skipped, never retried at high effort, and a later run skips
// it too while the files that made it busy are unchanged. What counts as an
// earlier attempt is the log — an entry for the id whose outcome is not closed
// and which edited something. Rows run serially; a second loop in the same
// tree picks the same top row.
// ============================================================

import { spawnSync }                from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join }                     from 'node:path'
import { pathToFileURL }            from 'node:url'

import { ROOT, LOG_DIR, runSession, printAttempt, appendLog, lastEntry, readLog, fli, rg, citation, parseArgs, printHelp, trace, planUsage, printPlanUsage } from './headless.mjs'

// Not `LADDER`: frame-loop shares that one and stays on Opus.
const FIX_LADDER = [{ model: 'sonnet', effort: 'high' }, { model: 'opus', effort: 'high' }]

const LOG     = join(LOG_DIR, 'fix-loop.jsonl')
const OUTLINE = import(pathToFileURL(join(ROOT, 'packages', 'cli', 'core', 'outline.js')).href).catch(() => null)

// The realm catalog a package's hazards are filed under. An app crosses all three.
const REALMS = {
  litestone: ['data'],
  junction: ['api'], auth: ['api'], caravan: ['api'], conduit: ['api'], notifications: ['api'], mcp: ['api'], orion: ['api'], outpost: ['api'], testing: ['api'],
  mesa: ['ui'], sierra: ['ui'], ui: ['ui'], css: ['ui'], jetty: ['ui'], 'email-kit': ['ui'],
  example: ['data', 'api', 'ui'], basecamp: ['data', 'api', 'ui'],
}

const args       = parseArgs(process.argv.slice(2))
const rows = Number(args.rows ?? 4)
const budget     = Number(args.budget ?? 5)
const permission = args['permission-mode'] ?? 'auto'
const dryRun     = Boolean(args['dry-run'])

if (args.help) { printHelp(import.meta.url); process.exit(0) }

// ─── the loop ───────────────────────────────────────────────

const skipped = new Set()
let spent     = 0
let closed    = 0
let blocked   = 0

const usageAtStart = dryRun ? null : await planUsage()
printPlanUsage('fix-loop', 'start', usageAtStart)

for (let n = 0; n < rows; n++) {
  const row = nextRow()
  if (!row) { console.log('[fix-loop] nothing ready'); break }

  console.log(`\n[fix-loop] ${n + 1}/${rows} ${row.id} (${row.severity}, ${row.pkg.join(' · ')}) — ${row.title.slice(0, 100)}`)
  if (dryRun) { console.log(await preBrief(row)); skipped.add(row.id); continue }

  const brief = await preBrief(row)
  let outcome
  // An S1 or S2 that fails on Sonnet is retried on Opus anyway, so the Sonnet attempt is spend with no row at the end of it.
  const ladder = /^S[12]$/.test(row.severity) ? FIX_LADDER.slice(1) : FIX_LADDER
  let retried = false
  for (let rung = 0; rung < ladder.length; rung++) {
    const { model, effort } = ladder[rung]
    const prompt = attemptedBefore(row.id)
      ? `/fix-next ${row.id} — an earlier fix-loop attempt at this row did not close it; the edits under its packages in the working tree are that attempt's, so read git diff and build on them`
      : `/fix-next ${row.id}`

    appendLog(LOG, { id: row.id, severity: row.severity, model, effort, outcome: 'started' })
    const run = await runSession(`${prompt}\n\n${brief}`, {
      model, effort, permission, cap: ladder[rung] === FIX_LADDER[0] ? budget : budget * 2,
      tag: 'fix-loop', where: `${row.id} [${n + 1}/${rows}]`, phases: { orient: 0, fix: 0, prove: 0, close: 0 }, phaseOf,
    })
    const status = /fix-next: \S+ (closed|blocked|ruling|corrected|busy|failed)\s*$/.exec(run.report)?.[1]
    outcome   = isClosed(row.id) ? 'closed' : isBlocked(row.id) ? 'blocked' : status === 'blocked' ? 'failed' : status ?? 'failed'
    spent    += run.cost

    const dirty = outcome === 'busy' ? dirtyUnder(row) : undefined
    appendLog(LOG, { id: row.id, severity: row.severity, model, effort, cost: run.cost, turns: run.turns, minutes: run.minutes, phases: run.phases, outcome, stop: run.stop, denied: run.denied, edited: run.edited, transient: run.transient, dirty, ...trace(run) })
    printAttempt('fix-loop', { model, effort }, outcome, run)

    // A safety check that gave no verdict failed the attempt, not the row, and the next rung costs five times as much.
    if (outcome === 'failed' && run.transient && !run.edited && !retried) {
      retried = true
      rung--
      console.log(`[fix-loop] ${row.id} failed on ${run.transient} unanswered safety check(s) with nothing edited — same rung once more`)
      continue
    }
    if (outcome !== 'failed') break
  }

  if (outcome === 'busy') console.log(`[fix-loop] ${row.id} is another session's work in progress — skipped`)

  if (outcome === 'closed') closed++
  if (outcome === 'blocked') { blocked++; console.log(`[fix-loop] ${row.id} waits on a question it filed — fli decide answers it`) }
  if (outcome === 'ruling') {
    console.log(`[fix-loop] ${row.id} needs a ruling — stopping; answer it with fli decisions, then rerun`)
    break
  }
  skipped.add(row.id)
}

console.log(`\n[fix-loop] ${closed} closed · ${blocked} waiting on a ruling · $${spent.toFixed(2)} spent · log ${LOG}`)
if (usageAtStart) printPlanUsage('fix-loop', 'end', await planUsage(), usageAtStart)

// ─── steps ──────────────────────────────────────────────────

function nextRow() {
  const argv = ['next', '--json', '--limit', String(rows + skipped.size + 5)]
  if (args.pkg) argv.push('--pkg', args.pkg)
  const log = readLog(LOG)
  for (const r of JSON.parse(fli(argv)).ready) {
    if (skipped.has(r.id) || r.byHand) continue
    if (stillBusy(r, log)) { console.log(`[fix-loop] ${r.id} skipped — busy last time, and the files that made it so are still dirty`); skipped.add(r.id); continue }
    return r
  }
}

// `skipped` forgets between runs, so a row whose package another session holds
// was re-picked every run and paid a session to find it busy again (FJS-1157, ×3).
// The same dirty set means the same collision; any change to it earns a new look.
function stillBusy(row, log) {
  const last = log.filter(e => e.id === row.id && e.cost !== undefined).at(-1)
  return last?.outcome === 'busy' && last.dirty?.length > 0 && last.dirty.join('\n') === dirtyUnder(row).join('\n')
}

function dirtyUnder(row) {
  const dirs = packageDirs(row)
  if (!dirs.length) return []
  const out = spawnSync('git', ['status', '--porcelain', '--', ...dirs], { cwd: ROOT, encoding: 'utf8' })
  return (out.stdout ?? '').split('\n').filter(Boolean).sort()
}

// `example` sits at the root, every other area under packages/.
function packageDirs(row) {
  return row.pkg.map(p => [join('packages', p), p].find(d => existsSync(join(ROOT, d)))).filter(Boolean)
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

  const dirs  = packageDirs(row)
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

  const hazards = hazardsFor(row, text)
  out.push('', `Hazards (by script: the realm entries naming the row's identifiers or files${row.pkg.length > 1 ? ', and the bridge-index seams' : ''}; each rule's full entry is at its line):`,
    ...(hazards.length ? hazards : ['- none: no realm catalog covers this area']))

  out.push('', 'Start from this rather than re-finding it, and send no Explore brief: it is this. Whether it still reproduces and the red test are yours.')
  // Each line is a detour loop-review found in more than one transcript.
  out.push('', 'Headless, so:',
    '- Run every command in the foreground under `timeout`. The session ends when it stops calling tools, so a background run is never read back and the row fails with it still going.',
    '- Search a tree with `rg`; a recursive `grep` is refused by a hook and costs the turn.',
    '- Single-quote a pattern holding a backtick: inside double quotes bash reads it as a command substitution and the whole call fails to parse.',
    '- Change a file with Edit or Write, never a `python3` or `sed -i` replace: a replace whose old text does not match changes nothing and exits 0, so the fix you prove may not be in the file. Edit fails on a mismatch. `cat >>` onto the end of a file is fine.',
    '- A drive that fails outside your diff is checked with `fli prove` and its `open: FJS-###` tag before anything is rebuilt to test it.')
  return out.join('\n')
}

// The entries of the row's realm catalogs that name one of its backticked
// identifiers or files, most names first. An entry's bold lead is its rule; the
// line it sits on is the rest, read only when the fix touches it.
function hazardsFor(row, text) {
  // A row writes `@map` bare as often as backticked, and an attribute is what a hazard is filed under.
  const attributes = text.match(/(?<![\w.])@@?[A-Za-z]\w*/g) ?? []
  const terms = [...new Set([...[...text.matchAll(/`([^`\s]{4,80})`/g)].map(m => m[1]), ...attributes])]
    // A bare noun (`User`, `Credential`) names a model in half the catalog and picks nothing out.
    .filter(t => /^[@$]*[\w.$/-]+$/.test(t) && /[.$@_]|[a-z][A-Z]|\/\w/.test(t) && !/^FJS-/.test(t))
  const realms = [...new Set(row.pkg.flatMap(p => REALMS[p] ?? []))]
  const where = realms.map(r => join('.claude', 'skills', `${r}-hazards`, 'references'))
  if (row.pkg.length > 1) where.push(join('.claude', 'skills', 'bridge-index', 'SKILL.md'))
  const entries = new Map()
  for (const term of terms) for (const hit of rg(['-n', '-F', term, ...where.filter(w => existsSync(join(ROOT, w)))])) {
    const [, file, line, body] = /^([^:]+):(\d+):(.*)$/.exec(hit) ?? []
    if (!body?.startsWith('- ')) continue
    const key = `${file}:${line}`
    const lead = /^- \*\*(.+?)\*\*/.exec(body)?.[1] ?? body.slice(2)
    entries.set(key, { lead: lead.length > 200 ? `${lead.slice(0, 200)}…` : lead, n: (entries.get(key)?.n ?? 0) + 1 })
  }
  const found = [...entries].sort((a, b) => b[1].n - a[1].n).slice(0, 8).map(([key, e]) => `- ${e.lead} — ${key}`)
  if (found.length || !realms.length) return found
  return [`- none matched; the one-line index is ${realms.map(r => `.claude/skills/${r}-hazards/SKILL.md`).join(', ')}`]
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
  if (/\bfli (close|file|done)\b|register:(close|file)/.test(text)) return 'close'
  return edited ? 'fix' : 'orient'
}

// An attempt that edited nothing left nothing to build on, and telling the next
// one otherwise hands it another session's dirty files as its own.
function attemptedBefore(id) {
  const last = lastEntry(LOG, id)
  return Boolean(last) && !['closed', 'corrected', 'busy'].includes(last.outcome) && last.edited !== false
}

// The register is the authority: an anchor below the § Closed heading is closed.
function isBlocked(id) {
  return JSON.parse(fli(['next', '--json'])).blocked.some(r => r.id === id)
}

function isClosed(id) {
  const lines  = readFileSync(join(ROOT, 'ISSUES.md'), 'utf8').split('\n')
  const header = lines.findIndex(l => l.startsWith('## Closed'))
  const anchor = lines.findIndex(l => l.includes(`id="${id.toLowerCase()}"`))
  return header !== -1 && anchor > header
}
