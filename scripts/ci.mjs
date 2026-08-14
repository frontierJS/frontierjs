#!/usr/bin/env node
// ============================================================
// Workspace CI runner — the whole of FJS-009 that is not a YAML file
//
//   node scripts/ci.mjs              # everything: hygiene, snapshots, coverage, typecheck, tests
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
//   5. A committed snapshot that no longer matches its source is a FAILURE.
//      Gates and row policies are enforced below the API, so a gate that moved
//      is invisible to every suite until production refuses someone; emitted
//      column names are what an app's hand-written SQL binds to. Each snapshot
//      names its own generator, so the phase never carries a list.
//   6. An app scaffolded against the PACKED working tree must install and
//      build. No suite can ask this: an app in this repo resolves sierra to
//      packages/sierra/, never a node_modules path, so the code that only runs
//      for an installed app runs nowhere here. FJS-251 shipped that way.
//
// Every allowance lives in scripts/ci-allowances.json, keyed by name with a
// reason, so widening the net is a diff and narrowing it is automatic.
// ============================================================

import { spawnSync }                       from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative }         from 'node:path'
import { fileURLToPath }                   from 'node:url'

// The SAME module `fli check` runs against a client app. Imported by relative
// path rather than reimplemented, because a framework that breaks its own stated
// rules is worse than one that never stated them — and the way that happens is
// two copies where only one of them is ever re-derived.
import { runChecks, findApps, formatFindings } from '../packages/cli/core/checks.js'

// Packs the working tree and builds a scaffolded app against it. Its own file
// because the mechanism needs more explaining than the phase does.
import { scaffoldAndBuild, scaffoldAndDeploy } from './scaffold-build.mjs'

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
    structure()
    snapshots()
    coverage()
    scaffold()
    typecheck()
  }
  if (!fast) {
    deploy()
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

  // An allowance is stale only if the file is THERE and no longer ignored.
  // These entries are generated files, so on a clean checkout none of them
  // exists yet — a fresh clone called all of them stale and advised removing
  // them, which would fail the run the moment anyone started a dev server.
  for (const path of Object.keys(allowed)) {
    if (existsSync(join(ROOT, path)) && !ignoredSource.includes(path)) {
      note(`generatedIgnored allowance is stale — ${path} exists and is no longer an ignored source file. Remove it.`)
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

// ─── phase 2 · structure ────────────────────────────────────
// The architecture rules, run over this repo's own apps and packages with the
// same engine `fli check` gives a client app. Nothing here is stylistic: every
// rule is silent when broken, which is the membership test.
//
// It found three things on its first run — a resource file named `leads.mesa`
// with three Resources in it, and an `index.html` whose comment mentioned the
// body tag, so the sierra example's production build shipped no JavaScript at
// all and had been doing so unnoticed.

function structure() {
  const from = phase('structure')

  const allow = allowances.structure ?? {}
  const apps  = findApps(ROOT)
  let  checked = 0

  // Errors carry their own detail rather than going to `notes`, which print at
  // the very bottom — a failure that says "see above" for lines that appear
  // below is how a run gets read as a mystery.
  const report = (label, result, base) => {
    checked += result.ran.length

    const errors = result.findings.filter(f => f.severity === 'error')
    const warns  = result.findings.filter(f => f.severity !== 'error')

    if (errors.length) fail(
      `${label} — ${errors.length} architecture error(s)\n` +
      formatFindings(errors, base).map(l => `    ${l}`).join('\n') + '\n' +
      `      \`fli check\` runs these same rules against a client app; \`--list\` prints the table.\n` +
      `      A genuine exception is a named entry under "structure" in scripts/ci-allowances.json.`
    )
    for (const line of formatFindings(warns, base)) note(`${label} ${line.trim()}`)
    for (const key of result.stale) {
      note(`structure allowance is stale — nothing under ${label} matches ${key}. Remove it.`)
    }
  }

  for (const app of apps) {
    const label = relative(ROOT, app) || '.'
    report(label, runChecks({ root: app, allow: allow[label] ?? {} }), app)
  }

  report('packages', runChecks({ root: ROOT, scope: 'repo', allow: allow['.'] ?? {} }), ROOT)

  if (clean(from)) ok(`${apps.length} app(s), ${checked} rule run(s), no architecture errors`)
}

// ─── phase 3 · snapshots ────────────────────────────────────
// A snapshot is a generated artefact committed beside its source, so a change
// nothing else in the repo can see arrives as a diff. Access rules are enforced
// below the API and a gate that moved is invisible until production refuses
// someone; emitted DDL is a set of names every hand-written statement binds to.
// Both are only a gate because this reruns them.
//
// Each snapshot names the command that wrote it, in its own header:
//
//   <!-- generated by: litestone access --schema schema.lite -->
//   -- generated by: litestone ddl --schema schema.lite
//
// This phase reruns that command with `--check` appended, from the snapshot's
// own directory — which is why the header names the schema by basename and not
// by a path. Adding a KIND of snapshot therefore costs nothing here; it costs a
// generator that answers `--check`.
//
// The command comes out of a file in the repo, so it is restricted to a known
// binary and a shell-free argv. A header is data, and data that CI executes is
// a supply chain.
//
// Opt-in by committing the file. An app with no snapshot is not asked for one —
// a check that fails a repo for not adopting a convention gets disabled. But
// once a snapshot exists it may not quietly stop existing: see
// checkSnapshotsRemoved below, which is where discovery would otherwise fail
// open.

const SNAPSHOT_BINS = new Set(['litestone', 'fli', 'junction', 'sierra'])
const SNAPSHOT_GEN  = /generated by:\s*`?([A-Za-z0-9][^\n`"]*?)`?\s*(?:-->|\*\/|"|$)/m
const SNAPSHOT_ARG  = /^[A-Za-z0-9._/@=,:-]+$/

function snapshots() {
  const from = phase('snapshots')

  const files = git(['ls-files', '*.snapshot.*']).split('\n').filter(Boolean)

  if (!files.length) {
    note('no snapshot is committed anywhere — `litestone access` and `litestone ddl` write one beside a schema')
    return
  }

  for (const file of files) {
    // The header is near the top by convention; reading a slice keeps a large
    // generated file from being parsed in full.
    const head  = readFileSync(join(ROOT, file), 'utf8').slice(0, 4096)
    const found = head.match(SNAPSHOT_GEN)

    if (!found) {
      fail(
        `${file} names no generator, so nothing can check it\n` +
        `      Add a \`generated by: <command>\` line to its header — the command that\n` +
        `      writes it, with the schema named by basename. CI reruns it with --check.`
      )
      continue
    }

    const argv = found[1].trim().split(/\s+/)

    if (!SNAPSHOT_BINS.has(argv[0])) {
      fail(
        `${file} names generator \`${argv[0]}\`, which CI will not run\n` +
        `      Allowed: ${[...SNAPSHOT_BINS].join(', ')}. Add one here only when a real\n` +
        `      generator needs it — this list is what stops a committed file from\n` +
        `      choosing what CI executes.`
      )
      continue
    }

    const bad = argv.slice(1).find(a => !SNAPSHOT_ARG.test(a))
    if (bad) {
      fail(`${file} passes \`${bad}\` to its generator — arguments are plain flags and paths, no shell syntax`)
      continue
    }

    // The litestone CLI is reached through the workspace rather than by a
    // relative path into packages/: a consuming app runs this same check with
    // litestone installed from the registry.
    const result = spawnSync('bunx', [...argv, '--check'], {
      cwd:        join(ROOT, dirname(file)),
      encoding:   'utf8',
      shell:      false,
      maxBuffer:  MAX_BUFFER,
      timeout:    TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env:        { ...process.env, CI: '1', FORCE_COLOR: '0' },
    })

    if (result.error) {
      fail(`${file}: could not run \`${argv.join(' ')}\` — ${result.error.message}`)
      continue
    }

    if (result.status !== 0) {
      fail(
        `${file} no longer matches its source\n` +
        `      Run \`cd ${dirname(file)} && bunx ${argv.join(' ')}\` and read the diff before\n` +
        `      committing — a line that moved without a change you meant to make is a bug\n` +
        `      that ships.`,
        { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
      )
    }
  }

  checkSnapshotsRemoved(files)

  // Guarded on the whole phase — a green summary printed beside a red line is
  // how a failure gets read as noise.
  if (clean(from)) ok(`${files.length} snapshot(s) current`)
}

// ─── a snapshot that stopped existing ───────────────────────
// Discovery is what keeps this phase free of a list, and it fails OPEN: delete a
// committed snapshot and the phase reports one fewer, in green. That is the same
// shape as a package with no `test` script — a skipped check and a passing one
// printing the same thing — which is the first thing this runner exists to
// refuse.
//
// So the expectation comes from the BASE REF rather than from a hand-kept
// registry: a snapshot tracked where this branch left main and absent now has to
// say so. Adding a kind still costs nothing; removing one costs a named entry in
// ci-allowances.json, which is where a deliberate removal belongs anyway.

function checkSnapshotsRemoved(present) {
  const ref = resolveRef(baseRef)
  if (!ref) {
    note(`snapshot removals not checked — \`${baseRef}\` does not resolve here. Pass --base-ref, or set FJS_CI_BASE_REF.`)
    return
  }

  const before = git(['ls-tree', '-r', '--name-only', ref])
    .split('\n')
    .filter(p => /\.snapshot\.[^/]+$/.test(p))

  const now     = new Set(present)
  const allowed = allowances.removedSnapshots ?? {}

  for (const path of before) {
    if (now.has(path)) continue
    if (path in allowed) continue
    fail(
      `${path} was a committed snapshot at ${ref} and is gone\n` +
      `      A generated artefact that stops existing takes its check with it, silently.\n` +
      `      Restore it, or add it to removedSnapshots in scripts/ci-allowances.json with\n` +
      `      the reason it is no longer generated.`
    )
  }

  // A stale allowance is an unenforced rule nobody knows is unenforced — the
  // same treatment `structure` gives its own exceptions.
  for (const path of Object.keys(allowed)) {
    if (now.has(path)) note(`removedSnapshots allowance is stale — ${path} exists again. Remove the entry.`)
  }
}

// ─── phase 4 · coverage ─────────────────────────────────────
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
  const members    = new Set(workspaceDirs())
  const nonMembers = allowances.nonMembers ?? {}
  for (const dir of nestedPackageDirs()) {
    if (members.has(dir) || dir in nonMembers) continue
    note(`${dir} has a package.json and is not a workspace member — uninstalled and untested (FJS-026).`)
  }
  for (const dir of Object.keys(nonMembers)) {
    if (members.has(dir)) {
      fail(`${dir} is listed in nonMembers and IS a workspace member now. Remove the entry.`)
    } else if (!existsSync(join(ROOT, dir, 'package.json'))) {
      note(`nonMembers allowance is stale — ${dir} has no package.json. Remove it.`)
    }
  }

  // Guarded on the whole phase, not just `missing` — a stale exemption is a
  // failure of this phase too, and a green summary printed beside a red line
  // reads as though the red one did not count.
  if (clean(from)) ok(`${workspaceDirs().length} workspace member(s), ${Object.keys(exempt).length} exempt by name`)
}

// ─── phase 5 · typecheck ────────────────────────────────────
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

// ─── phase 5b · scaffold ────────────────────────────────────
// Packs the working tree, scaffolds an app against the tarballs, installs and
// builds it. In the fast tier because it costs ~6s and answers a pre-push
// question: would this change break every app that installs the framework?
//
// The suites cannot ask it. An app in this repo resolves sierra to
// `packages/sierra/`, never a node_modules path, so a whole branch of the Mesa
// plugin never runs here — which is how FJS-251 shipped past 836 green tests.
// scripts/scaffold-build.mjs carries the rest of the reasoning.

function scaffold() {
  const from = phase('scaffold')

  const t0       = Date.now()
  const findings = scaffoldAndBuild({ verbose })

  for (const f of findings) fail(f.message, f.output)
  if (clean(from)) ok('a scaffolded app installs from the working tree and builds', Date.now() - t0)
}

// ─── phase 5c · deploy ──────────────────────────────────────
// `fli new` → `fli make:deploy` → `fli deploy:local`: does the deploy pipeline
// containerise a real app? ~15s and it needs a Docker daemon, so it sits in the
// full tier rather than the pre-push one.
//
// Three defects lived on this path and all three were found by reading, because
// nothing ever ran it: a Dockerfile written against a layout the scaffold does
// not produce (FJS-232), a health check pointed at a path the app does not serve
// so a working deploy was rolled back (FJS-238), and a leaked deploy lock
// (FJS-237).
//
// **A skip is named, never silent.** Without a daemon this reports a note and
// passes, because requiring Docker to run `bun run ci` on a laptop is too much —
// but FJS_CI_REQUIRE_DOCKER=1 turns the skip into a failure, and the workflow
// sets it. A phase that quietly stops running is the failure mode this whole
// file exists to prevent.

function deploy() {
  const from = phase('deploy')

  const t0 = Date.now()
  const { findings, skipped } = scaffoldAndDeploy({ verbose })

  if (skipped) {
    if (process.env.FJS_CI_REQUIRE_DOCKER === '1') {
      fail(`deploy phase skipped and FJS_CI_REQUIRE_DOCKER=1 — ${skipped}`)
    } else {
      note(`deploy phase SKIPPED — ${skipped}. It did not run; set FJS_CI_REQUIRE_DOCKER=1 to make this a failure.`)
      warn(`skipped — ${skipped}`)
    }
    return
  }

  for (const f of findings) fail(f.message, f.output)
  if (clean(from)) ok('a scaffolded app containerises and answers health', Date.now() - t0)
}

// ─── phase 6 · tests ────────────────────────────────────────
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
