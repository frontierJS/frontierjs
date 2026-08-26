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
//
// ─── who does the packing ────────────────────────────────────
//
// `fli`'s own `core/vendor.js`, the module `fli deploy:vendor` runs over a
// client app. It packs INTO the app — deploy/generated/vendor — rather than into
// a sibling directory, which is what closed FJS-241: a Docker build cannot see a
// `file:` tarball outside its own context, so an app packed the old way was
// installable on this machine and nowhere else. One packer, so the app this
// phase installs and the app `scaffoldAndDeploy` containerises are made the same
// way — the two used to answer the packaging question separately.
// ============================================================

import { spawnSync }                                  from 'node:child_process'
import { existsSync, readFileSync, writeFileSync,
         copyFileSync, rmSync, mkdtempSync }           from 'node:fs'
import { join, dirname, resolve }                      from 'node:path'
import { fileURLToPath }                               from 'node:url'
import { tmpdir }                                      from 'node:os'
import { randomBytes }                                 from 'node:crypto'

import { vendorWorkspacePackages }                     from '../packages/cli/core/vendor.js'
import { reapTempDirs }                                from '../packages/litestone/src/tmp-dirs.js'

const HERE = dirname(fileURLToPath(import.meta.url))

// ─── the work directory, on the paths a `finally` does not cover ──────
//
// Both phases below scaffold a whole app — ~300MB — and remove it in a
// `finally`. A `finally` does not run on a Ctrl-C, and `bun run ci` is a
// three-minute command people interrupt: 1.6GB of scaffolds and deploy
// contexts had accumulated by the time anyone measured (FJS-361). The signal
// handler covers that; the reap covers the SIGKILL it cannot see, past an age
// floor so a concurrent run is never touched.

const WORK_PREFIXES = ['fjs-scaffold-', 'fjs-deploy-']
const active = new Set()
let trapped = false

function trapSignals() {
  if (trapped) return
  trapped = true
  const sweep = () => { for (const d of active) { try { rmSync(d, { recursive: true, force: true }) } catch {} } active.clear() }
  process.on('exit', sweep)
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]])
    process.on(sig, () => { sweep(); process.exit(code) })
}

/** A scaffold/deploy work directory: previous runs' swept, this one registered
 *  so an interrupt takes it with it. `base` is honoured for the reason
 *  $FJS_CI_WORKDIR exists — the Docker daemon must be able to read it. */
function workDir(prefix, base) {
  trapSignals()
  reapTempDirs(WORK_PREFIXES, { root: base })
  const d = mkdtempSync(join(base, prefix))
  active.add(d)
  return d
}


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

  // $FJS_CI_WORKDIR for the same reason scaffoldAndDeploy honours it: step 8
  // hands this directory to the Docker daemon as a build context, and a shell
  // with a private /tmp gets `unable to prepare context` about a path that is
  // plainly there.
  const base = process.env.FJS_CI_WORKDIR || tmpdir()
  const work = workDir('fjs-scaffold-', base)

  try {
    // ── 1 · scaffold ─────────────────────────────────────────
    const fli = join(ROOT, 'packages', 'cli', 'bin', 'fli.js')
    const s   = run('bun', [fli, ...SCAFFOLD_ARGS], { cwd: work })
    if (s.status !== 0) return fail('fli new failed', s.output)

    const app = join(work, 'demo')
    if (!existsSync(app)) return fail(`fli new reported success but wrote no ${app}`, s.output)
    log('  ✓ scaffolded')

    // ── 2 · pack the tree into the app, and install THAT ─────
    // `include` because the scaffold was made with `--source npm`: its specs are
    // published versions and resolve perfectly well, so nothing about the
    // manifest says the tree wins. This phase has decided that it does.
    //
    // `overrides` comes with it, and is not a detail: a tarball's OWN
    // @frontierjs deps are ordinary ranges and resolve from the registry, so
    // without them the app builds sierra-from-here against mesa-from-npm.
    const manifestPath = join(app, 'package.json')
    const manifest     = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const fjsDeps      = ['dependencies', 'devDependencies']
      .flatMap(f => Object.keys(manifest[f] ?? {}))
      .filter(name => name.startsWith('@frontierjs/'))

    if (!fjsDeps.length) return fail('the scaffold declared no @frontierjs dependency to swap')

    let vendored
    try {
      // packagesDir stated: the app sits in a temp directory under no workspace
      // and has not been installed, so neither of the ways this is normally
      // found — the walk up, the node_modules symlinks — can answer here.
      vendored = vendorWorkspacePackages({
        appRoot: app, include: fjsDeps, packagesDir: join(ROOT, 'packages'),
      })
    } catch (err) {
      return fail('vendoring the working tree into the app failed', err.message)
    }

    // The app installs what the IMAGE installs — the same manifest, byte for
    // byte. Anything else and this phase proves a tree the Dockerfile does not
    // build.
    copyFileSync(vendored.manifestPath, manifestPath)
    log(`  ✓ packed ${vendored.packed.length} package(s), ${vendored.vendored.length} dependency swapped to the working tree`)

    // ── 3 · install ──────────────────────────────────────────
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

    // ── 3b · the initial migration ───────────────────────────
    // `fli new` writes it itself, but only when it installed: `migrate create`
    // is `bunx litestone`, which needs node_modules. This phase scaffolds with
    // `--no-install` and installs itself, so the step `fli new` would have run
    // has to run here — which is also exactly what its own warning tells a user
    // who declined the install to do.
    //
    // Without it the app has a Dockerfile whose entrypoint replays migrations
    // and no migration to replay: it builds, deploys, answers /health and 500s
    // on the first write (`FJS-345`). `fli check`'s `migration-history` rule
    // catches that now, which is how this gap was found — the `check` below
    // went red on a freshly scaffolded app.
    const mig = run('bunx', ['litestone', 'migrate', 'create', 'initial', '--schema', 'db/schema.lite'], { cwd: app })
    if (mig.status !== 0) return fail('could not write the initial migration for the scaffolded app', mig.output)
    log('  ✓ initial migration written')

    // ── 4 · build ────────────────────────────────────────────
    const b = run('bun', ['run', 'build'], { cwd: app })
    if (b.status !== 0) return fail('bun run build failed for the scaffolded app', b.output)

    // ── 5 · assert the build produced something usable ───────
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

    // ── 5b · run the gate the app was given ──────────────────
    // The generated package.json IS the framework's opinion about tooling, and
    // an opinion that is red on a freshly scaffolded app is worse than none:
    // the first thing anyone does is run it. Three things only reachable here —
    // `fli check` from an INSTALLED cli rather than this repo's bin (it had
    // never run at all, missing an import that the parse sweep cannot see),
    // `biome check` against a config resolved out of node_modules, and
    // `fli typecheck` against framework packages that ship TypeScript source.
    const check = run('bun', ['run', 'check'], { cwd: app })
    if (check.status !== 0)
      return fail('`bun run check` failed on a freshly scaffolded app', check.output)

    log('  ✓ its own check gate is green')

    // ── 6 · grow the app, then build it again ────────────────
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
    active.delete(work)
    if (keep) log(`  · kept: ${work}`)
    else rmSync(work, { recursive: true, force: true })
  }

  function run(cmd, argv, opts) { return exec(cmd, argv, { ...opts, verbose }) }
}

// ─── scaffoldAndDeploy ───────────────────────────────────────
// `fli new` → `fli make:deploy` → `fli deploy:local`: build the API image and
// prove the container comes up and answers its health endpoint.
//
// **It runs for both package sources, and they answer different questions.**
//
//   npm    the PUBLISHED framework, and the only thing in this repo that tests
//          it. Every id in the register is a statement about the working tree,
//          and a user's experience is a function of the tree AND the registry
//          (FJS-252). Losing this would leave the registry untested.
//   local  the WORKING TREE, containerised. `fli new --source local` writes
//          `link:` specs, which a Docker build cannot resolve — that was FJS-241,
//          and it made this path unrunnable for anyone working in the workspace
//          for as long as it stood. `fli deploy:local` now packs the tree into
//          the build context first, and what this asserts is that it does.
//
// Every pipeline defect it was originally aimed at (FJS-232, FJS-237, FJS-238)
// was in the pipeline rather than in a framework package, and both sources still
// exercise all of it.
//
// Returns { findings, skipped } — `skipped` is a reason string when Docker is
// not available, which the caller turns into a note or a failure.

export function scaffoldAndDeploy({ source = 'npm', keep = false, verbose = false, log = console.log } = {}) {
  const findings = []
  const fail     = (message, output) => { findings.push({ message, output }); return { findings, skipped: null } }

  const docker = exec('docker', ['version', '--format', '{{.Server.Version}}'], { verbose: false })
  if (docker.status !== 0) {
    return { findings, skipped: 'no Docker daemon — `docker version` failed' }
  }

  // Unique per run AND per source: the container is named for the app, a fixed
  // name would let CI `docker rm -f` a container a developer is using, and the
  // two sources must not collide with each other either.
  const appName   = `fjsci${source}${process.pid}`
  const container = `${appName}-local`
  const tag       = `${appName}:local`

  // The scheme in packages/cli/core/ports.js: env 7 = test, category 1 = be,
  // project 0 = whatever `fli new` scaffolds. deploy:local defaults to 3001,
  // which belongs to nothing. The two sources take adjacent service slots so
  // they could run at once.
  const PORT = source === 'local' ? 7101 : 7100

  // $FJS_CI_WORKDIR overrides the base directory. The Docker DAEMON has to be
  // able to read the build context, and it does not necessarily share the
  // caller's /tmp — a sandboxed or containerised shell with a private tmpfs
  // gets `unable to prepare context: path not found` for a directory that is
  // plainly there. On an ordinary machine and on a CI runner, tmpdir is right.
  const base = process.env.FJS_CI_WORKDIR || tmpdir()
  const work = workDir('fjs-deploy-', base)
  const app  = join(work, appName)

  try {
    const fli = join(ROOT, 'packages', 'cli', 'bin', 'fli.js')

    // --no-deploy, then make:deploy by hand: `fli new` would run it for us, but
    // then a make:deploy failure would surface as a scaffold failure.
    const s = exec('bun', [fli, 'new', appName, '--yes', '--auth', '--source', source, '--no-git', '--no-deploy'], { cwd: work, verbose })
    if (s.status !== 0) return fail(`fli new --source ${source} failed`, s.output)
    if (!existsSync(app)) return fail(`fli new reported success but wrote no ${app}`, s.output)

    // The claim under test on the local path is that these specs, which resolve
    // to a workspace the image has never seen, reach the container anyway.
    // Asserted rather than assumed: if `fli new` stopped writing them the run
    // would pass while proving the npm path twice.
    if (source === 'local') {
      const specs = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).dependencies ?? {}
      const linked = Object.values(specs).filter(v => typeof v === 'string' && v.startsWith('link:'))
      if (!linked.length)
        return fail('fli new --source local wrote no link: spec — this run would not test FJS-241', s.output)
    }
    log(`  ✓ scaffolded from ${source}`)

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

    log(`  ✓ container built from ${source}, started and answered health on :${PORT}`)

    const smoke = smokeAuth(app, PORT)
    if (smoke) return fail(smoke.message, smoke.output + dockerLogs(container))
    log(`  ✓ register + login answered at the prefix the app's own web config names`)

    return { findings, skipped: null }

  } finally {
    // Always, including on the failure paths above — a phase that leaves a
    // container bound to 7100 breaks its own next run.
    exec('docker', ['rm', '-f', container], { verbose: false })
    exec('docker', ['rmi', '-f', tag],      { verbose: false })
    active.delete(work)
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

// ─── smoke: can a scaffolded app sign someone in? ──────────
//
// Everything above this grades whether the framework INSTALLS and whether the
// container answers health. Neither can see the class FJS-252 was filed for: a
// scaffold template written against behaviour only the working tree has, which
// installs cleanly and fails at runtime.
//
// It was measured. The scaffold points its browser client at `apiPrefix` and the
// auth plugin mounts through `app.post`, which is the one owner of that prefix
// — so against a published auth that answered at a bare `/auth/*`, the first
// thing anyone does was a 404 reading `Service 'auth' not found`. That app
// installed, built and answered health, and nobody could log in.
//
// The prefix is read from the app's OWN web config rather than written here: the
// claim under test is that the client and the server agree about it, and a
// literal on this side would only ever agree with itself.
//
// `/manifest` is not asked. manifestPlugin is devOnly and the container runs
// NODE_ENV=production, so the duplicate derived hooks of FJS-231 stay a
// working-tree question that no deployed app can answer.
//
// Returns a finding, or null.

function smokeAuth(app, port) {
  const prefix = clientApiPrefix(app)
  const base   = `http://127.0.0.1:${port}${prefix}`
  const email  = `smoke-${process.pid}@ci.invalid`
  const pass   = 'Sm0ke!Test-Passw0rd'

  const reg = httpJson('POST', `${base}/auth/register`, { email, password: pass, name: 'CI Smoke' })
  if (reg.status !== 201) return {
    message: `POST ${prefix}/auth/register answered ${reg.status ?? 'nothing'}, expected 201` + prefixHint(reg.status, prefix),
    output:  reg.body,
  }

  const login = httpJson('POST', `${base}/auth/login`, { email, password: pass })
  if (login.status !== 200) return {
    message: `POST ${prefix}/auth/login answered ${login.status ?? 'nothing'}, expected 200` + prefixHint(login.status, prefix),
    output:  login.body,
  }

  // The scaffold sets `cookieAuth: false`, so the token is in the body. A 200
  // carrying none is a session the app has no way to use.
  let token
  try { token = JSON.parse(login.body)?.token } catch { /* the finding below carries the body */ }
  if (!token) return {
    message: `POST ${prefix}/auth/login answered 200 with no token in the body`,
    output:  login.body,
  }

  return null
}

// A 404 from an app that installed and built is almost never a sick app, and
// reading it as one costs an afternoon.
function prefixHint(status, prefix) {
  if (status !== 404) return ''
  return `\n      The app and the framework disagree about where auth is mounted. The scaffold's` +
         `\n      web config points the browser client at '${prefix}' and app.post() is the one owner` +
         `\n      of apiPrefix, so an @frontierjs/auth that mounts at a bare /auth/* leaves every` +
         `\n      scaffolded app unable to log in (FJS-252). This is the only check that sees it.`
}

// The prefix the app's own browser client is configured with. A web-less
// scaffold has no config and no prefix, which is what its API serves at.
function clientApiPrefix(app) {
  const config = join(app, 'web', 'config', 'sierra.config.js')
  if (!existsSync(config)) return ''
  const found = readFileSync(config, 'utf8').match(/apiPrefix:\s*['"`]([^'"`]*)['"`]/)
  return found ? found[1] : ''
}

// curl rather than fetch: this file is synchronous end to end so ci.mjs can run
// it as an ordinary phase, and there is no synchronous fetch.
function httpJson(method, url, body) {
  const r = exec('curl', [
    '-s', '-X', method,
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify(body),
    '-w', '\n%{http_code}',
    '--max-time', '20',
    url,
  ])
  const text = r.output ?? ''
  const cut  = text.lastIndexOf('\n')
  const code = cut === -1 ? NaN : Number(text.slice(cut + 1).trim())
  return { status: Number.isFinite(code) && code ? code : null, body: cut === -1 ? text : text.slice(0, cut) }
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
    for (const source of ['npm', 'local']) {
      console.log(`\n─── scaffold + deploy (--source ${source}) ──────────`)
      const { findings, skipped } = scaffoldAndDeploy({ source, keep, verbose })
      if (skipped) console.log(`  ! skipped — ${skipped}`)
      else if (!findings.length) console.log('  ✓ containerises and answers health')
      problems.push(...findings)
    }
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
