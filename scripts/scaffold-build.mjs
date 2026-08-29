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
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync,
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

const WORK_PREFIXES = ['fjs-scaffold-', 'fjs-deploy-', 'fjs-journal-']
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

// ─── deployJournalCycle ──────────────────────────────────
// The proof phase 1 owed: deploy → deploy → revert → crash → resume, run for
// real against a machine, with a journal on it and a container serving from it.
//
// **It is the only thing here that executes `fli deploy`.** `scaffoldAndDeploy`
// above runs `fli deploy:local`, which is a different command — it builds and
// runs a container and never touches `_steps-docker/`, the journal, the swap,
// the health poll or the revert. So for as long as this file has existed, the
// pipeline an app actually deploys with had run zero times, and that showed:
// nine of its ten multi-line shell commands were syntax errors on the target
// (`packages/cli/core/machine.js`), the nginx config it wrote had every `$var`
// stripped by the local shell, and `fli deploy:revert` restored the bytes it was
// reverting FROM and reported success.
//
// What makes it runnable at all is that a deploy machine can be `localhost`:
// `core/machine.js` pipes the same script to `sh -s` with or without an ssh
// prefix, so this is the real pipeline against the real Docker daemon rather
// than a simulation of it. Nothing is stubbed. The only thing not exercised is
// ssh itself.
//
// The app plays both parts: it is the developer's checkout AND the git origin
// the "server" pulls from, which is what lets `02-pull` be real.
//
// Returns { findings, skipped } like its siblings.

export function deployJournalCycle({ keep = false, verbose = false, log = console.log } = {}) {
  const findings = []
  const fail     = (message, output) => { findings.push({ message, output }); return { findings, skipped: null } }

  const docker = exec('docker', ['version', '--format', '{{.Server.Version}}'], { verbose: false })
  if (docker.status !== 0) return { findings, skipped: 'no Docker daemon — `docker version` failed' }
  if (exec('git', ['--version'], { verbose: false }).status !== 0)
    return { findings, skipped: 'no git — the server side of this is a clone' }

  const appName   = `fjsjrn${process.pid}`
  const container = `${appName}-api`
  // ports.js: env 7 test · category 1 be · project 0 (what `fli new` scaffolds).
  // 7100 and 7101 are the two sources of scaffoldAndDeploy; this takes the next.
  const PORT = 7102

  const base = process.env.FJS_CI_WORKDIR || tmpdir()
  const work = workDir('fjs-journal-', base)
  const app  = join(work, appName)
  const srv  = join(work, 'server')
  const fli  = join(ROOT, 'packages', 'cli', 'bin', 'fli.js')

  const inApp = (argv, opts = {}) => exec('bun', [fli, ...argv], { cwd: app, verbose, ...opts })
  const git   = (cwd, argv) => exec('git', ['-c', 'user.email=ci@fjs.invalid', '-c', 'user.name=fjs-ci', ...argv], { cwd })

  /** The image the container is actually on. The ground truth every assertion here compares. */
  const running = () => {
    const r = exec('docker', ['inspect', container, '--format', '{{.Image}}'], { verbose: false })
    return r.status === 0 ? r.output.trim() : ''
  }
  const health = () => {
    const r = exec('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}',
                            `http://127.0.0.1:${PORT}/api/health`], { verbose: false })
    return r.output.trim()
  }
  // A crashed deploy leaves the lock behind — the pid in it is the pid of the
  // shell that wrote it, which exited immediately, so nothing can tell a stale
  // lock from a live one. Asserted below rather than hidden here.
  const unlock = () => rmSync(join(srv, '.deploy.lock'), { force: true })

  try {
    // ── the app, and a "server" that is a clone of it ──────
    const s = exec('bun', [fli, 'new', appName, '--yes', '--auth', '--source', 'local', '--no-git', '--no-deploy'],
                   { cwd: work, verbose })
    if (s.status !== 0) return fail('fli new failed', s.output)

    const key = randomBytes(32).toString('hex')
    writeFileSync(join(app, '.env'), `ENCRYPTION_KEY=${key}\nDATABASE_URL=/db/app.db\nNODE_ENV=production\n`)

    const m = inApp(['make:deploy', '--server', 'localhost', '--domain', 'ci.invalid'])
    if (m.status !== 0) return fail('fli make:deploy failed', m.output)

    // Point the generated block at this machine and this directory. `web: false`
    // because the web half wants nginx and a domain, which is a different proof.
    const confPath = join(app, 'frontier.config.js')
    const conf = readFileSync(confPath, 'utf8')
      .replace(/path: '[^']*',(\s*\/\/ deploy root)/, `path: '${srv}',$1`)
      .replace(/env:\s*'[^']*'/, `env:        '${srv}/.env.production'`)
      .replace(/port:\s*3000,/, `port:       ${PORT},`)
      .replace(/path:\s*'[^']*\/db',/, `path:         '${srv}/db',`)
      .replace(/\n    web: \{[\s\S]*?\n    \},/, '\n    web: false,')
    writeFileSync(confPath, conf)
    if (!conf.includes(srv)) return fail('could not point the deploy block at the local server directory', conf)

    // A release baseline, so the pivot classifies rather than answering unknown
    // — which counts as a contract and would refuse every revert below.
    const rc = inApp(['release:check'])
    if (!existsSync(join(app, 'db', 'release.snapshot.md')))
      return fail('fli release:check wrote no db/release.snapshot.md', rc.output)

    git(app, ['init', '-q', '.'])
    git(app, ['add', '-A'])
    git(app, ['commit', '-qm', 'scaffold'])
    const clone = exec('git', ['clone', '-q', app, srv])
    if (clone.status !== 0) return fail('could not clone the app into a server directory', clone.output)

    mkdirSync(join(srv, 'db'), { recursive: true })
    copyFileSync(join(app, '.env'), join(srv, '.env.production'))
    // The keys `01b-env-check` compares against .env.example. Named here rather
    // than by disabling the check: a deploy that skips it is not this pipeline.
    appendFileSync(join(srv, '.env.production'), `PORT=3000\nAPP_URL=http://127.0.0.1:${PORT}\n`)
    log('  ✓ scaffolded, and cloned into a server directory on this machine')

    // ── 1 · deploy ────────────────────────────────────────
    const d1 = inApp(['deploy', '--api'])
    if (d1.status !== 0) return fail('the first fli deploy failed', d1.output + dockerLogs(container))
    const A = running()
    if (!A) return fail('the first deploy finished and no container is on an image', d1.output)
    if (health() !== '200') return fail(`the deployed app answers ${health()} at /api/health`, dockerLogs(container))
    log(`  ✓ deploy ran the real pipeline — journal, build, swap, health`)

    const j1 = inApp(['deploy:journal'])
    if (!/succeeded/.test(j1.output) || !/serving/.test(j1.output))
      return fail('the deploy wrote no serving transition to the journal on the machine', j1.output)
    log('  ✓ the journal on the machine records it as serving')

    // ── 2 · deploy again, unchanged ───────────────────────
    // Not asserted as producing the same bytes, and that is a measurement rather
    // than a caution: `04-build-api` re-vendors the workspace on every run, and
    // `bun pm pack` writes a fresh tarball each time, so under `--source local` a
    // redeploy of unchanged source is never byte-identical. The `same-bytes`
    // refusal is therefore graded in `packages/cli/tests/revert.test.js`, where
    // two identical digests can be stated.
    //
    // What IS asserted here is that the second deploy is an ordinary one — a
    // journal that already holds a serving transition must not change how the
    // next deploy behaves.
    const d2 = inApp(['deploy', '--api'])
    if (d2.status !== 0) return fail('the second fli deploy failed', d2.output + dockerLogs(container))
    if (health() !== '200') return fail('the second deploy does not answer health', dockerLogs(container))

    // The property 2.3f exists for: the Release id names the ARTEFACT, so an
    // unchanged redeploy is the same Release. Before the digest was a term this
    // held trivially (every Release was identical); it means something now, and
    // it is what the resume below depends on — a transition id carries the
    // Release id, so an id that moves on a rebuild cannot be resumed.
    if (releaseOf(d1.output) && releaseOf(d1.output) !== releaseOf(d2.output))
      return fail(
        `an unchanged redeploy minted a different Release — ${releaseOf(d1.output)} then ${releaseOf(d2.output)}`,
        d1.output + '\n=== second ===\n' + d2.output)

    // The plan asks the MACHINE what is running rather than the journal, which
    // is what the `same-bytes` refusal reads. After a revert the serving
    // transition has no build step, so a journal-only answer would be blank.
    const plan = inApp(['deploy:revert', '--plan'])
    if (!/running\s+sha256:/.test(plan.output))
      return fail('the revert plan does not report the bytes actually running', plan.output)
    log('  ✓ a second deploy is ordinary, and the revert plan can see what is running')

    // ── 3 · deploy something different ────────────────────
    appendFileSync(join(app, 'api', 'index.ts'), `\n// ci ${process.pid}\n`)
    git(app, ['add', '-A'])
    git(app, ['commit', '-qm', 'change'])
    exec('git', ['pull', '-q', '--ff-only'], { cwd: srv })

    const d3 = inApp(['deploy', '--api'])
    if (d3.status !== 0) return fail('the third fli deploy failed', d3.output + dockerLogs(container))
    const B = running()
    if (B === A) return fail('a changed source deployed the same bytes', d3.output)
    log('  ✓ a changed source deploys different bytes')

    // ── 4 · crash mid-deploy, then resume ─────────────────
    appendFileSync(join(app, 'api', 'index.ts'), `\n// ci crash ${process.pid}\n`)
    git(app, ['add', '-A'])
    git(app, ['commit', '-qm', 'crash'])
    exec('git', ['pull', '-q', '--ff-only'], { cwd: srv })

    const killed = killAtJournal(['bun', fli, 'deploy', '--api'], app)
    if (killed.finished)
      return fail('the deploy meant to be interrupted finished before the journal opened', killed.output)
    if (killed.timedOut)
      return fail('the deploy never reported opening a journal', killed.output)

    const j2 = inApp(['deploy:journal'])
    if (!/running/.test(j2.output))
      return fail('a killed deploy left no unfinished transition in the journal', j2.output)
    const before = countTransitions(j2.output)

    // The stranded lock is CURRENT behaviour and is asserted rather than swept:
    // the pid recorded in the lock is the pid of the shell that wrote it, which
    // exits at once, so no run can tell a stale lock from a live one.
    const blocked = inApp(['deploy', '--api'])
    if (!/already in progress/.test(blocked.output))
      return fail('a crashed deploy left no lock — the next run was not refused', blocked.output)
    log('  ✓ a crashed deploy leaves an unfinished transition and a held lock')

    unlock()
    const resumed = inApp(['deploy', '--api'])
    if (resumed.status !== 0) return fail('the resumed deploy failed', resumed.output + dockerLogs(container))
    if (!/RESUMING/.test(resumed.output)) {
      // A resume is keyed on the transition id, which carries the Release id,
      // which carries the digest — so *started over* usually means the rebuild
      // produced different bytes. The journal is the only thing that can say
      // which, so it goes in the finding rather than being asked for afterwards.
      const j = inApp(['deploy:journal'])
      return fail('the rerun after a crash started over instead of resuming',
        `${resumed.output}\n--- journal ---\n${j.output}`)
    }
    // The property a resume IS: one transition continued, not a second opened.
    // Asserted on the count rather than on a replayed step, because since
    // `04c-journal` the journal opens after the build — the steps ahead of it are
    // marked done when it opens and are never claimed, so *replayed into a no-op*
    // is a line only the tail of the pipeline can produce, and where a run died
    // depends on where it died.
    const j3 = inApp(['deploy:journal'])
    if (countTransitions(j3.output) !== before)
      return fail(
        `the resume opened a second transition — ${before} before, ${countTransitions(j3.output)} after`,
        `${resumed.output}\n--- journal ---\n${j3.output}`)
    if (health() !== '200') return fail('the resumed deploy does not answer health', dockerLogs(container))
    const C = running()
    log('  ✓ the rerun continued the same transition rather than opening a second, and landed healthy')

    // ── 5 · revert ────────────────────────────────────────
    const rev = inApp(['deploy:revert'])
    if (rev.status !== 0) return fail('fli deploy:revert failed', rev.output + dockerLogs(container))
    const D = running()
    if (D === C) return fail('the revert did not move the bytes', rev.output)
    if (D !== B) return fail(`the revert restored ${short(D)}, not the release before it (${short(B)})`, rev.output)
    if (health() !== '200') return fail('the reverted app does not answer health', dockerLogs(container))
    log('  ✓ revert restored the previous release, and it answers health')

    // A revert must itself be a revert target, or the way back is one-way: a
    // revert has no build step, so nothing recorded its image until 03-swap did.
    const rev2 = inApp(['deploy:revert'])
    if (rev2.status !== 0) return fail('a second revert failed — a revert is not a revert target', rev2.output)
    if (running() !== C) return fail('reverting the revert did not return to the release it replaced', rev2.output)
    log('  ✓ a revert can itself be reverted')

    const steps = inApp(['deploy:journal', '--steps'])
    if (!/revert/.test(steps.output)) return fail('the journal does not record the revert', steps.output)

    return { findings, skipped: null }

  } finally {
    exec('docker', ['rm', '-f', container, `${container}_replaced`], { verbose: false })
    exec('docker', ['image', 'prune', '-f', '--filter', `label=app=${appName}`], { verbose: false })
    for (const t of imagesNamed(appName)) exec('docker', ['rmi', '-f', t], { verbose: false })
    active.delete(work)
    if (keep) log(`  · kept: ${work}`)
    else rmSync(work, { recursive: true, force: true })
  }
}

const short = (id) => String(id).slice(0, 19)

/** How many transitions the journal holds — a resume must not add one. */
const countTransitions = (out) => (String(out).match(/^\s*[✓✗…]\s+(deploy|revert)\s/gm) ?? []).length

/** The Release id a deploy reported opening, off its own output. */
const releaseOf = (out) => (String(out).match(/release\s+([0-9a-f]{12})/) ?? [])[1] ?? null

/** Every image tag this run built — the tag carries the commit, so there are several. */
function imagesNamed(appName) {
  const r = exec('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { verbose: false })
  return r.output.split('\n').map(l => l.trim()).filter(l => l.startsWith(`${appName}:`))
}

/**
 * Start a deploy and SIGKILL it the moment the journal has opened.
 *
 * A deploy interrupted mid-transition is the state the resume exists for, and it
 * is not reachable any other way: a step that FAILS settles the transition as
 * `failed`, so only a killed process leaves a `running` row behind.
 *
 * Killed on a MARKER rather than a timer, because since `04c-journal` the
 * journal opens after the build — and a build takes as long as a build takes.
 * A fixed delay lands before the transition exists on a slow machine and after
 * the whole deploy on a warm cache, so the test would be about the clock.
 *
 * Answers `{ finished }` — true means it completed before the marker, which is
 * a failed setup rather than a passed assertion.
 */
function killAtJournal(argv, cwd, { timeoutS = 240 } = {}) {
  const log = join(cwd, '.fli-crash.log')
  const script = `
"$@" > ${JSON.stringify(log)} 2>&1 &
PID=$!
for i in $(seq 1 ${timeoutS * 2}); do
  if grep -q "Journal opened" ${JSON.stringify(log)} 2>/dev/null; then
    sleep 0.3
    kill -9 $PID 2>/dev/null
    wait $PID 2>/dev/null
    exit 0
  fi
  kill -0 $PID 2>/dev/null || exit 1
  sleep 0.5
done
kill -9 $PID 2>/dev/null
exit 2
`
  // The argv goes past `-s` as positional parameters — `$1` onward, not `$0`, so
  // there is no name to pad with.
  const r = spawnSync('sh', ['-s', ...argv], {
    cwd, input: script, encoding: 'utf8', maxBuffer: MAX_BUFFER,
  })
  const output = existsSync(log) ? readFileSync(log, 'utf8') : ''
  return { finished: r.status === 1, timedOut: r.status === 2, output }
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
