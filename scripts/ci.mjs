#!/usr/bin/env node
// ============================================================
// Workspace CI runner — the whole of FJS-009 that is not a YAML file
//
//   node scripts/ci.mjs              # everything: hygiene, coverage, typecheck, tests
//   node scripts/ci.mjs --fast       # everything except the test suites (the pre-push tier)
//   node scripts/ci.mjs --tests-only # just the suites
//   node scripts/ci.mjs --update     # write ratchet improvements back to ci-allowances.json
//
// Provider-independent on purpose. A GitHub workflow, a git hook and a person
// at a terminal all run this same file, so moving off GitHub costs a delete.
//
// It does four things that `bun run --filter '*' test` cannot:
//
//   1. A package with no `test` script is a FAILURE, not a silent pass. Three
//      packages were invisible to the aggregate scripts and nothing said so;
//      a skipped package and a green one printed the same thing.
//   2. A source file that .gitignore hides is a FAILURE. `build/` in .gitignore
//      hid 20 files of Sierra's build pipeline — every suite green, a fresh
//      clone with no prerenderer.
//   3. A RAISED typecheck baseline is a failure (Invariant 14). The ratchet was
//      honour-system; nothing enforced the direction.
//   4. A known-failing suite is named, so a NEW failure is loud. One package
//      failing today makes the aggregate exit 1 forever, which trains everyone
//      to ignore the exit code.
//
// Every allowance lives in scripts/ci-allowances.json, keyed by name with a
// reason, so widening the net is a diff and narrowing it is automatic.
// ============================================================

import { spawnSync }                       from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative }         from 'node:path'
import { fileURLToPath }                   from 'node:url'

const ROOT       = resolveRoot()
const ALLOWANCES = join(ROOT, 'scripts', 'ci-allowances.json')

const args      = process.argv.slice(2)
const fast      = args.includes('--fast')
const testsOnly = args.includes('--tests-only')
const update    = args.includes('--update')
const verbose   = args.includes('--verbose')
const baseRef   = readFlag(args, '--base-ref') ?? process.env.FJS_CI_BASE_REF ?? 'origin/main'
// Narrows the typecheck and test phases to one package. Coverage and hygiene
// are repo-wide questions and ignore it.
const only      = readFlag(args, '--only')

// A suite that hangs is the one failure mode that costs more than the bug.
// css drives a real Chrome and litestone applies migrations, so the ceiling is
// generous; it exists to end a hang, not to police a slow suite.
const TIMEOUT_MS = Number(process.env.FJS_CI_TIMEOUT_MS ?? 15 * 60 * 1000)

// `git ls-files --others --ignored` lists every file under node_modules —
// 8090 lines here, well past spawnSync's 1MB default, where it fails with
// ENOBUFS and a null status. A helper that treated that as "no output" reported
// a clean hygiene phase over a repo it had never read.
const MAX_BUFFER = 64 * 1024 * 1024

const allowances = loadAllowances()
const problems   = []   // fatal — sets the exit code
const notes      = []   // worth saying, does not fail the run

let _dirs = null        // workspaceDirs() memo — declared here so the phases,
                        // which run at module top level, are not in its TDZ

const started = Date.now()

// Called from the very bottom of the file. Function declarations hoist and
// `const` does not, so running the phases from up here puts every helper
// constant below them in its temporal dead zone — which throws at the first
// one that is not a function.
function main() {
  if (!testsOnly) {
    hygiene()
    coverage()
    typecheck()
  }
  if (!fast) {
    tests()
  }
  report()
}

// ─── phase 1 · hygiene ──────────────────────────────────────
// Everything here is about the difference between THIS working copy and a
// fresh clone. Both incidents this catches were invisible on the machine that
// created them and total on every other one.

function hygiene() {
  phase('hygiene')

  const ignoredSource = git(['ls-files', '--others', '--ignored', '--exclude-standard'])
    .split('\n')
    .filter(Boolean)
    .filter(isSourcePath)

  const allowed   = allowances.generatedIgnored ?? {}
  const unexpected = ignoredSource.filter(p => !(p in allowed))

  for (const path of unexpected) {
    fail(
      `.gitignore hides a source file: ${path}\n` +
      `      A fresh clone will not have it. If it is GENERATED, add it to generatedIgnored in\n` +
      `      scripts/ci-allowances.json with the reason. If it is source, un-ignore it —\n` +
      `      \`build/\` once hid 20 files of Sierra's build pipeline with every suite green.`
    )
  }

  for (const path of Object.keys(allowed)) {
    if (!ignoredSource.includes(path)) {
      note(`generatedIgnored allowance is stale — ${path} is no longer an ignored source file. Remove it.`)
    }
  }

  // Untracked-but-not-ignored files are absent from a fresh clone too, but
  // mid-edit scratch is normal on a developer's machine, so this only speaks up.
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)
  if (untracked.length) {
    note(`${untracked.length} untracked file(s) — absent from a fresh clone: ${untracked.slice(0, 5).join(', ')}${untracked.length > 5 ? ', …' : ''}`)
  }

  if (!unexpected.length) ok(`${ignoredSource.length} ignored source file(s), all accounted for`)
}

// ─── phase 2 · coverage ─────────────────────────────────────
// Skipped is not passed. The aggregate `--filter '*'` walks straight past a
// package with no `test` script and prints nothing at all about it.

function coverage() {
  const from = phase('coverage')

  const exempt  = allowances.exemptPackages ?? {}
  const missing = []

  for (const dir of workspaceDirs()) {
    const pkgPath = join(ROOT, dir, 'package.json')
    const pkg     = existsSync(pkgPath) ? readJson(pkgPath) : null
    const hasTest = Boolean(pkg?.scripts?.test)

    if (hasTest && dir in exempt) {
      fail(
        `${dir} is exempt in scripts/ci-allowances.json and now HAS a test script. ` +
        `Remove the exemption — an exemption that is not needed hides the next one that is.`
      )
      continue
    }
    if (!hasTest && !(dir in exempt)) {
      missing.push(dir)
      continue
    }
    if (pkg && !pkg.scripts?.typecheck && !(dir in exempt)) {
      note(`${dir} has no \`typecheck\` script — Invariant 14's ratchet cannot see it.`)
    }
  }

  for (const dir of missing) {
    fail(
      `${dir} has no \`test\` script and is not exempt.\n` +
      `      Give it one, or add it to exemptPackages in scripts/ci-allowances.json with the reason.`
    )
  }

  // FJS-026: the workspace glob is one level deep, so a package nested inside
  // another is uninstalled, untested and unrunnable — and says nothing.
  const members = new Set(workspaceDirs())
  for (const dir of nestedPackageDirs()) {
    if (!members.has(dir)) note(`${dir} has a package.json and is not a workspace member — uninstalled and untested (FJS-026).`)
  }

  // Guarded on the whole phase, not just `missing` — a stale exemption is a
  // failure of this phase too, and a green summary printed beside a red line
  // reads as though the red one did not count.
  if (clean(from)) ok(`${workspaceDirs().length} workspace member(s), ${Object.keys(exempt).length} exempt by name`)
}

// ─── phase 3 · typecheck ────────────────────────────────────
// Two halves: the direction of the ratchet (a git question) and the count
// itself (each package's own script already answers that, and exits 1 above
// its ceiling).

function typecheck() {
  phase('typecheck')

  checkBaselineDirection()

  for (const dir of selectedDirs()) {
    const pkg = readPackage(dir)
    if (!pkg?.scripts?.typecheck) continue

    const run = runScript(dir, 'typecheck')
    if (run.code !== 0) {
      fail(`${dir} typecheck exited ${run.code}`, run.output)
      continue
    }
    // scripts/typecheck.mjs prints this when a package has improved and nobody
    // locked the improvement in. Not a failure — an unclaimed one.
    const improved = /below the baseline of (\d+)/.exec(`${run.output.stdout}${run.output.stderr}`)
    if (improved) note(`${dir} is below its baseline of ${improved[1]} — run \`bun run typecheck -- --update\` in it.`)
    ok(`${dir}`, run.ms)
  }
}

// A baseline can only be lowered. Comparing the working tree against the base
// ref is the only way to see a RAISE — the per-package script cannot, since a
// raised ceiling makes its own count legal.
function checkBaselineDirection() {
  const file = 'scripts/typecheck-baselines.json'
  const ref  = resolveRef(baseRef)

  if (!ref) {
    note(`baseline direction not checked — \`${baseRef}\` does not resolve here. Pass --base-ref, or set FJS_CI_BASE_REF.`)
    return
  }

  const beforeRaw = gitShow(`${ref}:${file}`)
  if (beforeRaw === null) {
    note(`baseline direction not checked — ${file} does not exist at ${ref}.`)
    return
  }

  const before = parseJsonOr(beforeRaw, {})
  const after  = readJson(join(ROOT, file))
  let raised   = false

  for (const [pkg, count] of Object.entries(after)) {
    if (pkg.startsWith('//')) continue
    const was = Number.isFinite(before[pkg]) ? before[pkg] : 0
    if (count > was) {
      raised = true
      fail(
        `typecheck baseline for ${pkg} was RAISED ${was} → ${count} against ${ref} (Invariant 14).\n` +
        `      Fix the regression instead. A deliberate raise needs a ruling in DECISIONS.md.`
      )
    }
  }

  if (!raised) ok(`baselines never raised against ${ref}`)
}

// ─── phase 4 · tests ────────────────────────────────────────
// Sequential on purpose: several suites bind ports and start real servers, and
// interleaved output from four different runners is unreadable when one fails.

function tests() {
  phase('tests')

  const known  = allowances.knownTestFailures ?? {}
  const passed = []
  const fixed  = []

  for (const dir of selectedDirs()) {
    const pkg = readPackage(dir)
    if (!pkg?.scripts?.test) continue

    const run = runScript(dir, 'test')

    if (run.code === 0) {
      if (dir in known) fixed.push(dir)
      else passed.push(dir)
      ok(`${dir}`, run.ms)
      continue
    }

    if (dir in known) {
      note(`${dir} failed — known: ${known[dir]}`)
      warn(`${dir} (known failure)`, run.ms)
      continue
    }

    fail(`${dir} test exited ${run.code}`, run.output)
  }

  for (const dir of fixed) {
    if (update) {
      delete allowances.knownTestFailures[dir]
      note(`${dir} now passes — removed from knownTestFailures.`)
    } else {
      fail(
        `${dir} is listed in knownTestFailures and now PASSES.\n` +
        `      Remove the entry, or run with --update. A stale allowance stops CI seeing the next real failure.`
      )
    }
  }

  if (update && fixed.length) saveAllowances()
  ok(`${passed.length} suite(s) green`)
}

// ─── running a package's own script ─────────────────────────

function runScript(dir, script) {
  const cwd = join(ROOT, dir)
  const pm  = packageManagerFor(dir)
  const at  = Date.now()

  // A carriage return only erases on a terminal. Piped to a file — which is
  // what a workflow log is — it stays in the text and the "running…" line is
  // left padded across the result. So only draw progress when someone is
  // watching it happen.
  const pending = process.stdout.isTTY ? `  · ${dir} ${script}…` : ''
  if (pending) process.stdout.write(pending)

  const result = spawnSync(pm, ['run', script], {
    cwd,
    encoding:   'utf8',
    shell:      false,
    maxBuffer:  MAX_BUFFER,
    timeout:    TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env:        { ...process.env, CI: '1', FORCE_COLOR: '0' },
  })

  // A bare \r leaves the "running…" text under the result, since the result is
  // shorter for a package with a long name. Blank the line before writing it.
  if (pending) process.stdout.write(`\r${' '.repeat(pending.length)}\r`)

  // Kept apart, not concatenated. A runner writes its assertions to stdout and
  // its warnings to stderr, so a tail of the two glued together is a tail of
  // whichever came second — jetty's failing assertion sat 20 lines above the
  // end of stdout and every line shown was a mesa warning.
  const output = { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  const ms     = Date.now() - at

  if (verbose) console.log(`${output.stdout}${output.stderr}`)

  if (result.error) return { code: 2, output: { ...output, ci: result.error.message }, ms }
  // spawnSync reports a timeout as a null status plus the signal it used.
  if (result.signal) return { code: 2, output: { ...output, ci: `killed by ${result.signal} after ${TIMEOUT_MS}ms` }, ms }

  return { code: result.status ?? 2, output, ms }
}

// Everything here runs under bun except the extension, whose own scripts shell
// out to `npm run build` and whose toolchain (tsc, vsce) is npm's. Running it
// under bun works by accident today; naming it keeps the accident from being
// load-bearing. CLAUDE.md § Running things states the same split.
function packageManagerFor(dir) {
  return dir === 'packages/frontierjs-vscode' ? 'npm' : 'bun'
}

// ─── the workspace ──────────────────────────────────────────

// Every directory under packages/ — including the four with no package.json,
// which is the whole point: a directory that installs nothing must still be
// answered for by name.
function workspaceDirs() {
  if (_dirs) return _dirs

  const fromGlobs = new Set()
  const root      = readJson(join(ROOT, 'package.json'))

  for (const pattern of root.workspaces ?? []) {
    if (pattern.endsWith('/*')) {
      const parent = pattern.slice(0, -2)
      for (const entry of readdirSync(join(ROOT, parent), { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) fromGlobs.add(`${parent}/${entry.name}`)
      }
    } else {
      fromGlobs.add(pattern)
    }
  }

  _dirs = [...fromGlobs].sort()
  return _dirs
}

function selectedDirs() {
  if (!only) return workspaceDirs()
  const match = workspaceDirs().filter(d => d === only || d.endsWith(`/${only}`))
  if (!match.length) {
    console.error(`[ci] --only ${only} matches no workspace member`)
    process.exit(2)
  }
  return match
}

// A package.json more than one level under packages/ — invisible to the glob.
function nestedPackageDirs() {
  const found = []
  const walk  = (dir, depth) => {
    if (depth > 3) return
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue
      const child = `${dir}/${entry.name}`
      if (existsSync(join(ROOT, child, 'package.json'))) found.push(child)
      walk(child, depth + 1)
    }
  }
  walk('packages', 1)
  return found
}

function readPackage(dir) {
  const path = join(ROOT, dir, 'package.json')
  return existsSync(path) ? readJson(path) : null
}

// ─── git ────────────────────────────────────────────────────

// A git helper that answers '' on failure makes an empty repo and a broken
// invocation the same answer, and the hygiene phase then passes by reporting
// nothing. Only the callers that expect a miss (resolveRef, gitShow) are
// allowed to swallow one.
function git(argv) {
  const r = spawnSync('git', argv, { cwd: ROOT, encoding: 'utf8', shell: false, maxBuffer: MAX_BUFFER })
  if (r.error || r.status !== 0) {
    console.error(`[ci] git ${argv.join(' ')} failed: ${r.error?.message ?? r.stderr ?? `exit ${r.status}`}`)
    process.exit(2)
  }
  return (r.stdout ?? '').trim()
}

function resolveRef(ref) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: ROOT, encoding: 'utf8', shell: false })
  if (r.status !== 0) return null
  // Compare against the point the branch left the base, not the base's tip —
  // otherwise every commit landed on main since branching reads as this
  // branch's change.
  const base = spawnSync('git', ['merge-base', 'HEAD', ref], { cwd: ROOT, encoding: 'utf8', shell: false })
  return base.status === 0 ? (base.stdout ?? '').trim() : (r.stdout ?? '').trim()
}

function gitShow(spec) {
  const r = spawnSync('git', ['show', spec], { cwd: ROOT, encoding: 'utf8', shell: false })
  return r.status === 0 ? (r.stdout ?? '') : null
}

// ─── reporting ──────────────────────────────────────────────

// Returns the failure count at the start of the phase, so a phase can ask
// whether it is still clean before printing a summary that says so.
function phase(name) {
  console.log(`\n─── ${name} ${'─'.repeat(Math.max(0, 50 - name.length))}`)
  return problems.length
}

function clean(from) {
  return problems.length === from
}

function ok(message, ms) {
  console.log(`  ✓ ${message}${ms ? ` (${(ms / 1000).toFixed(1)}s)` : ''}`)
}

function warn(message, ms) {
  console.log(`  ! ${message}${ms ? ` (${(ms / 1000).toFixed(1)}s)` : ''}`)
}

function fail(message, output) {
  problems.push({ message, output })
  console.log(`  ✗ ${message}`)
}

function note(message) {
  notes.push(message)
}

function report() {
  const seconds = ((Date.now() - started) / 1000).toFixed(1)

  if (notes.length) {
    console.log(`\n─── notes ${'─'.repeat(45)}`)
    for (const n of notes) console.log(`  · ${n}`)
  }

  if (!problems.length) {
    console.log(`\n✓ CI passed in ${seconds}s${fast ? ' (fast tier — suites not run)' : ''}\n`)
    process.exit(0)
  }

  console.log(`\n─── ${problems.length} failure(s) ${'─'.repeat(35)}`)
  for (const p of problems) {
    console.log(`\n✗ ${p.message}`)
    if (p.output) console.log(renderOutput(p.output))
  }
  console.log(`\n✗ CI failed in ${seconds}s\n`)
  process.exit(1)
}

// ─── helpers ────────────────────────────────────────────────

function loadAllowances() {
  const raw = parseJsonOr(readFileSync(ALLOWANCES, 'utf8'), null)
  if (!raw) {
    console.error(`[ci] scripts/ci-allowances.json is missing or not valid JSON`)
    process.exit(2)
  }
  return raw
}

function saveAllowances() {
  writeFileSync(ALLOWANCES, `${JSON.stringify(allowances, null, 2)}\n`)
}

function readJson(path) {
  return parseJsonOr(readFileSync(path, 'utf8'), {})
}

function parseJsonOr(text, fallback) {
  try { return JSON.parse(text) } catch { return fallback }
}

function readFlag(argv, name) {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

const SOURCE_EXT = /\.(js|mjs|cjs|ts|tsx|mesa|lite|sql|css)$/
const OUTPUT_DIR = /(^|\/)(dist|out|build|coverage|\.cache|tmp|temp|\.fli-tmp|\.preview|\.vscode|\.idea)\//
const VENDOR     = /(^|\/)node_modules\//

// `build/` is on the output list AND is a real source directory here — Sierra's
// and jetty's pipelines live at src/build/, which is the exact pair .gitignore
// got wrong. So anything under a src/ is source wherever it sits, and the
// output-directory names only decide the rest. Vendor is tested FIRST: a
// dependency ships its own src/ and would otherwise walk straight through that
// override — 30 files of tldts did.
function isSourcePath(path) {
  if (VENDOR.test(path))      return false
  if (!SOURCE_EXT.test(path)) return false
  if (path.includes('/src/')) return true
  return !OUTPUT_DIR.test(path)
}

// Both streams get their own tail, labelled, because either one alone can be
// the whole story and neither is reliably the one that carries it.
function renderOutput({ stdout, stderr, ci }) {
  const parts = []
  if (stdout.trim()) parts.push(indent(`── stdout ──\n${tail(stdout, 30)}`))
  if (stderr.trim()) parts.push(indent(`── stderr ──\n${tail(stderr, 30)}`))
  if (ci)            parts.push(indent(`── ci ──\n${ci}`))
  return parts.join('\n')
}

function tail(text, lines) {
  const all = text.split('\n')
  return all.length <= lines ? text : all.slice(-lines).join('\n')
}

function indent(text) {
  return text.split('\n').map(l => `    ${l}`).join('\n')
}

// The script must work from any cwd — a git hook runs it from the repo root, a
// person runs it from wherever they are.
function resolveRoot() {
  const here = dirname(fileURLToPath(import.meta.url))
  return dirname(here)
}

main()
