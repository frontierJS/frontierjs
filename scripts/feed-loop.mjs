#!/usr/bin/env node
// ============================================================
// File what a feeder finds red — CI on a worktree at HEAD, or a stranger's build from npm
//
//   bun run feed:loop -- --feeder ci --filed 3                 # the whole of CI at HEAD; each red step a row, up to 3 today
//   bun run feed:loop -- --feeder stranger --filed 3           # fli new from the published packages, built as a beta tester would
//   bun run feed:loop -- --feeder ci --dry-run                 # what the last recorded run would file, no CI run, nothing written
//   bun run feed:loop -- --feeder ci --fast --filed 3          # a hand run of the pre-push tier
//   bun run feed:loop -- --feeder stranger --keep --filed 3    # leave the scratch app on disk either way
//
// The feeders are the two reds nobody files (IDEAS/autopilot.md § 4.2): a CI
// run goes red and the terminal is the only record; a stranger installs the
// published packages, the build stalls, and the framework hears nothing. Each
// run files one S3 row per failing unit, in the failure's own words, for the
// fix loop to take.
//
// ci runs `node scripts/ci.mjs` in ~/.fli/feed/ci, a worktree at this tree's
// HEAD: a red on HEAD is a defect, a red on somebody's half-edited working tree
// is noise, and the main tree is never clean. The run's record is read back
// through core/ci-log.js, the reader `fli gui` uses; a `fail` step is red, a
// `warn` is a known failure CI already names.
//
// stranger runs `bunx @frontierjs/cli@<latest> new demo --full --yes --source
// npm` in a temp directory with nothing of this checkout on the path, the
// README's own line, then `bun run check` and `bun run build`; the first step
// that exits non-zero is the stall. The registry is asked first, and no answer is
// `offline`, not red.
//
// What a run may file is `feeders.mjs`: a fixed title per failing unit, so
// the same red finds its own row — an open row is AMENDED (once a day) and a
// closed one cited; a title that reads as an environment failure (a timeout,
// a port held, no Chrome) is logged as `env` and never filed, since a row the
// loop files about the machine is the spiral the cap exists to stop.
//
// --filed is the rows one day of feeders may file, both feeders in one count
// off this log's own lines, hand runs included; a scheduled run reads the day
// cap in the schedule file first. One line per run goes to
// ~/.fli/feed-loop.jsonl with `feeder`, the outcome (green, red, busy,
// offline, failed), `filed` and `amended`, the register ids it touched.
// ============================================================

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync }                                                            from 'node:child_process'
import { join }                                                                 from 'node:path'
import { tmpdir }                                                               from 'node:os'

import { ROOT, LOG_DIR, logOf, appendLog, readLog, parseArgs, printHelp, sourceOf, dayCapRefusal } from './headless.mjs'
import { FEEDERS, overFiledCap, filedToday }                                                        from '../packages/cli/core/autopilot.js'
import { readRuns, activeRun }                                                                      from '../packages/cli/core/ci-log.js'
import { readRegisters, issuesTitled }                                                              from '../packages/cli/core/registers.js'
import { envSmells }                                                                                from '../packages/cli/core/register-check.js'
import { fileIssue }                                                                                from '../packages/cli/core/file.js'
import { amendIssue }                                                                               from '../packages/cli/core/amend.js'
import { STRANGER_STEPS, failuresOf, strangerFailure, detailOf, squash, plan }                      from './feeders.mjs'

const args = parseArgs(process.argv.slice(2))
if (args.help) { printHelp(import.meta.url); process.exit(0) }

const feeder   = args.feeder
const TAG      = `[feed-loop${FEEDERS.includes(feeder) ? ` ${feeder}` : ''}]`
if (!FEEDERS.includes(feeder)) die(`--feeder takes ${FEEDERS.join(' or ')}, not ${JSON.stringify(feeder ?? null)}`)
const source   = sourceOf(args)
const dryRun   = Boolean(args['dry-run'])
const filedCap = Number(args.filed)
const LOG      = logOf('feed')
const FEED_DIR = join(LOG_DIR, 'feed')
const RUNNER   = 'node'

refuse(dayCapRefusal(source))
if (!dryRun) refuse(overFiledCap(filedCap, filedToday(readLog(LOG)), 'feeders'))

// ─── the run ────────────────────────────────────────────────

const t0 = Date.now()
if (!dryRun) appendLog(LOG, { feeder, id: feeder, outcome: 'started', ...(source && { source }) })

const result = feeder === 'ci' ? runCi({ fast: Boolean(args.fast) }) : runStranger({ keep: Boolean(args.keep) })
console.log(`${TAG} ${result.status}${result.note ? ` — ${result.note}` : ''}${result.failures.length ? ` · ${result.failures.length} failing unit(s)` : ''}`)

const doc     = readRegisters(ROOT)
const log     = readLog(LOG)
// A dry run with no cap plans every failure as a filing, so what it would file is what prints.
const planned = plan({ failures: result.failures, titled: t => issuesTitled(doc, t), log, cap: dryRun && !Number.isInteger(filedCap) ? Number.MAX_SAFE_INTEGER : filedCap, filedToday: filedToday(log), smells: envSmells })

for (const f of planned.env)   console.log(`${TAG}   env, not filed: ${f.title}`)
for (const f of planned.skip)  console.log(`${TAG}   ${f.id} amended today already: ${f.title}`)
for (const f of planned.held)  console.log(`${TAG}   held past the cap of ${filedCap}: ${f.title}`)
for (const f of planned.amend) console.log(`${TAG}   ${dryRun ? 'would amend' : 'amend'} ${f.id}: ${f.title}`)
for (const f of planned.file)  console.log(`${TAG}   ${dryRun ? 'would file' : 'file'} S3 · ${f.area} · ${f.title}${f.cites ? ` (came back after ${f.cites})` : ''}`)

const filed   = []
const amended = []
if (!dryRun) {
  for (const f of planned.file) {
    const out = fileIssue({ root: ROOT, severity: 'S3', area: f.area, title: f.title, detail: detailOf(feeder, f, { run: result.run, commit: result.commit, cites: f.cites }) })
    if (out.ok) { filed.push(out.id); console.log(`${TAG}   filed ${out.id}${out.smell ? ' (env-smell: a check will warn)' : ''}`) }
    else console.log(`${TAG}   refused: ${out.reason}`)
  }
  for (const f of planned.amend) {
    const said = feeder === 'ci' ? `${f.label}${f.output ? ` — ${squash(f.output, 300)}` : ''}` : `\`${f.cmd}\` exited ${f.code}${f.output ? ` — ${squash(f.output, 300)}` : ''}`
    const out  = amendIssue({ root: ROOT, id: f.id, detail: `Red again for the ${feeder} feeder${result.run ? ` in run ${result.run}` : ''}${result.commit ? ` at ${result.commit}` : ''}: ${squash(said, 400)}` })
    if (out.ok) { amended.push(out.id); console.log(`${TAG}   amended ${out.id}`) }
    else console.log(`${TAG}   refused: ${out.reason}`)
  }
  appendLog(LOG, {
    feeder, id: feeder, outcome: result.status, note: result.note, minutes: +((Date.now() - t0) / 60000).toFixed(1),
    filed, amended, env: planned.env.map(f => f.title), held: planned.held.length,
    run: result.run, commit: result.commit, where: result.where, ...(source && { source }),
  })
}

console.log(`${TAG} ${result.status} · ${filed.length} filed · ${amended.length} amended · ${planned.env.length} env · ${planned.held.length} held · log ${LOG}`)

// ─── ci: the whole of CI on a worktree at HEAD ──────────────

function runCi({ fast }) {
  const commit = git(ROOT, 'rev-parse', '--short', 'HEAD')
  if (dryRun) {
    const run = readRuns(ROOT).find(r => r.status === 'passed' || r.status === 'failed')
    if (!run) return { status: 'failed', failures: [], note: `no finished run is recorded under ${join(ROOT, '.cache', 'ci-runs')}`, commit }
    return { status: run.status === 'passed' ? 'green' : 'red', failures: failuresOf(run), note: `off the recorded run ${run.id} (${run.scope}), nothing run`, run: run.id, commit: run.commit ?? commit }
  }

  const dir  = join(FEED_DIR, 'ci')
  const held = lock(join(FEED_DIR, 'ci.lock'))
  if (held) return { status: 'busy', failures: [], note: held, commit }

  const head = git(ROOT, 'rev-parse', 'HEAD')
  if (isWorktree(dir)) {
    git(dir, 'reset', '--hard', head)
    git(dir, 'clean', '-fd')
  } else {
    rmSync(dir, { recursive: true, force: true })
    git(ROOT, 'worktree', 'prune')
    git(ROOT, 'worktree', 'add', '--detach', dir, head)
  }
  const going = activeRun(readRuns(dir))
  if (going) return { status: 'busy', failures: [], note: `CI run ${going.id} (pid ${going.pid}) is still going in ${dir}`, commit }

  console.log(`${TAG} bun install in ${dir} @ ${commit}`)
  const installed = spawnSync('bun', ['install'], { cwd: dir, stdio: 'inherit' })
  if (installed.status !== 0) return { status: 'failed', failures: [], note: `bun install exited ${installed.status} in ${dir}`, commit, where: dir }

  console.log(`${TAG} ${RUNNER} scripts/ci.mjs${fast ? ' --fast' : ''} in ${dir}`)
  const ran = spawnSync(RUNNER, ['scripts/ci.mjs', ...(fast ? ['--fast'] : [])], { cwd: dir, stdio: 'inherit', env: { ...process.env, NO_COLOR: '1' } })
  const run = readRuns(dir).find(r => r.status === 'passed' || r.status === 'failed')
  if (!run) return { status: 'failed', failures: [], note: `ci.mjs exited ${ran.status ?? ran.signal} and recorded no finished run`, commit, where: dir }
  return { status: run.status === 'passed' ? 'green' : 'red', failures: failuresOf(run), note: `ci.mjs exited ${ran.status} in ${(run.ms / 60000).toFixed(1)} min`, run: run.id, commit, where: dir }
}

// ─── stranger: fli new from the published packages ──────────

function runStranger({ keep }) {
  const version = latestPublished('@frontierjs/cli')
  if (!version) return { status: 'offline', failures: [], note: 'the npm registry did not answer for @frontierjs/cli, so nothing is red' }

  const app  = 'demo'
  const base = mkdtempSync(join(tmpdir(), 'fjs-stranger-'))
  const dir  = join(base, app)
  const env  = { ...process.env, NO_COLOR: '1' }
  const cmds = {
    new:     { argv: ['bunx', `@frontierjs/cli@${version}`, 'new', app, '--full', '--yes', '--source', 'npm'], cwd: base },
    check:   { argv: ['bun', 'run', 'check'], cwd: dir },
    build:   { argv: ['bun', 'run', 'build'], cwd: dir },
  }

  console.log(`${TAG} @frontierjs/cli@${version} in ${base}`)
  let stall = null
  for (const step of STRANGER_STEPS) {
    const { argv, cwd } = cmds[step]
    console.log(`${TAG}   ${step}: ${argv.join(' ')}`)
    const out = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 20 * 60_000 })
    const code = out.status ?? `signal ${out.signal}`
    if (code === 0) continue
    const output = `${out.stdout ?? ''}\n${out.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n')
    stall = strangerFailure({ step, cmd: argv.join(' '), code, output, version, app })
    break
  }

  if (!stall && !keep) rmSync(base, { recursive: true, force: true })
  return stall
    ? { status: 'red', failures: [stall], note: `stalls at ${stall.step} (exit ${stall.code}); the app is kept at ${dir}`, commit: `@frontierjs/cli@${version}`, where: dir }
    : { status: 'green', failures: [], note: `new, check and build all pass from @frontierjs/cli@${version}`, commit: `@frontierjs/cli@${version}`, where: keep ? dir : undefined }
}

/** The registry's `latest` for `name`, or null when it does not answer: no network is not a red. */
function latestPublished(name) {
  const out = spawnSync('npm', ['view', name, 'version'], { encoding: 'utf8', timeout: 60_000 })
  const v   = (out.stdout ?? '').trim()
  return out.status === 0 && /^\d+\.\d+\.\d+/.test(v) ? v : null
}

// ─── helpers ────────────────────────────────────────────────

function lock(file) {
  mkdirSync(FEED_DIR, { recursive: true })
  const holder = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0
  if (holder && holder !== process.pid && alive(holder)) return `pid ${holder} holds ${file}, a feed-loop still running`
  writeFileSync(file, String(process.pid))
  return null
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
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

function refuse(why) {
  if (why) die(`refused: ${why}`)
}

function die(message) {
  console.error(`${TAG} ${message}`)
  process.exit(1)
}
