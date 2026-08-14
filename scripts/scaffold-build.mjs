#!/usr/bin/env node
// ============================================================
// Scaffold an app from the WORKING TREE, install it, build it.
//
//   node scripts/scaffold-build.mjs            # full-stack + auth
//   node scripts/scaffold-build.mjs --keep     # leave the app on disk to poke at
//   node scripts/scaffold-build.mjs --verbose  # stream every command
//
// Run by `scripts/ci.mjs` as the `scaffold` phase, and standalone by a person.
//
// ─── why this exists ─────────────────────────────────────────
//
// FJS-251: the Mesa plugin's node_modules allowance tested `/node_modules/sierra/`
// for a package named `@frontierjs/sierra`, so every app installed from npm died
// at `bun run build` on untransformed `.mesa`. Sierra had 836 passing tests and
// none of them could see it, because an app IN THIS REPO resolves sierra to
// `packages/sierra/` — never a node_modules path — so the branch never ran.
//
// That is the shape this phase is aimed at: **a defect that only exists once the
// framework is packaged.** The suites cannot reach it by construction, and
// `example/`'s drives cannot either.
//
// ─── why tarballs, and not `link:` or npm ────────────────────
//
// The test only works if the app resolves the framework through a REAL directory
// under its own node_modules.
//
//   link:      → a symlink, and Vite follows it to packages/sierra/… — the same
//                path the workspace already produces. Reproduces nothing.
//   npm        → a real copy, but of the PUBLISHED package. It would have caught
//                FJS-251 only after it shipped, which is too late to be CI.
//   pm pack    → a real copy of the WORKING TREE, byte for byte what
//                `npm publish` would upload.
//
// The third also grades every package's `files:` field for free: a source file
// missing from `files` is invisible in the workspace and fatal once installed,
// which is the same class of bug one level down.
// ============================================================

import { spawnSync }                                  from 'node:child_process'
import { existsSync, readFileSync, writeFileSync,
         readdirSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs'
import { join, dirname, resolve }                      from 'node:path'
import { fileURLToPath }                               from 'node:url'
import { tmpdir }                                      from 'node:os'
import { randomBytes }                                 from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const MAX_BUFFER = 64 * 1024 * 1024

// ─── the app under test ──────────────────────────────────────
// Full-stack with auth: the shape `fli new` produces when it is not told
// otherwise, and the one that pulls in sierra, mesa and css — the three
// packages whose build-time behaviour only differs once installed.
const SCAFFOLD_ARGS = ['new', 'demo', '--yes', '--auth', '--source', 'npm', '--no-install', '--no-git']

// Synchronous throughout — spawnSync and the sync fs calls — so ci.mjs can run
// it as an ordinary phase without becoming async.
export function scaffoldAndBuild({ keep = false, verbose = false, log = console.log } = {}) {
  const findings = []
  const fail     = (message, output) => { findings.push({ message, output }); return findings }

  const work = mkdtempSync(join(tmpdir(), 'fjs-scaffold-'))
  const tarballs = join(work, 'tarballs')
  mkdirSync(tarballs, { recursive: true })

  try {
    // ── 1 · pack every publishable workspace package ─────────
    const packages = publishablePackages()
    const packed   = {}

    for (const { name, dir } of packages) {
      const r = run('bun', ['pm', 'pack', '--destination', tarballs], { cwd: dir })
      if (r.status !== 0) return fail(`bun pm pack failed for ${name}`, r.output)
    }

    // Map @frontierjs/<x> → the tarball just written for it. Read off disk
    // rather than predicted from the version, so a package whose tarball did
    // not appear is a miss here rather than a confusing install error later.
    for (const { name } of packages) {
      const short = name.slice('@frontierjs/'.length)
      const file  = readdirSync(tarballs).find(f => new RegExp(`^frontierjs-${short}-\\d`).test(f))
      if (!file) return fail(`no tarball produced for ${name}`)
      packed[name] = 'file:' + join(tarballs, file)
    }
    log(`  ✓ packed ${packages.length} package(s)`)

    // ── 2 · scaffold ─────────────────────────────────────────
    const fli = join(ROOT, 'packages', 'cli', 'bin', 'fli.js')
    const s   = run('bun', [fli, ...SCAFFOLD_ARGS], { cwd: work })
    if (s.status !== 0) return fail('fli new failed', s.output)

    const app = join(work, 'demo')
    if (!existsSync(app)) return fail(`fli new reported success but wrote no ${app}`, s.output)
    log('  ✓ scaffolded')

    // ── 3 · point every @frontierjs dep at its tarball ───────
    // `overrides` as well as `dependencies`: a tarball's OWN @frontierjs deps
    // are ordinary ranges and would resolve from the registry, so without this
    // the app would build sierra-from-here against mesa-from-npm.
    const manifestPath = join(app, 'package.json')
    const manifest     = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const swapped      = []

    for (const field of ['dependencies', 'devDependencies']) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        if (packed[dep]) { manifest[field][dep] = packed[dep]; swapped.push(dep) }
      }
    }
    if (!swapped.length) return fail('the scaffold declared no @frontierjs dependency to swap')
    manifest.overrides = { ...manifest.overrides, ...packed }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    log(`  ✓ ${swapped.length} dependency swapped to the working tree`)

    // ── 4 · install ──────────────────────────────────────────
    // --cache-dir is load-bearing. Bun caches a tarball by name AND version, so
    // a second run against the same version serves the FIRST run's bytes: this
    // phase passed against a deliberately broken working tree until the cache
    // was moved per run. A stale hit here is worse than no phase at all, since
    // it reads as coverage.
    const cacheDir = join(work, '.bun-cache')
    const i = run('bun', ['install', '--cache-dir', cacheDir], { cwd: app })
    if (i.status !== 0) return fail('bun install failed for the scaffolded app', i.output)

    // The install has to have produced a real directory, not a symlink back into
    // the workspace — that is the whole property this phase depends on.
    const installed = join(app, 'node_modules', '@frontierjs', 'sierra')
    if (!existsSync(installed)) return fail(`installed no ${installed}`, i.output)
    log('  ✓ installed from tarballs')

    // ── 5 · build ────────────────────────────────────────────
    const b = run('bun', ['run', 'build'], { cwd: app })
    if (b.status !== 0) return fail('bun run build failed for the scaffolded app', b.output)

    // ── 6 · assert the build produced something usable ───────
    // A zero exit is not the assertion. Vite injects the built <script> at the
    // first textual match for the body tag and does not skip comments, so a
    // build can succeed and ship a page that loads no JavaScript at all
    // (FJS-198). Ask the output, not the exit code.
    const indexPath = join(app, 'web', 'dist', 'client', 'index.html')
    if (!existsSync(indexPath)) return fail(`build exited 0 and wrote no ${indexPath}`, b.output)

    const html = readFileSync(indexPath, 'utf8')
    if (!/<script[^>]+src=["'][^"']+\.js["']/.test(html))
      return fail('dist/client/index.html loads no built script — the page would be blank', html.slice(0, 2000))

    log('  ✓ built, and the page loads its script')

    // ── 7 · grow the app, then build it again ────────────────
    // FJS-036: the scaffold templates had been updated twice and never run
    // through `fli scaffold <Model>`, which is the first thing anyone does to a
    // new app. Adding a model is four generated files across all three realms —
    // a schema stanza, a service, a Resource and its routes — and every one of
    // them is a template that can go stale against the package it is written
    // for. Building afterwards is what makes them more than files on disk.
    const g = run('bun', [fli, 'scaffold', 'Note', '--fields', 'title:string body:text'], { cwd: app })
    if (g.status !== 0) return fail('fli scaffold Note failed on a freshly scaffolded app', g.output)

    // Named individually: `fli scaffold` reports success per file, so a step
    // that silently wrote nothing would otherwise pass on its exit code alone.
    // Invariant 19 decides two of these — a Resource is PascalCase singular and
    // named for its model, while the service is the plural accessor.
    const grown = {
      'db/schema.lite':                        t => /model\s+Note\s*\{/.test(t),
      'api/src/services/notes.service.ts':     () => true,
      'web/src/resources/Note.mesa':           () => true,
      'web/src/routes/notes/index.mesa':       () => true,
    }
    for (const [rel, holds] of Object.entries(grown)) {
      const p = join(app, rel)
      if (!existsSync(p))              return fail(`fli scaffold Note exited 0 and wrote no ${rel}`, g.output)
      if (!holds(readFileSync(p, 'utf8'))) return fail(`${rel} does not describe the model that was asked for`, g.output)
    }

    const b2 = run('bun', ['run', 'build'], { cwd: app })
    if (b2.status !== 0) return fail('bun run build failed after `fli scaffold Note`', b2.output)
    log('  ✓ a model scaffolded into it, and it still builds')

    return findings

  } finally {
    if (keep) log(`  · kept: ${work}`)
    else rmSync(work, { recursive: true, force: true })
  }

  function run(cmd, argv, opts) { return exec(cmd, argv, { ...opts, verbose }) }
}

// ─── scaffoldAndDeploy ───────────────────────────────────────
// `fli new` → `fli make:deploy` → `fli deploy:local`: build the API image and
// prove the container comes up and answers its health endpoint.
//
// **This one installs from npm, not from the working tree.** A Docker build
// cannot see a `file:` tarball outside its build context, which is the same
// wall `link:` hits (FJS-241) — so testing the working tree here would mean
// deciding how a local scaffold ships, and that question is not settled. The
// question this phase answers is narrower and still worth asking: does the
// deploy pipeline containerise a real app? Every defect it is aimed at
// (FJS-232, FJS-237, FJS-238) was in the pipeline, not in a framework package.
//
// When FJS-241 is resolved by packing into the app instead of linking, this
// should move to the working tree and the two phases converge.
//
// Returns { findings, skipped } — `skipped` is a reason string when Docker is
// not available, which the caller turns into a note or a failure.

export function scaffoldAndDeploy({ keep = false, verbose = false, log = console.log } = {}) {
  const findings = []
  const fail     = (message, output) => { findings.push({ message, output }); return { findings, skipped: null } }

  const docker = exec('docker', ['version', '--format', '{{.Server.Version}}'], { verbose: false })
  if (docker.status !== 0) {
    return { findings, skipped: 'no Docker daemon — `docker version` failed' }
  }

  // Unique per run: the container is named for the app, and a fixed name would
  // let CI `docker rm -f` a container a developer is using.
  const appName   = `fjsci${process.pid}`
  const container = `${appName}-local`
  const tag       = `${appName}:local`

  // The scheme in packages/cli/core/ports.js: env 7 = test, category 1 = be,
  // project 0 = whatever `fli new` scaffolds. deploy:local defaults to 3001,
  // which belongs to nothing.
  const PORT = 7100

  // $FJS_CI_WORKDIR overrides the base directory. The Docker DAEMON has to be
  // able to read the build context, and it does not necessarily share the
  // caller's /tmp — a sandboxed or containerised shell with a private tmpfs
  // gets `unable to prepare context: path not found` for a directory that is
  // plainly there. On an ordinary machine and on a CI runner, tmpdir is right.
  const base = process.env.FJS_CI_WORKDIR || tmpdir()
  const work = mkdtempSync(join(base, 'fjs-deploy-'))
  const app  = join(work, appName)

  try {
    const fli = join(ROOT, 'packages', 'cli', 'bin', 'fli.js')

    // --no-deploy, then make:deploy by hand: `fli new` would run it for us, but
    // then a make:deploy failure would surface as a scaffold failure.
    const s = exec('bun', [fli, 'new', appName, '--yes', '--auth', '--source', 'npm', '--no-git', '--no-deploy'], { cwd: work, verbose })
    if (s.status !== 0) return fail('fli new failed', s.output)
    if (!existsSync(app)) return fail(`fli new reported success but wrote no ${app}`, s.output)
    log('  ✓ scaffolded from npm')

    // ── .env ─────────────────────────────────────────────────
    // The container needs a real key: `encryptionKey` is parsed as HEX, so 64
    // characters is not necessarily 32 bytes and a non-hex filler decodes short
    // and is rejected by name. DATABASE_URL points at /db, the volume the
    // deploy mounts — inside the image `./db/app.db` is a copy that every swap
    // discards.
    const key = randomBytes(32).toString('hex')
    writeFileSync(join(app, '.env'), [
      `ENCRYPTION_KEY=${key}`,
      'DATABASE_URL=/db/app.db',
      'NODE_ENV=production',
      '',
    ].join('\n'))

    const m = exec('bun', [fli, 'make:deploy', '--server', 'ci.invalid', '--domain', 'ci.invalid'], { cwd: app, verbose })
    if (m.status !== 0) return fail('fli make:deploy failed', m.output)

    const dockerfile = join(app, 'deploy', 'Dockerfile')
    if (!existsSync(dockerfile)) return fail(`make:deploy exited 0 and wrote no ${dockerfile}`, m.output)
    log('  ✓ make:deploy wrote a Dockerfile')

    // ── build, run, health ───────────────────────────────────
    // deploy:local throws on every failure path including the health check, so
    // the exit code is the assertion. It did not always: `log.error` writes a
    // line and nothing more, so each path used to report a problem and exit 0.
    const d = exec('bun', [fli, 'deploy:local', '--port', String(PORT), '--clean'], { cwd: app, verbose })
    if (d.status !== 0) {
      // The daemon refusing a build context that is plainly on disk is not a
      // deploy defect, and reading it as one costs an hour. It means the daemon
      // cannot see this process's /tmp — the case $FJS_CI_WORKDIR exists for.
      // Detected rather than guessed: the path is only unreachable-for-them if
      // it is present for us.
      const hidden = /unable to prepare context: path .* not found/.test(d.output) && existsSync(app)
      const hint   = hidden
        ? `\n\nThe build context exists at ${app} and the Docker daemon cannot see it — ` +
          `this shell's /tmp is private to it. Re-run with FJS_CI_WORKDIR set to a ` +
          `directory the daemon shares, e.g. FJS_CI_WORKDIR=$HOME/fjs-ci-work.`
        : ''
      return fail('fli deploy:local failed' + hint, d.output + dockerLogs(container))
    }

    log(`  ✓ container built, started and answered health on :${PORT}`)
    return { findings, skipped: null }

  } finally {
    // Always, including on the failure paths above — a phase that leaves a
    // container bound to 7100 breaks its own next run.
    exec('docker', ['rm', '-f', container], { verbose: false })
    exec('docker', ['rmi', '-f', tag],      { verbose: false })
    if (keep) log(`  · kept: ${work}`)
    else rmSync(work, { recursive: true, force: true })
  }
}

// The container is gone by the time a caller reads the finding, so its logs
// have to be captured while it still exists.
function dockerLogs(container) {
  const r = exec('docker', ['logs', '--tail', '40', container], { verbose: false })
  return r.output ? `\n--- ${container} logs ---\n${r.output}` : ''
}

function exec(cmd, argv, { verbose = false, ...opts } = {}) {
  const r = spawnSync(cmd, argv, {
    encoding:  'utf8',
    maxBuffer: MAX_BUFFER,
    stdio:     verbose ? 'inherit' : 'pipe',
    ...opts,
  })
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

// ─── which packages get packed ───────────────────────────────
// Every publishable workspace package, not only the ones the scaffold names.
// Overrides bite only for what is actually depended on, and packing the rest
// costs a second while proving each one still packs at all.

function publishablePackages() {
  const dir = join(ROOT, 'packages')
  const out = []

  for (const entry of readdirSync(dir)) {
    const manifestPath = join(dir, entry, 'package.json')
    if (!existsSync(manifestPath)) continue
    let manifest
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { continue }
    if (manifest.private) continue
    if (!manifest.name?.startsWith('@frontierjs/')) continue
    out.push({ name: manifest.name, dir: join(dir, entry) })
  }

  return out
}

// ─── standalone ──────────────────────────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const keep     = process.argv.includes('--keep')
  const verbose  = process.argv.includes('--verbose')
  const onlyBuild  = process.argv.includes('--build')
  const onlyDeploy = process.argv.includes('--deploy')
  const both     = !onlyBuild && !onlyDeploy

  const problems = []

  if (both || onlyBuild) {
    console.log('\n─── scaffold + build ───────────────────────────────')
    const findings = scaffoldAndBuild({ keep, verbose })
    if (!findings.length) console.log('  ✓ installs from the working tree and builds')
    problems.push(...findings)
  }

  if (both || onlyDeploy) {
    console.log('\n─── scaffold + deploy ──────────────────────────────')
    const { findings, skipped } = scaffoldAndDeploy({ keep, verbose })
    if (skipped) console.log(`  ! skipped — ${skipped}`)
    else if (!findings.length) console.log('  ✓ containerises and answers health')
    problems.push(...findings)
  }

  if (!problems.length) {
    console.log('\n✓ done\n')
    process.exit(0)
  }

  for (const f of problems) {
    console.log(`\n✗ ${f.message}`)
    if (f.output) console.log(indent(f.output))
  }
  console.log()
  process.exit(1)
}

function indent(text) {
  return text.split('\n').map(l => `    ${l}`).join('\n')
}
