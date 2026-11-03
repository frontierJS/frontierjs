#!/usr/bin/env node
// ============================================================
// Build one open step of a listed stressor app per headless session
//
//   bun run stress:loop -- --rows 1 --filed 3 --budget 5        # one step, up to 3 rows filed today
//   bun run stress:loop -- --app serpgrid --dry-run             # the pre-brief, no session
//   bun run stress:loop -- --rows 1 --filed 3 --budget 5 --model sonnet --source autopilot
//
// The stressors are the framework's feeder (IDEAS/autopilot.md): an app in
// `../fjs-prototypes` whose PLAN.md is Phases of Steps, built one step at a
// time so every framework gap the step meets is FILED — `fli file --area
// <app>`, or `--sev decision` with options — never worked around in the app
// (docs/STRESSOR-UPGRADE.md). Each session runs `/stress-next <app> <step>`
// over the app's first open box, in a worktree of the app's repo, and ends
// with the box ticked or the gap filed.
//
// Which app: the ones listed under `stressors.apps` in ~/.fli/autopilot.json
// and no other — the list is the owner's consent (FJS-D1780), so an app not
// on it is refused by name whether the run is scheduled or by hand, and
// `--app` only chooses among the listed. Of those, the app whose first open
// box has waited longest goes first (`stressors.mjs`); an app whose last step
// is ticked on its branch but not merged is passed over until the owner
// merges it.
//
// Where the work lands: ~/.fli/stress/<app>, a worktree of the app's repo on
// the branch `stress/<step>`, made from HEAD plus the app's uncommitted work
// committed as a base, so the owner's merge shows only the session's diff.
// The app's own working tree is never written. What the session leaves is
// committed on the branch when it ends, whatever the outcome.
//
// What a session did is read off the worktree's PLAN.md and the framework's
// registers, never off what it says:
//
//   ticked    the step's box went from open to done
//   blocked   not ticked, and the session filed a row or question it waits on
//   busy      another session holds the app
//   failed    anything else — retried once on the next rung
//
// Two caps are this loop's own, both script flags with no default (FJS-D1778):
// --filed is the rows one day of stress runs may file, counted off this log's
// own lines, hand runs included — a row the loop files about the loop is the
// spiral the cap stops; --rows is steps per run. --source autopilot marks a
// scheduled run and reads the day cap in the schedule file before each step.
//
// The session, its log and the ladder are `headless.mjs`. One line per attempt
// goes to ~/.fli/stress-loop.jsonl with `app`, `step`, the outcome and `filed`,
// the register ids the session added.
// ============================================================

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync }                                                                           from 'node:child_process'
import { dirname, isAbsolute, join, resolve }                                                 from 'node:path'
import { pathToFileURL }                                                                       from 'node:url'

import { ROOT, LOG_DIR, logOf, LADDER, runSession, printAttempt, appendLog, readLog, parseArgs, printHelp, trace, writes, sourceOf, dayCapRefusal } from './headless.mjs'
import { readSchedule, listedRefusal, overFiledCap, filedToday }                                                                                    from '../packages/cli/core/autopilot.js'
import { waitedSince, blamedAt, orderCards, passedOver, claimed, grade, branchOf }                                                                   from './stressors.mjs'

const LOG      = logOf('stress')
const SITES    = join(LOG_DIR, 'stress')
const PLANNING = import(pathToFileURL(join(ROOT, 'packages', 'cli', 'core', 'plan.js')).href)
const FILING   = import(pathToFileURL(join(ROOT, 'packages', 'cli', 'core', 'file.js')).href)

const args       = parseArgs(process.argv.slice(2))
const rows       = Number(args.rows ?? 1)
const filedCap   = args.filed === undefined ? undefined : Number(args.filed)
const budget     = Number(args.budget ?? 5)
const permission = args['permission-mode'] ?? 'auto'
const dryRun     = Boolean(args['dry-run'])
const source     = sourceOf(args)
const ladder     = args.model ? [{ model: String(args.model), effort: String(args.effort ?? 'high') }] : LADDER

if (args.help) { printHelp(import.meta.url); process.exit(0) }

const refused = (why) => { console.error(`[stress-loop] refused: ${why}`); process.exit(1) }
{ const over = dayCapRefusal(source); if (over) refused(over) }

let schedule
try { schedule = readSchedule() } catch (err) { refused(err.message) }
{ const why = listedRefusal(schedule.stressors, args.app); if (why) refused(why) }
if (!dryRun) { const why = overFiledCap(filedCap, filedToday(readLog(LOG))); if (why) refused(why) }

const APPS_DIR = isAbsolute(schedule.stressors.dir) ? schedule.stressors.dir : resolve(ROOT, schedule.stressors.dir)
const { parsePlan, phaseOf: planPhase } = await PLANNING
const { registerHigh, filedSince }      = await FILING

// ─── the loop ───────────────────────────────────────────────

const skipped = new Set()
const tally   = { ticked: 0, blocked: 0, busy: 0, failed: 0 }
let spent     = 0

for (let n = 0; n < rows; n++) {
  const over = dayCapRefusal(source)
  if (over) { console.log(`[stress-loop] stopping: ${over}`); break }
  const remaining = dryRun ? filedCap : filedCap - filedToday(readLog(LOG))
  if (!dryRun && remaining <= 0) { console.log(`[stress-loop] stopping: ${overFiledCap(filedCap, filedToday(readLog(LOG)))}`); break }

  const card = nextCard()
  if (!card) { console.log('[stress-loop] no listed app has a step to run'); break }
  const { app, step } = card
  skipped.add(app)

  console.log(`\n[stress-loop] ${n + 1}/${rows} ${app} ${step.id} — ${step.title.slice(0, 100)} (waited since ${card.waited.slice(0, 10)})`)
  if (dryRun) { console.log(preBrief(card, { dir: join(SITES, app), branch: branchOf(step.id) }, remaining)); continue }

  let site
  try { site = openSite(card) }
  catch (err) {
    console.log(`[stress-loop]   busy: ${err.message}`)
    appendLog(LOG, { app, step: step.id, id: `${app} ${step.id}`, outcome: 'busy', note: err.message, filed: [], ...(source && { source }) })
    tally.busy++
    continue
  }

  let outcome = 'failed'
  let crossed = null
  for (const [rung, { model, effort }] of ladder.entries()) {
    const high    = registerHigh(ROOT)
    const earlier = rung > 0 || site.resumed
    const prompt  = [
      `/stress-next ${app} ${step.id}`,
      earlier ? `An earlier stress-loop attempt at this step left commits and edits on ${site.branch} in ${site.dir}; they are yours — read git log and git diff there and build on them.` : '',
      preBrief(card, site, remaining),
    ].filter(Boolean).join('\n\n')

    appendLog(LOG, { app, step: step.id, id: `${app} ${step.id}`, model, effort, outcome: 'started', branch: site.branch, worktree: site.dir, ...(source && { source }) })
    const run = await runSession(prompt, {
      model, effort, permission, cap: rung === 0 ? budget : budget * 2,
      tag: 'stress-loop', where: `${app} ${step.id} [${n + 1}/${rows}]`, addDirs: [site.dir],
      phases: { orient: 0, build: 0, prove: 0, file: 0, close: 0 },
      phaseOf: (part, edited) => { crossed ??= crossing(part); return phaseOf(part, edited) },
    })
    spent += run.cost

    const filed = filedSince(ROOT, [{ from: high }])[0].map(r => r.id)
    const after = boxOf(join(site.dir, 'PLAN.md'), step.id)
    const claim = claimed(run.report)
    outcome     = grade({ before: 'open', after, filed, claim })
    const landed = landSite(site, `stress ${app} ${step.id}: ${outcome} — ${step.title.slice(0, 60)}`)

    appendLog(LOG, { app, step: step.id, id: `${app} ${step.id}`, model, effort, cost: run.cost, turns: run.turns, minutes: run.minutes, phases: run.phases, outcome, filed, branch: site.branch, worktree: site.dir, commit: landed, note: claim?.note || undefined, stop: run.stop, denied: run.denied, crossed, ...(source && { source }), ...trace(run) })
    printAttempt('stress-loop', { model, effort }, `${outcome}${filed.length ? ` · filed ${filed.join(', ')}` : ''}`, run)
    if (landed) console.log(`[stress-loop]   ${site.branch} @ ${landed.slice(0, 10)} in ${site.dir}`)

    if (crossed || outcome !== 'failed') break
  }

  tally[outcome in tally ? outcome : 'failed']++
  if (crossed) {
    console.log(`[stress-loop] STOPPED — the session ruled rather than filed: ${crossed}. Read git diff in ${ROOT} before anything else runs.`)
    break
  }
}

console.log(`\n[stress-loop] ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(' · ')} · $${spent.toFixed(2)} spent · log ${LOG}`)

// ─── the queue ──────────────────────────────────────────────

// Every listed app as a card, the reasons for passing one over printed, and
// the longest-waited of the rest.
function nextCard() {
  const log   = readLog(LOG)
  const apps  = (args.app ? [args.app] : schedule.stressors.apps).filter(a => !skipped.has(a))
  const cards = apps.map(app => cardOf(app, log))
  for (const c of cards) { const why = passedOver(c, log); if (why) console.log(`[stress-loop]   ${c.app}: passed over — ${why}`) }
  return orderCards(cards.filter(c => !passedOver(c, log)))[0] ?? null
}

function cardOf(app, log) {
  const dir  = join(APPS_DIR, app)
  const file = join(dir, 'PLAN.md')
  const card = { app, dir, plan: null, step: null, waited: null, error: null }
  if (!existsSync(dir)) return { ...card, error: `${dir} does not exist` }
  if (!existsSync(join(dir, '.git'))) return { ...card, error: 'not a git repository, so no worktree can be made of it' }
  if (!existsSync(file)) return { ...card, error: 'no PLAN.md' }
  try { card.plan = parsePlan(readFileSync(file, 'utf8'), { file }) } catch (err) { return { ...card, error: `PLAN.md does not parse: ${err.message.split('\n')[0]}` } }
  card.step = card.plan.next
  if (!card.step) return { ...card, error: 'no open box' }
  const blame = spawnSync('git', ['-C', dir, 'blame', '--porcelain', '-L', `${card.step.line},${card.step.line}`, 'PLAN.md'], { encoding: 'utf8' })
  const attempt = log.filter(e => e.app === app && e.step === card.step.id).at(-1)?.at
  card.waited = waitedSince({ lineAt: blame.status === 0 ? blamedAt(blame.stdout) : null, mtime: statSync(file).mtime.toISOString(), attemptAt: attempt })
  return card
}

function boxOf(file, id) {
  try { return parsePlan(readFileSync(file, 'utf8'), { file }).steps.find(s => s.id === id)?.box ?? null } catch { return null }
}

// ─── the site ───────────────────────────────────────────────

// The app's worktree on the step's branch. A worktree already on that branch
// is an earlier attempt's and is kept; one on another step's branch is done
// with and remade. The branch itself is reused when it exists, so a run whose
// worktree was removed by hand still lands on the same branch.
function openSite({ app, dir: repo, step }) {
  const dir    = join(SITES, app)
  const branch = branchOf(step.id)
  const lock   = join(SITES, `${app}.lock`)
  mkdirSync(SITES, { recursive: true })
  const holder = existsSync(lock) ? Number(readFileSync(lock, 'utf8')) : 0
  if (holder && holder !== process.pid && alive(holder)) throw new Error(`${app} is held by pid ${holder}, a stress-loop still running`)
  writeFileSync(lock, String(process.pid))

  if (isWorktree(dir)) {
    if (git(dir, 'rev-parse', '--abbrev-ref', 'HEAD') === branch) {
      install(dir)
      return { dir, branch, repo, resumed: true }
    }
    git(repo, 'worktree', 'remove', '--force', dir)
  }
  rmSync(dir, { recursive: true, force: true })
  git(repo, 'worktree', 'prune')
  const exists = spawnSync('git', ['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0
  if (exists) git(repo, 'worktree', 'add', dir, branch)
  else {
    git(repo, 'worktree', 'add', '-b', branch, dir, 'HEAD')
    baseCommit(repo, dir)
  }
  install(dir)
  return { dir, branch, repo, resumed: exists }
}

// The app's uncommitted work — every modified, added, renamed and untracked
// file, and every deletion — laid onto the worktree and committed as the base
// the session builds on. The owner's working tree is read and never written.
function baseCommit(repo, dir) {
  const status = spawnSync('git', ['-C', repo, 'status', '--porcelain', '-z', '--untracked-files=all'], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout.split('\0')
  for (let i = 0; i < status.length; i++) {
    const entry = status[i]
    if (!entry) continue
    const xy = entry.slice(0, 2), path = entry.slice(3)
    if (/[RC]/.test(xy)) i++
    if (xy.includes('D')) { rmSync(join(dir, path), { force: true }); continue }
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    copyFileSync(join(repo, path), join(dir, path))
  }
  // Gitignored, so the worktree has none: the app reads its secrets and ports here.
  for (const f of files(repo, ['-g', '.env', '-g', '.env.*'])) {
    mkdirSync(dirname(join(dir, f)), { recursive: true })
    copyFileSync(join(repo, f), join(dir, f))
  }
  if (git(dir, 'status', '--porcelain')) {
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', `stress base: the working tree of ${repo} as of ${new Date().toISOString().slice(0, 16)}`)
  }
}

// `link:` dependencies resolve through bun's global links, the same ones the
// app's own tree uses, so an install here is the app's install.
function install(dir) {
  if (existsSync(join(dir, 'node_modules'))) return
  const out = spawnSync('bun', ['install'], { cwd: dir, encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`bun install in ${dir} failed\n${out.stderr}`)
}

/** Commit whatever the session left on the branch; answers the commit, or null when it left nothing. */
function landSite({ dir }, message) {
  if (!git(dir, 'status', '--porcelain')) return null
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

function files(repo, globs) {
  const out = spawnSync('rg', ['--files', '--hidden', '--no-ignore', ...globs, '-g', '!**/node_modules/**', '-g', '!.git'], { cwd: repo, encoding: 'utf8' })
  return (out.stdout ?? '').split('\n').filter(Boolean)
}

function isWorktree(dir) {
  const out = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  return out.status === 0 && out.stdout.trim() === dir
}

function git(cwd, ...argv) {
  const out = spawnSync('git', ['-C', cwd, ...argv], { encoding: 'utf8', maxBuffer: 64 << 20 })
  if (out.status !== 0) throw new Error(`git ${argv.join(' ')}: ${out.stderr.trim()}`)
  return out.stdout.trim()
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

// ─── the pre-brief ──────────────────────────────────────────

// Located, not read: where the step sits in its plan, the phase it serves, the
// app's own check, and the rules of the run. Building it is the session's.
function preBrief(card, site, remaining) {
  const { app, dir: repo, plan, step } = card
  const phase = planPhase(plan, step)
  const lines = readFileSync(join(repo, 'PLAN.md'), 'utf8').split('\n')
  const text  = bullet(lines, step.line)
  let scripts = {}
  try { scripts = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts ?? {} } catch {}
  const check = ['check', 'test', 'typecheck'].filter(s => scripts[s]).map(s => `\`bun run ${s}\``)

  return [
    '## Pre-brief (stress-loop, by script)',
    '',
    `App: ${app}, a stressor of this framework. Work in its worktree \`${site.dir}\` (branch \`${site.branch}\`), never in \`${repo}\`, which is the owner's working tree.`,
    `Framework root: \`${ROOT}\`, your cwd. \`fli file --area ${app}\` and \`fli decisions\` run from here; the app's own commands run with \`cd ${site.dir} &&\`.`,
    '',
    `Step ${step.id}${phase ? ` of Phase ${phase.n} — ${phase.title}` : ''}, PLAN.md:${step.line}, verbatim:`,
    '',
    ...text.map(l => `    ${l}`),
    ...(phase?.goal ? ['', `Phase goal: ${phase.goal}`] : []),
    ...(phase?.doneWhen ? [`Phase done when: ${phase.doneWhen}`] : []),
    '',
    `The app proves itself with ${check.length ? check.join(', ') : 'no check script (none in package.json)'}, run in the worktree.`,
    `You may file at most ${remaining} row${remaining === 1 ? '' : 's'} this run (the day's stress cap); a gap past that goes into the step's note in PLAN.md, not the registers.`,
    '',
    'A framework gap is filed, never worked around in the app (docs/STRESSOR-UPGRADE.md): a defect is `fli file --sev S3 --area ' + app + '`, a choice is `fli file --sev decision --area ' + app + '` with options under the step\'s bullet. Nothing in the framework tree is edited but through those commands; a fix to the framework is the fix loop\'s.',
    'The app\'s .env is copied as the owner pinned it; whatever a boot reaches is what the owner consented to by listing the app.',
    '',
    'Start from this rather than re-finding it; what the step needs built, and whether it is done, is still yours.',
  ].join('\n')
}

// A step is its line and every indented line under it, ending at the next line
// that starts in column one.
function bullet(lines, line) {
  const out = [lines[line - 1]]
  for (const l of lines.slice(line)) {
    if (l.trim() && !/^\s/.test(l)) break
    out.push(l)
  }
  while (out.length && !out.at(-1).trim()) out.pop()
  return out
}

// ─── phases, and the line ───────────────────────────────────

function phaseOf(part, edited) {
  const text = `${part.input?.command ?? ''} ${part.input?.file_path ?? ''}`
  if (/\bfli (file|amend|decide)\b/.test(text)) return 'file'
  if (/\bfli done\b/.test(text)) return 'close'
  if (/\bbun (run )?(check|test|typecheck|verify)\b|\bfli (check|prove)\b/.test(text)) return 'prove'
  if (writes(part)) return 'build'
  return edited ? 'build' : 'orient'
}

// A stress session files; one that writes DECISIONS.md or rules has crossed
// into the owner's work, and the loop stops there.
function crossing(part) {
  const path = part.input?.file_path ?? ''
  const cmd  = part.input?.command ?? ''
  if (['Edit', 'Write'].includes(part.name) && /(^|\/)DECISIONS\.md$/.test(path)) return `wrote ${path}`
  if (part.name === 'Bash' && /\bfli (register:)?decide\b(?![^\n]*--file)|(sed -i|\btee\b|>)[^|;&]*\bDECISIONS\.md\b/.test(cmd)) return `ran ${cmd.split('\n')[0].slice(0, 100)}`
  return null
}
