/**
 * tests/verify-fresh.mjs — a machine that has never seen this repo walks in
 * (`IDEAS/haven.md` 3.1, `FJS-D982`). Started by `bun run verify:fresh`; needs
 * Docker and the network (npm, Docker Hub). Nothing reaches npm.
 *
 * A Verdaccio container stands in for npm. It holds this tree's packages,
 * packed as they would be published, and proxies everything else to npm, but
 * never `@frontierjs/*`: a version this tree has moved past would otherwise be
 * answered by the registry's older copy, and the drive would test npm's
 * framework instead of this one. Haven's API runs in this process over a
 * fresh test database. A bare `oven/bun` container on the host network then
 * runs `bunx @frontierjs/cli haven --frame /` against it, so `fli` comes from
 * the registry, asks the server which Haven it runs, installs that, signs in
 * as the Frontier member its HOME was staked as (`FJS-D1477`), and prints the
 * square with its own figure on it.
 *
 * Traps:
 * - Haven is `private: true` so that no publish can take it to npm before
 *   its owner says so. The copy packed here has the field removed, and only
 *   that copy.
 * - Docker here may be a snap, which reads no file outside the user's home,
 *   `/tmp` included. So nothing is mounted: Verdaccio's config and the staked
 *   member's files travel in environment variables and the registry's port is
 *   Docker's choice.
 * - `bun pm pack` is what rewrites `workspace:*` to a version, so every
 *   package is packed from its own directory and never copied.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../api/src/app.ts'
import { isVoice } from '../api/src/keyless.ts'
import { POST_KEY, member } from '../api/test/sign-in.ts'
import { VIEW } from '../web/src/lib/scene/stage.js'

const HAVEN    = join(import.meta.dir, '..')
const PACKAGES = join(HAVEN, '..')
const BUN      = `oven/bun:${Bun.version}`
const REGISTRY = 'verdaccio/verdaccio:6'
const NAME     = `haven-fresh-${process.pid}`
const NICK     = 'fresh'

// The square's top row as a screen at the spawn shows it: scenes.test.js pins
// the picture, and the square is wider than a screen (6.1).
const SQUARE_TOP = readFileSync(join(HAVEN, 'web/src/scenes/square.frame.txt'), 'utf8').split('\n')[0].slice(0, VIEW.w).trim()

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}

/** A command's output, or a thrown error carrying it. */
function run (cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.status !== 0 && !opts.allowFailure) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}\n${r.stdout ?? ''}${r.stderr ?? ''}`)
  }
  return r
}

const work = mkdtempSync(join(tmpdir(), 'haven-fresh-'))
let env

try {
  // ─── the registry ───────────────────────────────────────────────────

  const config = [
    'storage: /verdaccio/storage/data',
    'auth: { htpasswd: { file: /verdaccio/storage/htpasswd, max_users: 10 } }',
    'uplinks: { npmjs: { url: "https://registry.npmjs.org/" } }',
    'packages:',
    '  "@frontierjs/*": { access: $all, publish: $authenticated }',
    '  "**": { access: $all, proxy: npmjs }',
    'log: { type: stdout, format: pretty, level: warn }',
  ].join('\n')
  run('docker', ['run', '-d', '--rm', '--name', NAME, '-p', '127.0.0.1::4873', '-e', `CONFIG=${config}`,
    '--entrypoint', 'sh', REGISTRY, '-c',
    'printf "%s\\n" "$CONFIG" > /verdaccio/conf/config.yaml && exec verdaccio --config /verdaccio/conf/config.yaml --listen 0.0.0.0:4873'])
  const port = run('docker', ['port', NAME, '4873']).stdout.trim().split(':').pop()
  const registry = `http://127.0.0.1:${port}/`

  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    up = await fetch(`${registry}-/ping`).then((r) => r.ok, () => false)
    if (!up) await Bun.sleep(100)
  }
  check(up, `a registry answers at ${registry}`, run('docker', ['logs', NAME], { allowFailure: true }).stdout)
  if (!up) throw new Error('no registry')

  const user = await fetch(`${registry}-/user/org.couchdb.user:rehearse`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'rehearse', password: 'rehearse-only' }),
  }).then((r) => r.json())
  const npmrc = join(work, '.npmrc')
  writeFileSync(npmrc, `//127.0.0.1:${port}/:_authToken=${user.token}\n`)

  // ─── this tree, published to it ─────────────────────────────────────

  const manifests = new Map()
  for (const dir of readdirSync(PACKAGES)) {
    try {
      const m = JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8'))
      manifests.set(m.name, { dir: join(PACKAGES, dir), manifest: m })
    } catch {}
  }
  // What a fresh install of fli and Haven reaches through @frontierjs/*.
  const needed = new Set()
  const reach = (name) => {
    if (needed.has(name) || !manifests.has(name)) return
    needed.add(name)
    const m = manifests.get(name).manifest
    for (const dep of Object.keys({ ...m.dependencies, ...m.peerDependencies })) {
      if (dep.startsWith('@frontierjs/')) reach(dep)
    }
  }
  reach('@frontierjs/cli')
  reach('@frontierjs/haven')

  for (const name of needed) {
    const { dir } = manifests.get(name)
    const out = join(work, name.replace('/', '__'))
    run('mkdir', ['-p', out])
    run('bun', ['pm', 'pack', '--destination', out, '--quiet'], { cwd: dir })
    const tgz = readdirSync(out).find((f) => f.endsWith('.tgz'))
    run('tar', ['-xzf', join(out, tgz), '-C', out])
    const pkg = join(out, 'package')
    if (name === '@frontierjs/haven') {
      const m = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
      delete m.private
      writeFileSync(join(pkg, 'package.json'), JSON.stringify(m, null, 2) + '\n')
    }
    run('npm', ['publish', pkg, '--registry', registry, '--userconfig', npmrc, '--access', 'public', '--ignore-scripts'])
  }
  check(true, `published ${[...needed].sort().join(', ')}`)

  // ─── Haven ───────────────────────────────────────────────────────

  env = await createTestEnv({
    schema: join(HAVEN, 'db/schema.lite'),
    listen: true,
    api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-fresh', port: 0, postKey: POST_KEY }),
  })
  await env.system.room.create({ data: { slug: 'square', name: 'The square' } })
  const api = `http://127.0.0.1:${env.port}`

  // ─── a machine with no checkout walks in ────────────────────────────

  // The machine is a member already, as `fli frontier:stake` leaves one; its
  // post never answers, and a fresh row is not refreshed.
  const staked = await member(NICK)
  const stake = 'mkdir -p /root/.fli/frontier'
    + ' && printf "%s" "$STAKE_KEY" > /root/.fli/frontier/key.json'
    + ' && printf "%s" "$STAKE_CHAIN" > /root/.fli/frontier/chain.json'
    + ' && printf "%s" "$STAKE_ROW" > /root/.fli/frontier/member.json'
    + ' && printf "%s" "$STAKE_CONFIG" > /root/.fli/config.json'

  // Spawned, never spawnSync: the API answering it runs in this process.
  const walk = Bun.spawn(['docker', 'run', '--rm', '--network', 'host',
    '-e', `NPM_CONFIG_REGISTRY=${registry}`, '-e', `BUN_CONFIG_REGISTRY=${registry}`,
    '-e', 'FLI_FRONTIER_POST=http://127.0.0.1:9',
    '-e', `STAKE_KEY=${JSON.stringify(staked.keys)}`, '-e', `STAKE_CHAIN=${JSON.stringify(staked.links)}`,
    '-e', `STAKE_ROW=${JSON.stringify(staked.row)}`,
    '-e', `STAKE_CONFIG=${JSON.stringify({ frontier: { nick: NICK, postKey: POST_KEY } })}`,
    BUN, 'sh', '-c',
    // Twice in one container: the second run finds the version installed, and
    // must still be the same member.
    `${stake} && bunx @frontierjs/cli haven --api ${api} --frame / && echo ---second--- && bunx @frontierjs/cli haven --api ${api} --frame / && echo ---versions--- && ls -d /root/.fli/haven/*/`,
  ], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => walk.kill(), 600_000)
  const [stdout, stderr, status] = await Promise.all([new Response(walk.stdout).text(), new Response(walk.stderr).text(), walk.exited])
  clearTimeout(timer)
  const r = { stdout, stderr, status }
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const [first = '', rest = ''] = out.split('---second---')
  const [second = '', versions = ''] = rest.split('---versions---')

  const version = JSON.parse(readFileSync(join(HAVEN, 'package.json'), 'utf8')).version
  check(r.status === 0, 'bunx @frontierjs/cli haven exits 0 on a machine with no checkout', out)
  check(first.includes(`@frontierjs/haven@${version}`), `fli asked the server and installed @frontierjs/haven@${version}`, first)
  check(first.includes(SQUARE_TOP) && first.includes('@'), 'the square is drawn with a figure on it', first)
  check(!second.includes('installing it'), 'the second walk installs nothing', second)
  // Beside the versions, `seen/` keeps each room's picture for the map (6.4).
  const dirs = versions.split('\n').filter((l) => /^\/root\/\.fli\/haven\/\d[^/]*\/$/.test(l))
  check(dirs.length === 1 && dirs[0] === `/root/.fli/haven/${version}/`, `~/.fli/haven holds one version, ${version}`, versions)

  // The crier announces a first walk-in, and is a member no login can be.
  const members = (await env.system.member.findMany({ select: { nick: true } })).filter((m) => !isVoice(m.nick))
  check(members.length === 1 && members[0].nick === NICK, `the two walks are one member, ${NICK}`, JSON.stringify(members))
} catch (e) {
  check(false, 'the rehearsal ran to the end', e.message)
} finally {
  await env?.close?.()
  spawnSync('docker', ['rm', '-f', NAME])
  rmSync(work, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
