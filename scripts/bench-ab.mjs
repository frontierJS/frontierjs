// scripts/bench-ab.mjs — the REPORTED tier's runner: this tree's timings against a
// base ref's, measured in one job.
//
//   node scripts/bench-ab.mjs                     against HEAD, six rounds
//   node scripts/bench-ab.mjs --from main         against where this branch left main
//   node scripts/bench-ab.mjs --only litestone --rounds 10
//
// A timing is compared in the same job and never across jobs, so the base ref is
// checked out into a worktree and both sides run here, alternating — NEW, OLD,
// OLD, NEW — so drift on the machine lands on both. Each case reports the min
// over the rounds, how many rounds each side won, and `~` when the two sides'
// spreads overlap, which is a difference this run cannot tell from noise. A
// package rolls up as the geomean of its cases (IDEAS/performance-regression-watch.md
// § Reported).
//
// What a package declares is `bench/cases.mjs`: run as `bun bench/cases.mjs
// --json` it prints one `BENCH_CASES {declared, cases: [{name, ceiling, us,
// floorUs} | {name, ceiling, error}]}` line, through the loop in
// scripts/bench-round.mjs. The BRANCH's case file and loop are copied over the
// base's before the base runs, so the harness is one and the difference is the
// code under it — two harnesses measure the harness.
//
// Nothing here fails on a time: a timing red on a shared runner trains everyone
// to skip the phase. It fails on a case that THREW, a case with no ceiling, and
// fewer cases run than declared, because a case that quietly stops running reads
// as a quiet run (`gate-getlevel` died and was skipped for three weeks).
//
// Plain node: scripts/ci.mjs imports `compare` and `format` from here.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT       = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CASES      = 'bench/cases.mjs'
const ROUND      = 'scripts/bench-round.mjs'
const MARK       = 'BENCH_CASES '
const TIMEOUT_MS = 180_000

/** `packages/<name>/bench/cases.mjs`, relative to `root`, sorted. */
export function caseFiles(root, only = null) {
  const dir = join(root, 'packages')
  return readdirSync(dir).sort()
    .filter(name => !only || name === only)
    .map(name => `packages/${name}/${CASES}`)
    .filter(file => existsSync(join(root, file)))
}

// ─── the base side ───────────────────────────────────────────────────────────

/** A worktree of `ref` that can run: node_modules is gitignored, so it is
 *  mirrored from `root` — a workspace link pointing into `packages/` resolves
 *  inside the worktree, so the base's toolbelt runs under the base's litestone,
 *  and everything else is the installed copy. */
export function baseTree(root, ref) {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-bench-ab-'))
  const add = spawnSync('git', ['worktree', 'add', '--detach', dir, ref], { cwd: root, encoding: 'utf8' })
  if (add.status !== 0) {
    rmSync(dir, { recursive: true, force: true })
    return { error: `git worktree add ${ref} failed: ${(add.stderr || '').trim()}` }
  }
  if (existsSync(join(root, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'))
  for (const pkg of readdirSync(join(root, 'packages'))) {
    const from = join(root, 'packages', pkg, 'node_modules')
    if (existsSync(from) && existsSync(join(dir, 'packages', pkg))) mirror(from, join(dir, 'packages', pkg, 'node_modules'))
  }
  const cleanup = () => {
    spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root })
    rmSync(dir, { recursive: true, force: true })
  }
  return { dir, cleanup }
}

function mirror(from, to) {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    const src = join(from, name), dst = join(to, name)
    const st  = lstatSync(src)
    if (name.startsWith('@') && st.isDirectory()) { mirror(src, dst); continue }
    const target = st.isSymbolicLink() ? readlinkSync(src) : null
    symlinkSync(target && !target.startsWith('/') ? target : src, dst)
  }
}

// ─── one round on one side ───────────────────────────────────────────────────

function runSide(tree, file) {
  const r = spawnSync('bun', [CASES, '--json'], {
    cwd: join(tree, dirname(dirname(file))), encoding: 'utf8', timeout: TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: '1' },
  })
  const line = (r.stdout ?? '').split('\n').find(l => l.startsWith(MARK))
  if (!line) return { error: `printed no ${MARK.trim()} line (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().slice(-400)}` }
  return JSON.parse(line.slice(MARK.length))
}

// ─── the comparison ──────────────────────────────────────────────────────────

const min = xs => Math.min(...xs)
const max = xs => Math.max(...xs)
const geomean = xs => xs.length ? Math.exp(xs.reduce((n, x) => n + Math.log(x), 0) / xs.length) : null

/** Run every case file `rounds` times on each side and judge it. `ref` null
 *  compares nothing and reports this tree's ratios to their floors alone. */
export function compare({ root = ROOT, ref = 'HEAD', rounds = 6, only = null } = {}) {
  const files = caseFiles(root, only)
  const base  = ref ? baseTree(root, ref) : { error: 'no base ref' }
  try {
    if (base.dir) copyFileSync(join(root, ROUND), join(base.dir, ROUND))
    const packages = []
    for (const file of files) {
      if (base.dir) {
        mkdirSync(dirname(join(base.dir, file)), { recursive: true })
        copyFileSync(join(root, file), join(base.dir, file))
      }
      const nu = [], old = []
      for (let r = 0; r < rounds; r++) {
        const sides = r % 2 ? ['old', 'new'] : ['new', 'old']
        for (const side of sides) {
          if (side === 'new') nu.push(runSide(root, file))
          else if (base.dir) old.push(runSide(base.dir, file))
        }
      }
      packages.push(judge(file, nu, old, base.error))
    }
    return { ref, rounds, packages }
  } finally {
    base.cleanup?.()
  }
}

function judge(file, nu, old, baseError) {
  const pkg      = file.split('/')[1]
  const failures = []
  for (const r of nu) if (r.error) failures.push(r.error)
  const declared = nu.find(r => !r.error)?.declared ?? null
  const names    = [...new Set(nu.flatMap(r => r.cases ?? []).map(c => c.name))]
  const series   = (runs, name) => runs.filter(r => !r.error).map(r => r.cases.find(c => c.name === name)).filter(Boolean)

  const cases = names.map(name => {
    const n = series(nu, name), o = series(old, name)
    const ceiling = n[0]?.ceiling
    const thrown  = n.find(c => c.error)?.error ?? null
    if (typeof ceiling !== 'number' || !(ceiling > 0)) return { name, refused: 'declares no ceiling' }
    if (thrown) return { name, ceiling, error: thrown }
    const us = n.map(c => c.us), floor = n.map(c => c.floorUs)
    const out = { name, ceiling, us: min(us), floorUs: min(floor), toFloor: min(us) / min(floor) }
    const ok = o.filter(c => !c.error)
    if (ok.length && ok.length === n.length) {
      const was = ok.map(c => c.us)
      out.was    = min(was)
      out.ratio  = out.us / out.was
      out.wins   = us.filter((x, i) => x < was[i]).length
      out.rounds = us.length
      out.noise  = !(max(us) < min(was) || max(was) < min(us))
    } else if (o.length) out.baseError = o.find(c => c.error)?.error ?? 'base ran fewer rounds'
    return out
  })

  const ran = cases.filter(c => c.us != null).length
  for (const c of cases) {
    if (c.refused) failures.push(`${c.name} ${c.refused}`)
    if (c.error)   failures.push(`${c.name} threw: ${c.error}`)
  }
  if (declared != null && ran < declared) failures.push(`ran ${ran} of ${declared} declared`)
  const baseNote = baseError ?? old.find(r => r.error)?.error ?? null
  return { pkg, file, declared, ran, cases, failures, baseNote,
           geomean: geomean(cases.filter(c => c.ratio).map(c => c.ratio)) }
}

// ─── the printed half ────────────────────────────────────────────────────────

export function format(model) {
  const out = []
  const ref = model.ref ? model.ref.slice(0, 10) : 'no base'
  for (const p of model.packages) {
    out.push(`${p.pkg} — ${p.ran} of ${p.declared ?? '?'} declared, ${model.rounds} rounds against ${ref}` +
             (p.geomean ? `, geomean ${p.geomean.toFixed(3)}x` : ''))
    for (const c of p.cases) {
      if (c.refused || c.error) { out.push(`  ${c.name.padEnd(18)} ${c.refused ?? 'THREW ' + c.error}`); continue }
      const over = c.toFloor > c.ceiling ? `  OVER CEILING ${c.ceiling}x` : ''
      const vs   = c.ratio == null ? '  base: not compared'
        : `  ${c.ratio.toFixed(3)}x vs base ${c.was.toFixed(2)} µs  wins ${c.wins}/${c.rounds}${c.noise ? ' ~' : ''}`
      out.push(`  ${c.name.padEnd(18)} ${c.us.toFixed(2).padStart(9)} µs  ${c.toFloor.toFixed(2)}x floor (≤${c.ceiling})${over}${vs}`)
    }
    if (p.baseNote) out.push(`  base: ${p.baseNote}`)
    for (const f of p.failures) out.push(`  FAILED ${f}`)
  }
  if (!model.packages.length) out.push('no package declares bench/cases.mjs')
  return out.join('\n')
}

// ─── as a command ────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2)
  const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const from = flag('--from') ?? 'HEAD'
  const resolved = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${from}^{commit}`], { cwd: ROOT, encoding: 'utf8' })
  if (resolved.status !== 0) { console.error(`--from ${from} does not resolve`); process.exit(2) }
  const merge = spawnSync('git', ['merge-base', 'HEAD', from], { cwd: ROOT, encoding: 'utf8' })
  const ref   = (merge.status === 0 ? merge.stdout : resolved.stdout).trim()
  const model = compare({ ref, rounds: Number(flag('--rounds') ?? 6), only: flag('--only') ?? null })
  console.log(argv.includes('--json') ? JSON.stringify(model, null, 2) : format(model))
  process.exit(model.packages.some(p => p.failures.length) ? 1 : 0)
}
