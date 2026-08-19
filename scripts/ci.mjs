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
//   7. What this branch did to WHO MAY DO WHAT is printed. The only phase that
//      reports rather than judges, and the only one a person is meant to read
//      every time: access is declared in the seed, so the difference between two
//      branches is computable — which is not true of a framework whose
//      authorization lives in handlers.
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
import { checkSnapshots }                      from '../packages/cli/core/snapshots.js'
import { runRegisterCheck, RULES as REGISTER_RULES } from '../packages/cli/core/register-check.js'
import { FJS_PACKAGES, APP_DEV_DEPS }          from '../packages/cli/core/app-config.js'

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
    registers()
    snapshots()
    access()
    coverage()
    registry()
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

  substratePurity()
}

// ─── phase 1b · substrate purity ────────────────────────────
// `FJS-D26` admits @frontierjs/toolbelt BELOW the dependency graph — litestone
// and mesa may import it, which Invariant 1 would otherwise forbid — and the
// whole of that argument is that the package depends on nothing and computes
// nothing it is not given. A dependency, a clock or a filesystem read makes the
// exemption unsafe, and no consumer's suite would fail: the import still works.
//
// So the rule is stated where it can break a build. It is deliberately blunt —
// a substrate file may import RELATIVELY and nowhere else, which catches a node
// builtin, a workspace sibling and a registry package in one test rather than
// three lists that go stale.

const SUBSTRATE = ['packages/toolbelt']

const AMBIENT = [
  [/\bDate\.now\s*\(|\bnew\s+Date\s*\(|\bperformance\.now\s*\(/, 'reads a clock'],
  [/\bMath\.random\s*\(|\bcrypto\.randomUUID\s*\(/,                    'is nondeterministic'],
  [/\bprocess\.[a-zA-Z]/,                                                'reads the environment'],
  [/\bfetch\s*\(|\bXMLHttpRequest\b/,                                   'talks to the network'],
  [/\brequire\s*\(|\bimport\s*\(/,                                     'loads a module at runtime'],
  [/\bglobalThis\.[a-zA-Z]|\bwindow\.[a-zA-Z]|\bdocument\.[a-zA-Z]/,      'reaches for a global'],
]

function substratePurity() {
  for (const pkg of SUBSTRATE) {
    const from = problems.length
    const manifestPath = join(ROOT, pkg, 'package.json')
    if (!existsSync(manifestPath)) {
      note(`substrate package ${pkg} is named in scripts/ci.mjs and does not exist. Remove it from SUBSTRATE.`)
      continue
    }

    const manifest = readJson(manifestPath)
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      const names = Object.keys(manifest[field] ?? {})
      if (names.length) fail(
        `${pkg} declares ${field}: ${names.join(', ')}\n` +
        `      Substrate depends on nothing — that is what lets litestone and mesa import it\n` +
        `      without routing around Litestone ← Junction ← Sierra (FJS-D26). Either the\n` +
        `      dependency goes, or the ruling does.`
      )
    }

    const files = sourceFilesUnder(join(ROOT, pkg, 'src'))
    for (const file of files) {
      const rel  = relative(ROOT, file)
      const raw  = readFileSync(file, 'utf8')
      const code = stripStrings(stripComments(raw))

      for (const [pattern, why] of AMBIENT) {
        if (pattern.test(code)) fail(
          `${rel} ${why}\n` +
          `      Every export in a substrate package is a pure function: same input, same output.\n` +
          `      The purity is not a house style, it is the licence to be imported from anywhere.`
        )
      }

      for (const spec of importSpecifiers(stripComments(raw))) {
        if (spec.startsWith('.')) continue
        fail(
          `${rel} imports '${spec}'\n` +
          `      A substrate file may only import relatively. A node builtin is I/O, a sibling is a\n` +
          `      workspace dependency, and either one costs the standing FJS-D26 granted.`
        )
      }
    }

    // Only when the package IS clean: a summary that says so under three
    // failures reads as though the failures belong to something else.
    if (clean(from)) ok(`${pkg} — ${files.length} source file(s), no dependency and no ambient capability`)
  }
}

// Comments say what the code must NOT do ("no clock, no filesystem") and a
// string may hold an example, so the patterns run over neither — otherwise the
// rule fails on the paragraph explaining it. The import scan keeps the strings,
// because the specifier IS one; it only drops comments, where a doc block
// showing an example import is not an import.
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function stripStrings(code) {
  return code
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

function importSpecifiers(code) {
  const out = []
  const re  = /\b(?:import|export)\b[^;\n]*?\bfrom\s*['"`]([^'"`]+)['"`]/g
  let m
  while ((m = re.exec(code))) out.push(m[1])
  return out
}

function sourceFilesUnder(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFilesUnder(full))
    else if (/\.(js|mjs|ts)$/.test(entry.name)) out.push(full)
  }
  return out
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

// ─── phase 3 · registers ────────────────────────────────────
// The three registers, graded against the rules they state about themselves.
// `ISSUES.md` says an id is never reused and that one resolves in exactly one
// place; `DECISIONS.md` says a ruling is cited by id. Every one of those was
// held up by attention alone, and the first run found three ids each naming two
// different defects — under a section heading that states the rule.
//
// The engine is `packages/cli/core/register-check.js`, the same module
// `fli register:check` gives a client app, for the same reason `checks.js` is
// shared: two implementations of one rule is how the halves drift.
//
// Errors fail. Warnings are counted per rule rather than listed, because 72
// unnamed rulings printed one per line is a wall that teaches everyone to skip
// the phase — and being thin is a legitimate place to be on the way somewhere.

function registers() {
  const from   = phase('registers')
  const result = runRegisterCheck({ root: ROOT })

  // A warning counts here too, now that every one of them is zero: `72 unnamed
  // rulings` was a backlog and a NEW one is a regression. The clock rule is the
  // exception and is reported instead — CI must not go red overnight on a
  // branch that changed nothing.
  const clockRules = new Set(REGISTER_RULES.filter(r => r.clock).map(r => r.id))
  const graded     = result.findings.filter(f => !clockRules.has(f.rule))

  if (graded.length) fail(
    `${graded.length} register finding(s)\n` +
    graded.map(f =>
      `    ${f.rule}  ${f.id ?? '—'}  ${f.message}\n` +
      `      ${f.file}${f.line ? `:${f.line}` : ''}${f.detail ? `  · ${f.detail}` : ''}`
    ).join('\n') + '\n' +
    `      \`fli register:check\` runs these same rules against a client app; \`--rules\` prints the table.`
  )

  for (const rule of REGISTER_RULES.filter(r => r.clock)) {
    const n = result.byRule[rule.id] ?? 0
    if (n) note(`registers ${rule.id} × ${n} — ${rule.what}. \`fli register:check\` lists them.`)
  }

  const { open, decisions, namedRulings, ideas } = result.counts
  if (clean(from)) ok(`${open} open · ${decisions} rulings (${namedRulings} named) · ${ideas} ideas, every register agrees with itself`)
}

// ─── phase 4 · snapshots ────────────────────────────────────
// A snapshot is a generated artefact committed beside its source, so a change
// nothing else in the repo can see arrives as a diff: the access rules enforced
// below the API, the DDL every hand-written statement binds to, the JSON Schema
// three packages validate against, a route table a rename moves, what a thrown
// value becomes. Each names the command that wrote it in its own header, and
// that command is rerun with `--check` from the file's own directory.
//
// The walk, the header parse, the argv restriction and the rerun all live in
// `packages/cli/core/snapshots.js` — the SAME module `fli test:snapshots` gives
// a client app, for the same reason `checks.js` is shared: a framework that
// publishes the generators and keeps the gate to itself has shipped half a
// feature, and two implementations of one rule is how the halves drift.
//
// What stays here is the half that is about THIS repo's history: a snapshot may
// be absent because an app never adopted one, and that is not a failure — but
// one that existed at the base ref and is gone now is.

function snapshots() {
  const from = phase('snapshots')

  const { results, checked } = checkSnapshots({ root: ROOT, timeoutMs: TIMEOUT_MS, maxBuffer: MAX_BUFFER })

  if (!checked) {
    note('no snapshot anywhere — `litestone access` and `litestone ddl` write one beside a schema')
  }

  for (const r of results) {
    if (r.ok) continue
    fail(
      `${r.file} ${r.error}` +
      (r.argv
        ? `\n      Run \`cd ${r.dir} && bunx ${r.argv.join(' ')}\` and read the diff before\n` +
          `      committing — a line that moved without a change you meant to make is a bug\n` +
          `      that ships.`
        : ''),
      { stdout: r.stdout, stderr: r.stderr }
    )
  }

  checkSnapshotsRemoved(results.map(r => r.file))

  // Guarded on the whole phase — a green summary printed beside a red line is
  // how a failure gets read as noise.
  if (clean(from)) ok(`${checked} snapshot(s) current`)
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

// ─── phase 5 · access ───────────────────────────────────────
// What did this branch do to who may do what.
//
// Every other phase here answers is-this-broken. This one answers a question a
// person has to read, because the framework can derive the answer and no
// reviewer can: `@@gate`, `@@allow`, `@guarded`, a field-level `@allow` and a
// transition gate are declared in the seed, so the difference between two
// branches is computable — where a framework whose authorization lives in
// handlers can only diff the handlers.
//
// It reports and does not fail, and that is the one deliberate exception to this
// runner's rule that a check either passes or fails. A branch that widens access
// is usually a branch doing its job — a new screen for a new role widens. Making
// it red would train everyone to ignore the phase, which is exactly the failure
// mode `knownTestFailures` exists to prevent one line up. The gate is
// `fli test:access --from <ref> --strict`, which belongs on the branch that
// deploys rather than on every push.
//
// It runs the SAME command a client app runs, through bunx, for the reason the
// snapshots phase does: a framework that publishes the generator and keeps the
// gate to itself has shipped half a feature.

function access() {
  const from = phase('access')

  const ref = resolveRef(baseRef)
  if (!ref) {
    note(`access not compared — \`${baseRef}\` does not resolve here. Pass --base-ref, or set FJS_CI_BASE_REF.`)
    console.log(`  ! no baseline — \`${baseRef}\` does not resolve here`)
    return
  }

  const apps = findApps(ROOT).filter(app => existsSync(join(app, 'db', 'schema.lite')))
  let compared = 0

  for (const app of apps) {
    const label = relative(ROOT, app) || '.'
    const run   = spawnSync('bunx', ['litestone', 'access', '--schema', 'db/schema.lite', '--from', ref, '--json'], {
      cwd: app, encoding: 'utf8', shell: false, maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    })

    const result = parseJsonOr(run.stdout ?? '', null)
    if (!result) {
      // A phase that cannot run is not a phase that passed — the same rule the
      // snapshots phase applies to a snapshot naming no generator.
      fail(`${label} — could not compare the access surface against ${ref}\n` +
           `      Run \`cd ${label} && bunx litestone access --schema db/schema.lite --from ${ref}\`.`,
           { stdout: run.stdout ?? '', stderr: run.stderr ?? '' })
      continue
    }

    compared++

    if (!result.baseline.resolved) {
      note(`${label} access not compared — ${result.baseline.note}`)
      continue
    }
    if (result.verdict === 'unchanged') continue

    const mark = result.verdict === 'narrows' ? ok : warn
    mark(`${label} — access ${result.verdict}: ` +
         `${result.counts.widens} widen · ${result.counts.unknown} undecidable · ${result.counts.narrows} narrow`)

    for (const f of result.findings) console.log(`      ${f.access.padEnd(8)} ${f.subject} — ${f.detail}`)
  }

  // Said out loud rather than inferred from silence: zero apps compared and zero
  // changes found print the same nothing otherwise.
  if (clean(from)) ok(`${compared} app(s) compared against ${ref.slice(0, 8)}`)
}

// ─── phase 6 · coverage ─────────────────────────────────────
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

// ─── phase 7 · typecheck ────────────────────────────────────
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

// ─── phase 6b · scaffold ────────────────────────────────────
// Scaffolds an app, packs the working tree into it, installs and builds it. In
// the fast tier because it costs seconds and answers a pre-push question: would
// this change break every app that installs the framework?
//
// The suites cannot ask it. An app in this repo resolves sierra to
// `packages/sierra/`, never a node_modules path, so a whole branch of the Mesa
// plugin never runs here — which is how FJS-251 shipped past 836 green tests.
// scripts/scaffold-build.mjs carries the rest of the reasoning.

// ─── phase 5b · registry ────────────────────────────────────
// Does npm hold what the scaffold tells an app to install?
//
// Every id in `ISSUES.md` is a statement about the WORKING TREE, and a user's
// experience is a function of the tree AND the registry, which move
// independently (FJS-252). So the tree can be green while `fli new` writes a
// package.json that cannot be installed — which is not hypothetical: the
// scaffold started giving every app `@frontierjs/config`, a package that has
// never been published, and the only thing that noticed was the `deploy`
// phase's npm branch failing on an image build minutes later (FJS-267).
//
// This asks the cheap question first and names the package. It is not a
// substitute for the deploy branch — an install that resolves can still fail —
// it is the half that needs no Docker and no minutes.
//
// **A skip is named, never silent**, the same shape the deploy phase uses: with
// no registry reachable this reports a note and passes, and
// FJS_CI_REQUIRE_REGISTRY=1 turns that skip into a failure.

function registry() {
  const from = phase('registry')

  // What `fli new` writes, read from the module that decides it rather than
  // parsed out of the command — a second implementation of "which packages does
  // an app get" is how the two answers drift (FJS-254 was exactly that).
  const scaffolded = [
    ...Object.keys(FJS_PACKAGES),
    ...Object.keys(APP_DEV_DEPS).filter(n => n.startsWith('@frontierjs/')),
  ].sort()

  const t0    = Date.now()
  const state = scaffolded.map(name => [name, npmVersion(name)])

  // Distinguish "the registry said no" from "nobody answered". Every name
  // failing at once is a network story, not fourteen unpublished packages.
  const unreachable = state.filter(([, v]) => v === 'unreachable')
  if (unreachable.length === state.length) {
    const why = 'no answer from the npm registry'
    if (process.env.FJS_CI_REQUIRE_REGISTRY === '1') {
      fail(`registry phase skipped and FJS_CI_REQUIRE_REGISTRY=1 — ${why}`)
    } else {
      note(`registry phase SKIPPED — ${why}. Set FJS_CI_REQUIRE_REGISTRY=1 to make this a failure.`)
      warn(`skipped — ${why}`)
    }
    return
  }

  const known = allowances.knownUnpublished ?? {}

  for (const [name, version] of state) {
    if (version === 'unpublished') {
      if (name in known) {
        note(`${name} is unpublished — known: ${known[name]}`)
        warn(`${name} unpublished (known)`)
      } else fail(
        `the scaffold installs ${name} and npm has never heard of it\n` +
        `      \`fli new --source npm\` writes it into an app's package.json, so the install fails\n` +
        `      and the app never starts. Publish it, take it out of FJS_PACKAGES / APP_DEV_DEPS in\n` +
        `      packages/cli/core/app-config.js, or name it under knownUnpublished in\n` +
        `      scripts/ci-allowances.json with the reason.`
      )
      continue
    }
    // The ratchet: an allowance that is no longer true is a failure, so the
    // entry disappears on the release that publishes the package rather than
    // outliving it silently.
    if (name in known && version !== 'unreachable') fail(
      `${name} is published (${version}) and still listed under knownUnpublished — remove the entry.`
    )
  }

  // Everything above asks whether a NAME resolves. A published manifest can
  // also name a sibling VERSION that does not exist, and then the install fails
  // for a package the registry is perfectly happy to serve. `bun publish`
  // rewrites a `workspace:*` spec out of bun.lock rather than out of the
  // sibling's manifest, so a release that bumps a sibling without refreshing
  // the lock pins every dependent to the version it just bumped away — five
  // packages shipped that way, each an install that could not resolve
  // (FJS-314). Nothing but the `deploy` phase's npm branch would notice, and
  // that costs Docker and minutes.
  //
  // npm is asked to resolve each spec rather than semver being reimplemented
  // here: it answers a version for anything satisfiable, exact pin and range
  // alike, and E404s when nothing is. A range resolving to something OLD is not
  // a failure — it installs, which is the question being asked.
  let pins = 0
  for (const [name, version] of state) {
    if (version === 'unpublished' || version === 'unreachable') continue
    for (const [sibling, range] of publishedSiblingRanges(name)) {
      pins++
      if (npmSatisfiable(`${sibling}@${range}`)) continue
      fail(
        `${name}@${version} names ${sibling}@${range}, which npm cannot resolve\n` +
        `      Every install of ${name} fails on it, and no check above this one can see that —\n` +
        `      they ask whether a NAME resolves. A release that bumps a sibling without refreshing\n` +
        `      bun.lock pins its dependents to the version it bumped away (FJS-314). Publish the\n` +
        `      missing version, or republish ${name} against one that exists.`
      )
    }
  }

  // The version gap is NOT a failure — a package ahead of the registry is the
  // normal state between releases. It is reported because it is the thing the
  // register cannot see: a scaffold template written against behaviour only the
  // tree has, installed from a registry that does not have it yet.
  const ahead = state
    .filter(([, v]) => v !== 'unpublished' && v !== 'unreachable')
    .map(([name, published]) => [name, published, localVersion(name)])
    .filter(([, published, local]) => local && published !== local)
  if (ahead.length) {
    note(
      `${ahead.length} scaffolded package(s) differ between tree and registry: ` +
      ahead.map(([n, p, l]) => `${n} ${l}≠${p}`).join(', ') +
      ` — a template written against the tree is installed against the registry.`
    )
  }

  if (clean(from)) ok(
    `${state.length} scaffolded package(s), every one of them installable, ` +
    `${pins} published sibling pin(s) resolve`, Date.now() - t0)
}

// `npm view` is the same question `fli ws:npm` asks; this is a plain-node
// caller of it rather than a copy of that command, because ci.mjs cannot run a
// markdown command. Answers three things and never throws: the published
// version, `unpublished` (E404 — an answer), or `unreachable` (no answer).
function npmVersion(name) {
  const r = spawnSync('npm', ['view', name, 'version'], {
    cwd: ROOT, encoding: 'utf8', shell: false, timeout: 30_000,
  })
  if (r.status === 0) return (r.stdout ?? '').trim()
  const text = `${r.stderr ?? ''}${r.stdout ?? ''}`
  return /E404|is not in this registry|404 Not Found/.test(text) ? 'unpublished' : 'unreachable'
}

// The sibling dependencies of a package's PUBLISHED latest — what an install
// actually tries to resolve, which is not what the tree's manifest says. An
// OPTIONAL peer is left out: it is allowed to go unmet, so an unresolvable one
// is not a broken install. Answers `[]` for anything it could not read, since
// the reachability story is told once, above.
function publishedSiblingRanges(name) {
  const r = spawnSync('npm', ['view', name, '--json'], {
    cwd: ROOT, encoding: 'utf8', shell: false, timeout: 30_000,
  })
  if (r.status !== 0) return []
  let doc
  try { doc = JSON.parse(r.stdout) } catch { return [] }
  if (Array.isArray(doc)) doc = doc[doc.length - 1]   // more than one dist-tag on a version
  const optional = doc?.peerDependenciesMeta ?? {}
  const peers    = Object.entries(doc?.peerDependencies ?? {}).filter(([n]) => !optional[n]?.optional)
  return [...Object.entries(doc?.dependencies ?? {}), ...peers]
    .filter(([dep]) => dep.startsWith('@frontierjs/') || dep === 'create-frontier')
}

// Can npm resolve this spec? Exact pin and range alike — npm does the semver so
// this does not. **Unreachable counts as resolvable**: a network failure is
// already reported once, above, and a second reading of it as a broken manifest
// would be a false accusation against a package that is fine.
function npmSatisfiable(spec) {
  const r = spawnSync('npm', ['view', spec, 'version'], {
    cwd: ROOT, encoding: 'utf8', shell: false, timeout: 30_000,
  })
  if (r.status === 0) return true
  const text = `${r.stderr ?? ''}${r.stdout ?? ''}`
  return !/E404|No match found for version|is not in this registry|404 Not Found/.test(text)
}

function localVersion(name) {
  const dir = name.replace('@frontierjs/', '')
  const manifest = join(ROOT, 'packages', dir, 'package.json')
  return existsSync(manifest) ? (readJson(manifest).version ?? null) : null
}

function scaffold() {
  const from = phase('scaffold')

  const t0       = Date.now()
  const findings = scaffoldAndBuild({ verbose })

  for (const f of findings) fail(f.message, f.output)
  if (clean(from)) ok('a scaffolded app installs from the working tree and builds', Date.now() - t0)
}

// ─── phase 6c · deploy ──────────────────────────────────────
// `fli new` → `fli make:deploy` → `fli deploy:local`: does the deploy pipeline
// containerise a real app? ~30s and it needs a Docker daemon, so it sits in the
// full tier rather than the pre-push one.
//
// Three defects lived on this path and all three were found by reading, because
// nothing ever ran it: a Dockerfile written against a layout the scaffold does
// not produce (FJS-232), a health check pointed at a path the app does not serve
// so a working deploy was rolled back (FJS-238), and a leaked deploy lock
// (FJS-237).
//
// **Both package sources, because they answer different questions.** `npm` is
// the only thing in this repo that tests the PUBLISHED framework — every id in
// the register is a statement about the working tree, and the two drift
// independently (FJS-252). `local` is the working tree containerised, which was
// impossible until the build started packing the tree into its own context
// (FJS-241) and is therefore the half most likely to break again.
//
// **The container is then asked to sign someone in.** A health answer says the
// process is up; it does not say the app WORKS. `scaffoldAndDeploy`'s smoke
// registers and logs in at the prefix the scaffold's own web config names, which
// is the one thing that can see a template written against behaviour only the
// tree has — an app that installs, builds, answers health and cannot log in
// (FJS-252, closed by this). On the `npm` branch it is the published framework
// answering.
//
// **A skip is named, never silent.** Without a daemon this reports a note and
// passes, because requiring Docker to run `bun run ci` on a laptop is too much —
// but FJS_CI_REQUIRE_DOCKER=1 turns the skip into a failure, and the workflow
// sets it. A phase that quietly stops running is the failure mode this whole
// file exists to prevent.

// **A source can be a named known failure**, in `knownDeployFailures`, and the
// case it exists for is publish order: the scaffold gives an app a package this
// repo has written and nobody has published, so the `npm` branch cannot resolve
// it and says so by name. That is the branch working — it is the only thing here
// that grades the registry — but it is not a defect anyone can fix in the tree.
// The entry ratchets like every other: the day the package is published, the
// branch passes and a stale allowance fails CI.

function deploy() {
  const from = phase('deploy')

  const t0     = Date.now()
  const known  = allowances.knownDeployFailures ?? {}
  const fixed  = []

  for (const source of ['npm', 'local']) {
    const { findings, skipped } = scaffoldAndDeploy({ source, verbose })

    if (skipped) {
      if (process.env.FJS_CI_REQUIRE_DOCKER === '1') {
        fail(`deploy phase skipped and FJS_CI_REQUIRE_DOCKER=1 — ${skipped}`)
      } else {
        note(`deploy phase SKIPPED — ${skipped}. It did not run; set FJS_CI_REQUIRE_DOCKER=1 to make this a failure.`)
        warn(`skipped — ${skipped}`)
      }
      return
    }

    if (!findings.length) {
      if (source in known) fixed.push(source)
      continue
    }

    if (source in known) {
      note(`--source ${source} failed — known: ${known[source]}`)
      warn(`--source ${source} (known failure)`)
      continue
    }

    for (const f of findings) fail(`--source ${source}: ${f.message}`, f.output)
  }

  for (const source of fixed) {
    if (update) {
      delete allowances.knownDeployFailures[source]
      note(`--source ${source} now passes — removed from knownDeployFailures.`)
    } else {
      fail(
        `--source ${source} is listed in knownDeployFailures and now PASSES.\n` +
        `      Remove the entry, or run with --update. A stale allowance stops CI seeing the next real failure.`
      )
    }
  }

  if (update && fixed.length) saveAllowances()

  if (clean(from)) ok('a scaffolded app containerises and answers health, from npm and from the tree', Date.now() - t0)
}

// ─── phase 8 · tests ────────────────────────────────────────
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

// ─── GitHub annotations ─────────────────────────────────────
//
// What a failing run says to someone who cannot read its logs — which is
// everyone but a repository admin, because the Actions logs endpoint answers
// `Must have admin rights to Repository` even for a public repo. Check-run
// annotations are public, and until this existed the whole of what a ci.mjs
// failure told a reader was `Process completed with exit code 1` (FJS-009).
//
// vitest already annotates its own failures — that is how the mesa fixture bug
// was read off a runner with no credentials — and every phase that is not a
// suite had nothing at all.
//
// Runner only: the escaping is noise in a terminal.

function annotate(level, message) {
  if (!process.env.GITHUB_ACTIONS) return
  const title = String(message).split('\n')[0].slice(0, 120)
  console.log(`::${level} title=${escapeProp(title)}::${escapeData(message)}`)
}

// The workflow-command grammar: a raw newline ends the command and a bare `%`
// reads as the start of one of these escapes, so both have to go first.
function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

function escapeProp(value) {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

function report() {
  const seconds = ((Date.now() - started) / 1000).toFixed(1)

  if (notes.length) {
    console.log(`\n─── notes ${'─'.repeat(45)}`)
    for (const n of notes) { console.log(`  · ${n}`); annotate('notice', n) }
  }

  if (!problems.length) {
    console.log(`\n✓ CI passed in ${seconds}s${fast ? ' (fast tier — suites not run)' : ''}\n`)
    process.exit(0)
  }

  console.log(`\n─── ${problems.length} failure(s) ${'─'.repeat(35)}`)
  for (const p of problems) {
    const output = outputText(p.output)
    console.log(`\n✗ ${p.message}`)
    if (output) console.log(output)
    annotate('error', output ? `${p.message}\n\n${output.slice(0, 4000)}` : p.message)
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
// A phase reports its output in one of two shapes and both reach here: a spawned
// suite carries `{stdout, stderr}`, and a phase that ran something itself — the
// deploy pipeline, the scaffold — carries the text it captured. Destructuring a
// string yields three undefineds, so the second shape printed NOTHING under its
// finding and annotated as `[object Object]`.
function outputText(output) {
  if (!output) return ''
  return typeof output === 'string' ? output : renderOutput(output)
}

function renderOutput({ stdout, stderr, ci }) {
  const parts = []
  // A phase that reports its own `ci` note carries neither stream, and the
  // reporter runs last — a throw here loses the whole run's summary.
  if (stdout?.trim()) parts.push(indent(`── stdout ──\n${tail(stdout, 30)}`))
  if (stderr?.trim()) parts.push(indent(`── stderr ──\n${tail(stderr, 30)}`))
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
