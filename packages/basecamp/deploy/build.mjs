#!/usr/bin/env node
// ============================================================
// Build the Basecamp container image from the WORKING TREE.
//
//   node deploy/build.mjs              # pack, generate, docker build
//   node deploy/build.mjs --run        # …then bring the stack up
//   node deploy/build.mjs --down       # stop the stack
//   node deploy/build.mjs --verbose    # stream every command
//
// Three things happen here that a plain `docker build` cannot do, and each one
// is a failure that has already happened somewhere in this repo:
//
//   1. PACK the workspace packages into the build context, and 2. REWRITE the
//      manifest to point at those tarballs. Basecamp depends on nine of them as
//      `workspace:*`; a Docker build resolves neither that nor `link:`
//      (FJS-241). Both halves belong to `fli`'s own `core/vendor.js` — the same
//      module `fli deploy:vendor` runs over a client app — because a scaffolded
//      app and the app whose purpose is to exercise the tree answering that
//      question differently is how the two stop being one framework.
//
//   3. GENERATE the reverse-proxy config from web/config/api-paths.js. The API
//      and the SPA share an origin and are told apart by `Accept`; a hand-kept
//      second copy of that list is the bug the file's own header describes.
//      That file derives its paths from `surface.snapshot.md`, so this image is
//      built against what the API actually mounts rather than against a list.
//
// Everything it writes lands in deploy/generated/, which is git-ignored. The
// image is reproducible from the tree and nothing generated is committed.
// ============================================================

import { spawnSync }                                     from 'node:child_process'
import { existsSync, writeFileSync }                     from 'node:fs'
import { join, dirname, resolve }                         from 'node:path'
import { randomBytes }                                    from 'node:crypto'
import { fileURLToPath }                                  from 'node:url'

const HERE      = dirname(fileURLToPath(import.meta.url))
const APP       = resolve(HERE, '..')                 // packages/basecamp
const ROOT      = resolve(APP, '..', '..')            // the workspace
const GENERATED = join(HERE, 'generated')

const VERBOSE = process.argv.includes('--verbose')
const RUN     = process.argv.includes('--run')
const DOWN    = process.argv.includes('--down')
const TAG     = 'basecamp:local'

const log  = (m) => console.log(m)
const fail = (m, out) => { console.error(`\n✗ ${m}`); if (out) console.error(out); process.exit(1) }

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd:      opts.cwd ?? APP,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio:    VERBOSE ? 'inherit' : 'pipe',
    ...opts,
  })
  return r
}

const output = (r) => [r.stdout, r.stderr].filter(Boolean).join('\n')

// ─── docker present? ─────────────────────────────────────────
// Named rather than left to fail inside a build: `docker build` without a
// daemon reports a context error about a directory that is plainly there,
// which reads as a bug in this script (the FJS_CI_WORKDIR family).
const docker = run('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' })
if (docker.status !== 0)
  fail('no Docker daemon — `docker version` failed', output(docker))

// ─── the secrets, written once ───────────────────────────────
// Generated on first run and then left alone. ENCRYPTION_KEY is what the
// @encrypted columns in the data volume are readable with: regenerate it and
// every Secret in there becomes unreadable, with no error — the rows are still
// present and the plaintext is gone. So this is NOT under deploy/generated/,
// which the build wipes on every run.
const ENV_FILE = join(HERE, '.env')
if (!existsSync(ENV_FILE)) {
  const key = () => Array.from(randomBytes(32)).map(b => b.toString(16).padStart(2, '0')).join('')
  writeFileSync(ENV_FILE,
    '# Written once by deploy/build.mjs. Git-ignored.\n' +
    '# ENCRYPTION_KEY is what the data volume is readable with — do not rotate it\n' +
    '# without also discarding the volume.\n' +
    `ENCRYPTION_KEY=${key()}\n` +
    `OUTPOST_SECRET=${key()}\n`)
  log('  ✓ deploy/.env written — keep it, or the data volume becomes unreadable')
}

if (DOWN) {
  const r = run('docker', ['compose', '-f', join(HERE, 'docker-compose.yml'), 'down'])
  process.exit(r.status ?? 0)
}

// ─── 1+2 · pack the workspace and rewrite the manifest ───────
// `fli`'s core/vendor.js, imported by path — the CLI is a workspace sibling and
// a `bun install` copy of it under node_modules/.bun would be whatever the last
// install saw. It wipes deploy/generated/ itself, so the Caddyfile below is
// written after it and not before.
const { vendorWorkspacePackages } = await import(
  join(ROOT, 'packages', 'cli', 'core', 'vendor.js')
)

// The image runs `bun run start` and `bun run build:web`; nothing in it needs
// the dev server, the drives, or the reset scripts, and `stop` shelling out to
// pkill inside a container is actively wrong.
const trimForImage = (manifest) => {
  manifest.scripts = {
    start:       manifest.scripts.start,
    'build:db':  manifest.scripts['build:db'],
    'build:web': manifest.scripts['build:web'],
  }
  delete manifest.private   // bun install refuses nothing, but the flag is a lie here
  return manifest
}

let vendored
try {
  vendored = vendorWorkspacePackages({ appRoot: APP, transform: trimForImage })
} catch (err) {
  fail(err.message)
}
log(`  ✓ packed ${vendored.packed.length} workspace package(s)`)
log(`  ✓ manifest rewritten — ${vendored.vendored.length} dependenc(ies) point at the tree`)

// ─── 3 · the reverse-proxy config ────────────────────────────
// Generated from the ONE list, so adding a service reaches the deploy without
// anybody remembering that it has to.
const { API_PATHS, WS_PATH } = await import(
  join(APP, 'web', 'config', 'api-paths.js')
)

// Caddy has to make the same call the Vite proxy makes: /projects is both a
// service and a page, and only `Accept` tells them apart. A navigation asks for
// text/html and gets the shell; the Junction client asks for JSON and is
// proxied. Matched in that order — the html matcher wins, so a browser typing
// the URL never sees a JSON body.
const matchers = API_PATHS.map(p => `${p} ${p}/*`).join(' ')

const caddyfile = `# GENERATED by deploy/build.mjs from surface.snapshot.md — do not edit.
{
	admin off
	auto_https off
}

:80 {
	encode gzip

	@ws path ${WS_PATH} ${WS_PATH}/*
	handle @ws {
		reverse_proxy api:8120
	}

	# An API path asked for as a document is a NAVIGATION — serve the shell.
	@spa {
		path ${matchers}
		header Accept *text/html*
	}
	handle @spa {
		rewrite * /index.html
		file_server
	}

	@api path ${matchers}
	handle @api {
		reverse_proxy api:8120
	}

	# Everything else: a real file, or the shell. Sierra routes are client-side,
	# so a hard load of /servers/ has to arrive at index.html rather than a 404.
	handle {
		root * /srv
		try_files {path} {path}/index.html /index.html
		file_server
	}
}
`
writeFileSync(join(GENERATED, 'Caddyfile'), caddyfile)
log(`  ✓ Caddyfile generated from ${API_PATHS.length} API path(s)`)

// ─── 4 · build ───────────────────────────────────────────────
// Context is packages/basecamp. It has to be: a Docker build cannot see a
// `file:` tarball outside its own context, which is the whole of FJS-241.
const built = run('docker', [
  'build', '-f', join(HERE, 'Dockerfile'), '-t', TAG, '.',
], { stdio: VERBOSE ? 'inherit' : 'pipe' })
if (built.status !== 0) fail('docker build failed', output(built))
log(`  ✓ built ${TAG}`)

if (!RUN) {
  log(`\nNext: node deploy/build.mjs --run\n`)
  process.exit(0)
}

// ─── 5 · up ──────────────────────────────────────────────────
const up = run('docker', ['compose', '-f', join(HERE, 'docker-compose.yml'), 'up', '-d'])
if (up.status !== 0) fail('docker compose up failed', output(up))

// Poll the proxy, not the API: what is being proven is the whole stack, and the
// proxy is the half a browser talks to.
const wait = (ms) => new Promise(r => setTimeout(r, ms))
let healthy = false
for (let i = 0; i < 60 && !healthy; i++) {
  try {
    const res = await fetch('http://localhost:8020/health')
    healthy = res.ok
  } catch { /* not up yet */ }
  if (!healthy) await wait(1000)
}

if (!healthy) {
  const logs = run('docker', ['compose', '-f', join(HERE, 'docker-compose.yml'), 'logs', '--tail', '60'], { stdio: 'pipe' })
  fail('the stack came up but /health never answered', output(logs))
}

log(`\n  ✓ Basecamp is up — http://localhost:8020\n`)
log(`    logs:  docker compose -f deploy/docker-compose.yml logs -f`)
log(`    stop:  node deploy/build.mjs --down\n`)
