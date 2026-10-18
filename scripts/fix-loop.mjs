#!/usr/bin/env node
// ============================================================
// Work down the open register, one row per headless session
//
//   bun run fix:loop                       # up to 5 rows
//                                          #   (naming no rows, it takes Haven's /menu)
//   bun run fix:loop -- --rows 10 --pkg sierra
//   bun run fix:loop -- --sev S3,S4        # only these severities
//   bun run fix:loop -- --budget 3 --dry-run
//   bun run fix:loop -- --rows 8 --lanes 3   # three rows at a time
//   bun run fix:loop -- --trial s4 --model haiku --ids FJS-1,FJS-2 --lanes 5
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
// and which edited something. A row the log shows sent back twice without
// closing — blocked, failed or rewritten — is skipped and listed at the end:
// the loop cannot finish it and a person can, and the third attempt is the
// expensive one (FJS-2714, blocked three times, the last for $6). Naming the
// row with --ids runs it anyway. Without --lanes, rows run serially; a second
// loop in the same tree picks the same top row.
//
// --lanes N runs N rows at once, each in its own worktree (`lanes.mjs`), and
// never two rows sharing a package: two lanes in one package would both edit
// it blind to each other and conflict when merged back, and the package suite
// is the long wait a lane exists to overlap. A lane merges its row's edits into
// the main tree when the row ends; a failed attempt's edits are kept as a patch
// under ~/.fli/lanes/patches instead, and the next attempt at that row starts
// from it. A second loop gets the lanes the first does not hold, or refuses.
//
// --trial <name> compares models on the same rows, so nothing it does lands:
// each lane gets a COPY of the register, the session closes the row in that
// copy, and the attempt — register edit included — is kept as
// ~/.fli/lanes/patches/<name>/<id>.<model>.patch and logged to
// ~/.fli/fix-trial-<name>.jsonl. The session gets no `--add-dir` on the main
// tree, and no attempt is told of an earlier one, since the earlier one is the
// other model's. --model pins one rung (effort --effort, default high) with no
// retry on another, and --ids runs exactly those rows.
// ============================================================

import { spawnSync }                from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join }            from 'node:path'
import { pathToFileURL }            from 'node:url'

import { ROOT, LOG_DIR, runSession, printAttempt, appendLog, lastEntry, readLog, sentBack, fli, rg, citation, parseArgs, printHelp, trace, planUsage, printPlanUsage } from './headless.mjs'
import { LANES_DIR, LINKED, MAX_LANES, openLanes, syncLane, applyPatch, lanePatch, harvest } from './lanes.mjs'

// Not `LADDER`: frame-loop shares that one and stays on Opus.
const FIX_LADDER = [{ model: 'sonnet', effort: 'high' }, { model: 'opus', effort: 'high' }]

// Haven's kitchen menu (`/menu` at the pass, IDEAS/haven.md 18.2): a bare run's
// starting settings, kept per machine so a loop started with no terminal open
// reads it. Haven owns the file and its shape; a tree without Haven has none.
const MENU = await import(pathToFileURL(join(ROOT, 'packages', 'haven', 'web', 'src', 'lib', 'hash', 'taskmaster.js')).href).catch(() => null)

const OUTLINE = import(pathToFileURL(join(ROOT, 'packages', 'cli', 'core', 'outline.js')).href).catch(() => null)

// The realm catalog a package's hazards are filed under. An app crosses all three.
const REALMS = {
  litestone: ['data'],
  junction: ['api'], auth: ['api'], caravan: ['api'], conduit: ['api'], notifications: ['api'], mcp: ['api'], orion: ['api'], outpost: ['api'], testing: ['api'],
  mesa: ['ui'], sierra: ['ui'], ui: ['ui'], css: ['ui'], jetty: ['ui'], 'email-kit': ['ui'],
  example: ['data', 'api', 'ui'], basecamp: ['data', 'api', 'ui'],
}

const given      = parseArgs(process.argv.slice(2))
// A command line naming its rows (the taskmaster's --pkg, a mod's --ids) is never mixed with the menu: its --sev would filter rows somebody named.
const menu       = given.ids || given.pkg || given.sev || given.trial || given.help ? null : MENU?.readMenu() ?? null
const args       = { ...menu?.flags, ...given }
const budget     = Number(args.budget ?? 5)
const permission = args['permission-mode'] ?? 'auto'
const dryRun     = Boolean(args['dry-run'])
const lanes      = Number(args.lanes ?? 0)
const ids        = args.ids ? String(args.ids).split(',').map(s => s.trim()).filter(Boolean) : null
const rows       = Number(args.rows ?? ids?.length ?? 4)
const pinned     = args.model ? [{ model: String(args.model), effort: String(args.effort ?? 'high') }] : null
const trial      = args.trial ? String(args.trial) : null
const LOG        = join(LOG_DIR, trial ? `fix-trial-${trial}.jsonl` : 'fix-loop.jsonl')

if (args.help) { printHelp(import.meta.url); process.exit(0) }
if (menu) console.log(`[fix-loop] menu: ${menu.menu} ${MENU.flagsLine(menu.flags) || '(no flags)'} — ${MENU.MENU_FILE}`)
// Without a lane a trial session edits the main tree, and the first model's fix is the second model's starting point.
if (trial && !(/^[\w-]+$/.test(trial) && lanes)) { console.error('[fix-loop] --trial takes a name of letters, digits, - and _, and needs --lanes'); process.exit(1) }
if (!Number.isInteger(lanes) || lanes < 0 || lanes > MAX_LANES) { console.error('[fix-loop] --lanes takes 1–5: a lane is a worktree, and there are five branch port blocks'); process.exit(1) }

// ─── the loop ───────────────────────────────────────────────

const skipped  = new Set()
const dodged   = []                       // { id, verdicts } the loop refused to pay for again
const inFlight = new Map()                // id → { pkg, done }
const WAIT     = Symbol('wait')
let started   = 0
let stopped   = false
let spent     = 0
let closed    = 0
let blocked   = 0

const usageAtStart = dryRun ? null : await planUsage()
printPlanUsage('fix-loop', 'start', usageAtStart)

if (lanes && !dryRun) await Promise.all(openLanes(lanes).map(worker))
else await worker(null)

console.log(`\n[fix-loop] ${closed} closed · ${blocked} waiting on a ruling · $${spent.toFixed(2)} spent · log ${LOG}`)
for (const d of dodged) console.log(`[fix-loop] ${d.id} needs a person: ${d.verdicts.length} attempts ended ${d.verdicts.join(', ')} and it is still open — \`--ids ${d.id}\` runs it anyway`)
if (usageAtStart) printPlanUsage('fix-loop', 'end', await planUsage(), usageAtStart)

async function worker(lane) {
  const tag = lane ? `fix-loop:${lane.n}` : 'fix-loop'
  while (!stopped && started < rows) {
    const row = nextRow()
    if (row === WAIT) { await Promise.race([...inFlight.values()].map(f => f.done)); continue }
    if (!row) { console.log(`[${tag}] nothing ready`); return }

    let finish
    inFlight.set(row.id, { pkg: row.pkg, done: new Promise(r => { finish = r }) })
    // A lane that cannot be synced or merged is out of the run; the others go on.
    try { await work(row, ++started, lane, tag) }
    catch (err) { console.log(`[${tag}] ${row.id} — ${err.message}`); if (lane) return }
    finally { inFlight.delete(row.id); skipped.add(row.id); finish() }
  }
}

async function work(row, n, lane, tag) {
  console.log(`\n[${tag}] ${n}/${rows} ${row.id} (${row.severity}, ${row.pkg.join(' · ')}) — ${row.title.slice(0, 100)}`)
  if (dryRun) { console.log(await preBrief(row)); return }

  const brief   = await preBrief(row)
  // An S1 or S2 that fails on Sonnet is retried on Opus anyway, so the Sonnet attempt is spend with no row at the end of it.
  const ladder = pinned ?? (/^S[12]$/.test(row.severity) ? FIX_LADDER.slice(1) : FIX_LADDER)
  const patch   = trial
    ? join(LANES_DIR, 'patches', trial, `${row.id}.${ladder[0].model}.patch`)
    : join(LANES_DIR, 'patches', `${row.id}.patch`)
  const base    = lane && syncLane(lane, { linked: !trial })
  const carried = lane && !trial ? applyPatch(lane, patch) : false
  const root    = trial ? lane.dir : ROOT
  let outcome
  let retried = false
  for (let rung = 0; rung < ladder.length; rung++) {
    const { model, effort } = ladder[rung]
    // A lane starts clean from the main tree, so its earlier attempt is whatever patch it was handed.
    const earlier = trial ? false : lane && rung === 0 ? carried : attemptedBefore(row.id)
    const prompt  = earlier
      ? `/fix-next ${row.id} — an earlier fix-loop attempt at this row did not close it; the edits under its packages in the working tree are that attempt's, so read git diff and build on them`
      : `/fix-next ${row.id}`

    appendLog(LOG, { id: row.id, severity: row.severity, model, effort, outcome: 'started' })
    const run = await runSession(`${prompt}\n\n${brief}${lane ? laneNote() : ''}`, {
      model, effort, permission, cap: model === 'opus' ? budget * 2 : budget,
      tag, where: `${row.id} [${n}/${rows}]`, phases: { orient: 0, fix: 0, prove: 0, close: 0 }, phaseOf,
      ...(lane && { cwd: lane.dir, addDirs: trial ? [] : [ROOT], env: { PATH: `${lane.bin}:${process.env.PATH}` } }),
    })
    const status = /fix-next: \S+ (closed|blocked|ruling|corrected|busy|failed)\s*$/.exec(run.report)?.[1]
    outcome   = isClosed(row.id, root) ? 'closed' : isBlocked(row.id, root) ? 'blocked' : status === 'blocked' ? 'failed' : status ?? 'failed'
    spent    += run.cost

    const dirty = outcome === 'busy' ? dirtyUnder(row) : undefined
    appendLog(LOG, { id: row.id, severity: row.severity, model, effort, cost: run.cost, turns: run.turns, minutes: run.minutes, phases: run.phases, outcome, stop: run.stop, denied: run.denied, edited: run.edited, transient: run.transient, dirty, ...(lane && { cwd: lane.dir }), ...trace(run) })
    printAttempt(tag, { model, effort }, outcome, run)

    // A safety check that gave no verdict failed the attempt, not the row, and the next rung costs five times as much.
    if (outcome === 'failed' && run.transient && !run.edited && !retried) {
      retried = true
      rung--
      console.log(`[${tag}] ${row.id} failed on ${run.transient} unanswered safety check(s) with nothing edited — same rung once more`)
      continue
    }
    if (outcome !== 'failed') break
  }

  if (lane) settle(lane, base, row, outcome, patch, tag)
  if (outcome === 'busy') console.log(`[${tag}] ${row.id} is another session's work in progress — skipped`)

  if (outcome === 'closed') closed++
  if (outcome === 'blocked') { blocked++; console.log(`[${tag}] ${row.id} waits on a question it filed — fli decide answers it`) }
  if (outcome === 'ruling') {
    console.log(`[${tag}] ${row.id} needs a ruling — stopping; answer it with fli decisions, then rerun`)
    stopped = true
  }
}

// A row that ended carries its edits into the main tree; one that did not keeps
// them as a patch, so a half-built fix never reaches the tree other lanes copy.
function settle(lane, base, row, outcome, patch, tag) {
  if (trial) {
    const diff = lanePatch(lane, base)
    mkdirSync(dirname(patch), { recursive: true })
    writeFileSync(patch, diff)
    console.log(`[${tag}] ${row.id} ${outcome} — kept, not merged: ${patch}`)
    return
  }
  if (['failed', 'ruling'].includes(outcome)) {
    const diff = lanePatch(lane, base)
    if (diff.length) { mkdirSync(join(LANES_DIR, 'patches'), { recursive: true }); writeFileSync(patch, diff) }
    if (diff.length) console.log(`[${tag}] ${row.id} edits kept for its next attempt: ${patch}`)
    return
  }
  const got = harvest(lane, base)
  appendLog(LOG, { lane: lane.n, row: row.id, harvest: got })
  if (got.dropped.length) console.log(`[${tag}] ${row.id} generated files not merged, regenerate them: ${got.dropped.join(', ')}`)
  if (got.conflicts.length) {
    writeFileSync(patch, lanePatch(lane, base))
    console.log(`[${tag}] ✗ ${row.id} is ${outcome} in the register but its edits CONFLICT with the main tree in ${got.conflicts.join(', ')} — nothing merged; apply ${patch} by hand`)
    return
  }
  rmSync(patch, { force: true })
  if (got.written.length) console.log(`[${tag}] ${row.id} merged into the main tree: ${got.written.join(', ')}`)
}

function laneNote() {
  if (trial) return ['', '', '## Lane',
    '',
    `This session runs in a lane: a worktree of the main tree, holding everything that tree holds, uncommitted work included. ${LINKED.join(', ')} are this lane's own copies, so \`fli close\`, \`fli file\` and \`fli amend\` write here. Nothing is merged into the main tree: your edits are kept as a patch and reviewed. Work only inside this worktree.`,
    loadNote(),
  ].join('\n')
  return ['', '', '## Lane',
    '',
    `This session runs in a lane: a worktree of the main tree at ${ROOT}, holding everything that tree holds, uncommitted work included. Your edits are merged into the main tree when the session ends.`,
    `${LINKED.join(', ')} are links to the main tree's files: \`fli close\`, \`fli file\` and \`fli amend\` write through them as usual, and Edit names the target path to write instead, which is allowed. \`fli\` on PATH is this worktree's own.`,
    loadNote(),
  ].join('\n')
}

// The lanes are the load: N suites and drives at once on one machine, and a 5 s
// bun timeout or a browser wait that passes alone is this run's doing, not the fix's.
function loadNote() {
  return `${lanes} lanes run suites and drives on this machine at once. A test or drive outside your diff that times out, hangs, or fails under the suite and passes alone is that load: file it with \`env: timing\` (fix-next § 5) and go on, rather than rerunning it or changing timeouts.`
}

// ─── steps ──────────────────────────────────────────────────

// WAIT when every row left shares a package with one a lane is running.
function nextRow() {
  // A named row may rank anywhere in the queue.
  const argv = ['next', '--json', '--limit', String(ids ? 100000 : rows + skipped.size + inFlight.size + 5)]
  if (args.pkg) argv.push('--pkg', args.pkg)
  if (args.sev) argv.push('--sev', args.sev)
  const log = readLog(LOG)
  const running = [...inFlight.values()].flatMap(f => f.pkg)
  let wait = false
  for (const r of JSON.parse(fli(argv)).ready) {
    if (skipped.has(r.id) || inFlight.has(r.id) || r.byHand || r.env || (ids && !ids.includes(r.id))) continue
    if (r.pkg.some(p => running.includes(p))) { wait = true; continue }
    if (stillBusy(r, log)) { console.log(`[fix-loop] ${r.id} skipped — busy last time, and the files that made it so are still dirty`); skipped.add(r.id); continue }
    const verdicts = ids ? null : sentBack(r.id, log)
    if (verdicts) { console.log(`[fix-loop] ${r.id} skipped — ${verdicts.length} attempts ended ${verdicts.join(', ')} and it is still open`); skipped.add(r.id); dodged.push({ id: r.id, verdicts }); continue }
    return r
  }
  return wait ? WAIT : undefined
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
    '- A drive that fails outside your diff is checked with `fli prove` and its `open: FJS-###` tag before anything is rebuilt to test it. A prove whose every ✗ carries `open:`, or is `skipped` on one, is finished; a second run prints the same tags.')
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
function isBlocked(id, root = ROOT) {
  return JSON.parse(fli(['next', '--json'], root)).blocked.some(r => r.id === id)
}

function isClosed(id, root = ROOT) {
  const lines  = readFileSync(join(root, 'ISSUES.md'), 'utf8').split('\n')
  const header = lines.findIndex(l => l.startsWith('## Closed'))
  const anchor = lines.findIndex(l => l.includes(`id="${id.toLowerCase()}"`))
  return header !== -1 && anchor > header
}
