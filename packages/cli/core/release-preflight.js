// ─── release-preflight.js — will this App start, keep its data, and be reached? ─
//
// `fli basecamp:deploy` asks it before it builds anything. The failure it
// exists for is a release that builds, ships and is reported released, and is
// wrong in a way nothing says: the first one measured (ela, 2026-10-27) had no
// Variables, so the API would refuse at boot on ENCRYPTION_KEY; no volume, so
// five databases defaulted to paths inside the container and the next release
// would start on empty ones; no port, so nothing could reach it, while the app
// listened on 8100 and its Dockerfile EXPOSEd 3000; and SA_URL unset, so the
// container would take its default and talk to a live third-party system.
//
// Every one of those is the App's settings read against what the app DECLARES,
// and both halves are already written down: the App in Basecamp, the app in its
// `defineEnv` spec, its schema's `database` blocks, its health route and its
// Dockerfile. Nothing here is a guess about what the app means — a finding names
// the declaration it was read from.
//
// The grading is a pure function of what the caller gathered, so it is tested
// without Basecamp, Docker or an app on disk. `gatherReleaseInputs` is the one
// half that reads, and `readEnvSpec` the one that runs anything.
//
// A finding whose answer is a setting carries it as `fix` beside the prose
// `hint`, and `releasePlan` merges every fix into the writes one walkthrough
// makes (`FJS-3525`): one App patch, the Variable rows, and for an App that
// has never been released, the Domain — on a static sibling for the app's
// `web/`, with the API's prefixes routed to this App (`FJS-D1547`). What a
// fix cannot know (a credential, a Dockerfile edit) stays prose.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

import { declaredDatabasePaths } from './db-preflight.js'
import { declaresHealth, resolveHealthPath } from './health-target.js'
import { parseDockerfile } from './build-check.js'

export const RULES = {
  'env-required':     'a variable the app refuses to boot without, set nowhere',
  'state-off-volume': 'a database written inside the container, which the next release replaces',
  'no-port':          'an App that publishes no port, so nothing reaches the API',
  'port-mismatch':    'the App sends traffic to a port the app does not listen on',
  'port-taken':       'a host port another App on the same machine already publishes',
  'health-unchecked': 'a health route the App never asks, so a crash after start is a success',
  'unrouted':         'an App with no Domain and no exposed port',
  'external-default': 'a URL left on its default, which is a real outside service',
  'local-default':    'a URL left on a localhost default, which inside the container is the container',
  'node-env':         'NODE_ENV resolving to development in a release',
  'unreadable':       'something the check could not read, so its rules did not run',
  'surface-unreleased': 'a surface of the app that no App in this environment releases',
  'target':           'where the release is going',
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])$/i

/** The first host port from `wanted` up that no other App on the machine
 *  publishes. Every scaffolded API listens on 8100, so taking the listen port
 *  as the host port gave the second App on a machine a release docker refuses
 *  (`FJS-3563`); the container port stays the app's own. */
export function freeHostPort(wanted, taken = []) {
  const held = new Set(taken.map(Number))
  let port = Number(wanted)
  while (held.has(port) && port < 65535) port++
  return port
}

/** The variables the App's container starts with, as a release merges them:
 *  the environment's, then the App's own on top. */
export function mergeVariables(rows, appId) {
  const out = new Map()
  for (const row of [...rows.filter(r => !r.appId), ...rows.filter(r => r.appId === appId)])
    out.set(row.key, row)
  return out
}

/** The final stage's WORKDIR and the ENV lines it carries — a value an earlier
 *  stage set does not survive `FROM`. */
export function imageRuntime(dockerfile) {
  const df    = parseDockerfile(dockerfile ?? '')
  const final = df.stages.at(-1)
  const from  = df.froms.at(-1)?.line ?? 0
  return {
    workdir: final?.workdir && final.workdir !== '/' ? final.workdir : '/',
    env:     Object.fromEntries(df.envs.filter(e => e.line > from && e.value !== null).map(e => [e.key, e.value])),
  }
}

/**
 * @param app        the Basecamp App row, with `environment`, `placement` and `domains`
 * @param variables  Variable rows of the App's environment, or null when they could not be read
 * @param unread     why a read failed, by what was read — `{ variables: 'Basecamp refused …' }`
 * @param siblings   the other Apps in the environment, or null
 * @param envSpec    `{ spec: { KEY: { type, required, default } } }` or `{ error }`
 * @param databases  `declaredDatabasePaths()` — `{ name, driver, path, envVar }`
 * @param health     `{ path, declared }`
 * @param image      `imageRuntime()` of the Dockerfile
 * @param surfaces   the app's surfaces beside api/ — `['web', 'widgets']`
 */
export function releaseFindings({
  app, variables = null, siblings = null, envSpec = null, unread = {},
  databases = [], health = null, image = { workdir: '/', env: {} }, surfaces = [],
}) {
  const findings = []
  const add = (rule, level, title, detail, hint, fix = null) => findings.push({ rule, level, title, detail, hint, fix })

  const vars = variables ? mergeVariables(variables, app.id) : null
  const spec = envSpec?.spec ?? null
  const set  = (key) => {
    const row = vars?.get(key)
    return !!row && (row.secret || (row.value ?? '') !== '')
  }

  /** What the container sees for `key`: `{ value, from }`, value undefined
   *  when the variable is a secret (its value is not readable) or unset. */
  const resolve = (key, fallback) => {
    const row = vars?.get(key)
    if (row && (row.secret || (row.value ?? '') !== ''))
      return { value: row.secret ? undefined : row.value, from: row.secret ? 'secret' : 'variable' }
    if (image.env[key] !== undefined) return { value: image.env[key], from: 'image' }
    const d = fallback ?? spec?.[key]?.default
    return d === undefined ? { value: undefined, from: 'unset' } : { value: String(d), from: 'default' }
  }

  // ── what could not be read ────────────────────────────────────────────────
  if (!vars)
    add('unreadable', 'warn', "could not read the App's Variables",
      `${unread.variables ?? 'No answer'} — so every rule about what the container is started with was skipped.`,
      /\b403\b/.test(unread.variables ?? '') ? 'Issue the key with variables:read.' : 'Run it again, or read the Variables in Basecamp.')
  if (envSpec?.error)
    add('unreadable', 'info', 'could not read the app\'s defineEnv spec',
      envSpec.error, 'The env rules ran on the schema alone.')

  // ── it boots ──────────────────────────────────────────────────────────────
  if (vars && spec) {
    for (const [key, field] of Object.entries(spec)) {
      if (!field.required || set(key) || image.env[key] !== undefined) continue
      add('env-required', 'error', `${key} is required and set nowhere`,
        `The app's defineEnv spec marks it required, and neither the App, its environment nor the image sets it — ` +
        'the container exits at boot before it answers anything.',
        `Add ${key} to the App's Variables${/KEY|SECRET|TOKEN|PASSWORD/.test(key) ? ' as a secret' : ''}` +
        `${key === 'ENCRYPTION_KEY' ? ' (`openssl rand -hex 32`)' : ''}.`,
        // A credential is somebody's and cannot be invented; the app's own key can.
        key === 'ENCRYPTION_KEY' ? { variables: [{ key, secret: true, generate: 'hex32' }] } : null)
    }
  }

  // ── it keeps its data ─────────────────────────────────────────────────────
  // The schema's databases, then any `*_PATH` the spec declares that the schema
  // does not — the jobs queue is junction's, configured from JOBS_PATH.
  if (vars) {
    const state = databases.map(d => ({ name: `database ${d.name}`, key: d.envVar, fallback: d.path }))
    for (const [key, field] of Object.entries(spec ?? {})) {
      if (!/_PATH$/.test(key) || state.some(s => s.key === key)) continue
      if (typeof field.default !== 'string' || !/^\.{0,2}\//.test(field.default)) continue
      state.push({ name: key, key, fallback: field.default })
    }

    const volume = app.volumePath ? app.volumePath.replace(/\/+$/, '') : null
    const off = []
    for (const s of state) {
      const r = s.key ? resolve(s.key, s.fallback) : { value: s.fallback, from: 'schema' }
      if (r.value === undefined || r.value === ':memory:') continue
      const at = posix.resolve(image.workdir, r.value)
      if (volume && (at === volume || at.startsWith(volume + '/'))) continue
      off.push({ ...s, at, from: r.from })
    }
    if (off.length) {
      const list = off.map(o => `${o.key ?? o.name} → ${o.at}${o.from === 'default' ? ' (default)' : ''}`).join(', ')
      const literal = off.filter(o => !o.key).map(o => o.name)
      add('state-off-volume', 'error',
        volume ? `${off.length} database path${off.length === 1 ? ' is' : 's are'} outside the volume at ${volume}`
               : `the App mounts no volume, and ${off.length} database${off.length === 1 ? '' : 's'} would be written inside the container`,
        `${list}. A release replaces the container, so each starts empty on the next one — and nothing fails when it does.` +
        (literal.length ? ` ${literal.join(', ')} ${literal.length === 1 ? 'has' : 'have'} a literal path in db/schema.lite, which only an edit there can move.` : ''),
        `${volume ? '' : "Set the App's volume path (/db), then "}set ${off.filter(o => o.key).map(o => `${o.key}=${volume ?? '/db'}/${posix.basename(o.at)}`).join(', ')}.`,
        {
          ...(volume ? {} : { app: { volumePath: '/db' } }),
          variables: off.filter(o => o.key).map(o => ({ key: o.key, value: `${volume ?? '/db'}/${posix.basename(o.at)}` })),
        })
    }
  }

  // ── it is reached ─────────────────────────────────────────────────────────
  const target = app.containerPort ?? app.port ?? null
  const listen = spec?.PORT ? resolve('PORT') : null
  const taken  = (app.portsTaken ?? []).map(Number)
  if (!app.port) {
    add('no-port', 'error', 'the App publishes no port',
      `Nothing reaches the container, and no health check can be asked of it${listen?.value ? ` — the app listens on ${listen.value}` : ''}.`,
      listen?.value ? `Set the App's container port to ${listen.value} and its port to ${freeHostPort(listen.value, taken)}.` : "Set the App's port.",
      listen?.value ? { app: { port: freeHostPort(listen.value, taken), containerPort: Number(listen.value) } } : null)
  } else if (taken.includes(Number(app.port))) {
    add('port-taken', 'error', `another App on the machine already publishes port ${app.port}`,
      'docker refuses the second container that binds it, after the release has built and shipped.',
      `Set the App's port to ${freeHostPort(app.port, taken)} and its container port to ${target}.`,
      // Pinned, because a null container port is the host port at `docker run`.
      { app: { port: freeHostPort(app.port, taken), containerPort: Number(target) } })
  }
  if (app.port && listen?.value && Number(listen.value) !== Number(target)) {
    add('port-mismatch', 'error', `the App sends traffic to ${target}, and the app listens on ${listen.value}`,
      `PORT resolves to ${listen.value} (${listen.from}); the App's container port is ${target}.`,
      `Set PORT=${target} in the App's Variables, or the container port to ${listen.value}.`,
      { app: { containerPort: Number(listen.value) } })
  }

  if (health?.declared && !app.healthCheck)
    add('health-unchecked', 'warn', `the App never asks ${health.path}`,
      'With no health check, a container that is running counts as released — one that crashes a second later included, ' +
      'and nothing puts the previous one back.',
      `Set the App's health check to ${health.path}.`, { app: { healthCheck: health.path } })
  else if (health?.declared && app.healthCheck && app.healthCheck !== health.path)
    add('health-unchecked', 'warn', `the App asks ${app.healthCheck}, and the app answers health at ${health.path}`,
      'A health check on a path nothing serves fails every release and puts the previous one back.',
      `Set the App's health check to ${health.path}.`, { app: { healthCheck: health.path } })

  if (!(app.domains ?? []).length && !app.exposesPort)
    add('unrouted', 'warn', 'nothing routes to the App',
      'It has no Domain and its port is not exposed, so it answers no one outside the machine.',
      'Add a Domain to the App.', { domain: true })

  // ── what it talks to ──────────────────────────────────────────────────────
  if (vars && spec) {
    const local = []
    const localKeys = []
    for (const [key, field] of Object.entries(spec)) {
      if (field.type !== 'url' || field.default === undefined || set(key) || image.env[key] !== undefined) continue
      let host
      try { host = new URL(String(field.default)).hostname } catch { continue }
      if (LOCAL_HOST.test(host)) { local.push(`${key} → ${field.default}`); localKeys.push(key); continue }
      add('external-default', 'warn', `${key} is unset, so the release talks to ${field.default}`,
        `It is the default in the app's defineEnv spec. Whatever the app does at that address, this release does it ` +
        'for real — every job and cron that reads it included.',
        `Set ${key} in the App's Variables, even to the same address, so it is a decision the environment records.`,
        { variables: [{ key, value: String(field.default) }] })
    }
    if (local.length)
      add('local-default', 'warn', `${local.length} URL${local.length === 1 ? '' : 's'} left on a localhost default`,
        `${local.join(', ')}. Inside the container localhost is the container, so a link built from one points nowhere.`,
        'Set each to the address the App is reached at.',
        // The App's origin: under one hostname the API is reached at the page's
        // origin with its prefix kept (`FJS-D1040`), so both URLs are the same.
        { variables: localKeys.map(key => ({ key, derive: 'origin' })) })

    if (spec.NODE_ENV) {
      const r = resolve('NODE_ENV')
      if (r.value === 'development')
        add('node-env', 'warn', 'NODE_ENV resolves to development',
          `From the ${r.from === 'default' ? "app's defineEnv default" : r.from}. A development app answers errors with their stack.`,
          "Set NODE_ENV=production in the App's Variables.", { variables: [{ key: 'NODE_ENV', value: 'production' }] })
    }
  }

  // ── what else ─────────────────────────────────────────────────────────────
  if (siblings) {
    const statics = siblings.filter(s => s.id !== app.id && s.source?.kind === 'inline')
    for (const surface of surfaces) {
      if (surface === 'web' && statics.length) continue
      add('surface-unreleased', 'info', `${surface}/ is released by nothing in ${app.environment?.name ?? 'this environment'}`,
        `This App is the API image, and ${surface}/ is not in it.`,
        surface === 'web'
          ? 'Create a static App for it and release it with `fli basecamp:deploy --app <its id>`.'
          : `Release ${surface}/ on its own, or ignore this if it is not meant to be live here.`,
        surface === 'web' ? { web: true } : null)
    }
  }

  const servers = (app.placement ?? []).map(p => `${p.server?.name} (${p.server?.ipAddress ?? 'no address'})`)
  add('target', 'info',
    `${app.name} in ${app.environment?.project?.name ?? '?'} / ${app.environment?.name ?? '?'}` +
    `${app.environment?.tier ? ` — a ${app.environment.tier} environment` : ''}`,
    servers.length ? `On ${servers.join(', ')}.` : 'Placed on no server.', null)

  const order = { error: 0, warn: 1, info: 2 }
  return findings.sort((a, b) => order[a.level] - order[b.level])
}

// ─── the plan ────────────────────────────────────────────────────────────────

/** An App nothing has shaped yet: no release, no port, no Variables of its own.
 *  Detected rather than flagged, so the first `fli basecamp:deploy` walks it
 *  through and the second finds nothing to ask. */
export function neverReleased(app, variables) {
  return !app.port
    && !(app.recent_deployments ?? app.deployments ?? []).length
    && !(variables ?? []).some(v => v.appId === app.id)
}

/**
 * Every finding's `fix`, merged into the writes one walkthrough makes:
 *
 *   app        one PATCH /apps/:id
 *   variables  POST /variables rows — `generate: 'hex32'` is minted by the
 *              caller and never printed, `derive: 'origin'` is https://hostname
 *   web        create a static App for web/ (`FJS-D1547`)
 *   domain     `{ hostname, on: 'web' | 'api', routes }` — on the static App
 *              with the API's prefixes routed here, or on this App without one
 *
 * `hostname` empty leaves `domain` null and the `derive` rows out, and says so
 * in `asked`, so a run with no terminal prints what one answer would unlock.
 * `prefixes` is `routePrefixes(apiPaths(snapshot))` from `core/edge.js`.
 */
export function releasePlan(findings, { hostname = '', prefixes = ['/api', '/ws'] } = {}) {
  const app  = {}
  const vars = new Map()
  let web = false, domain = false
  for (const f of findings) {
    if (!f.fix) continue
    Object.assign(app, f.fix.app ?? {})
    for (const v of f.fix.variables ?? []) if (!vars.has(v.key)) vars.set(v.key, v)
    web    ||= !!f.fix.web
    domain ||= !!f.fix.domain
  }
  const host = hostname.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const variables = [...vars.values()].flatMap(v => {
    if (v.derive !== 'origin') return [v]
    return host ? [{ key: v.key, value: `https://${host}` }] : []
  })
  const asked = [...vars.values()].filter(v => v.derive === 'origin').map(v => v.key)
  return {
    app, variables, web,
    domain: domain && host ? { hostname: host, on: web ? 'web' : 'api', routes: web ? prefixes : [] } : null,
    asked:  host ? [] : [...(domain ? ['Domain'] : []), ...asked],
    empty:  !Object.keys(app).length && !variables.length && !web && !(domain && host),
  }
}

// ─── reading ─────────────────────────────────────────────────────────────────

/** Where a `fli new` app declares its environment. */
export const ENV_MODULES = ['api/src/core/env.ts', 'api/src/core/env.js', 'api/src/env.ts', 'api/src/env.js']

// The app's env module calls `defineEnv(spec)` at load and throws when a
// required variable is missing — which, read from a laptop about a server, is
// every time. So the module is run with `@frontierjs/junction` swapped for a
// stand-in whose `defineEnv` only records the spec, and with an environment
// holding nothing of this machine's: a default computed from `process.env`
// would otherwise answer with the laptop's value.
const PROBE = `
let spec = null
Bun.plugin({ name: 'env-spec', setup(b) {
  b.module('@frontierjs/junction', () => ({ loader: 'object', exports: { defineEnv: (s) => { spec = s; return {} } } }))
} })
try { await import(process.argv.at(-1)) } catch (e) { console.log(JSON.stringify({ error: String(e?.message ?? e).split('\\n')[0] })); process.exit(0) }
const out = {}
for (const [k, f] of Object.entries(spec ?? {}))
  out[k] = { type: f?.type ?? 'string', required: !!f?.required, ...(f?.default !== undefined ? { default: f.default } : {}) }
console.log(JSON.stringify(spec ? { spec: out } : { error: 'the env module never called defineEnv' }))
`

/** The app's `defineEnv` spec — `{ spec }`, or `{ error }` saying why not. */
export function readEnvSpec(root, { run = spawnSync } = {}) {
  const entry = ENV_MODULES.map(m => join(root, m)).find(existsSync)
  if (!entry) return { error: `no env module (${ENV_MODULES.join(', ')})` }
  const r = run('bun', ['-e', PROBE, entry], {
    cwd: root, encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  })
  const line = String(r.stdout ?? '').trim().split('\n').at(-1)
  try { return JSON.parse(line) } catch { return { error: `the env module did not load: ${String(r.stderr ?? '').trim().split('\n')[0] || `exit ${r.status}`}` } }
}

/** Everything `releaseFindings` reads from the app's tree. */
export function gatherReleaseInputs(root, { dockerfile = 'deploy/Dockerfile', run } = {}) {
  const health = resolveHealthPath(root)
  const dfPath = join(root, dockerfile)
  return {
    envSpec:   readEnvSpec(root, { run }),
    databases: declaredDatabasePaths(join(root, 'db')),
    health:    { path: health.path, declared: declaresHealth(root, health.path).declared },
    image:     imageRuntime(existsSync(dfPath) ? readFileSync(dfPath, 'utf8') : ''),
    surfaces:  ['web', 'widgets', 'site'].filter(s => existsSync(join(root, s))),
  }
}
