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
// makes (`FJS-3525`): one App patch, the Variable rows, and the Domain — on a
// static sibling for the app's `web/`, with the API's prefixes routed to this
// App (`FJS-D1547`). What a fix cannot know (a credential, a Dockerfile edit)
// stays prose.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

import { runChecks } from './checks.js'
import { declaredDatabasePaths } from './db-preflight.js'
import { declaresHealth, resolveHealthPath } from './health-target.js'
import { parseDockerfile } from './build-check.js'
import { parseEnvText } from './local-env.js'

export const RULES = {
  'env-required':     'a variable the app refuses to boot without, set nowhere',
  'state-off-volume': 'a database written inside the container, which the next release replaces',
  'no-port':          'an App that publishes no port, so nothing reaches the API',
  'port-mismatch':    'the App sends traffic to a port the app does not listen on',
  'port-taken':       'a host port another App on the same machine already publishes',
  'health-unchecked': 'a health route the App never asks, so a crash after start is a success',
  'unrouted':         'an App with no Domain and no exposed port',
  'route-missing':    "a Domain on the static App with no route back to the API's prefixes",
  'external-default': 'a URL left on its default, which is a real outside service',
  'local-default':    'a URL left on a localhost default, which inside the container is the container',
  'node-env':         'NODE_ENV resolving to development in a release',
  'migration-history': 'a schema the migrations do not build, which the container refuses at boot',
  'unreadable':       'something the check could not read, so its rules did not run',
  'surface-unreleased': 'a surface of the app that no App in this environment releases',
  'widgets-unrouted': "a widgets App with no Domain, so the widget origin answers no one",
  'target':           'where the release is going',
}

/** The surface a static App builds: its inline source states it, and a row made
 *  before the field existed is web/'s. */
export const surfaceOf = (app) => app?.source?.surface ?? 'web'

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])$/i

// A name that reads as a credential is a secret Variable.
export const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD/
const LOCAL_DB    = /^(?:\.\/)?db\//

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

/** The keys a release plans itself — the port, NODE_ENV, the encryption key,
 *  each database path and each URL on a localhost default. A laptop's env file
 *  holds a laptop's answer to every one, `./db/app.db` and `localhost:8100`,
 *  which inside the container point nowhere. */
export function releaseOwnedKeys({ envSpec = null, databases = [] } = {}) {
  const owned = new Set(['PORT', 'NODE_ENV', 'ENCRYPTION_KEY'])
  for (const d of databases) if (d.envVar) owned.add(d.envVar)
  for (const [key, field] of Object.entries(envSpec ?? {})) {
    if (/_PATH$/.test(key)) owned.add(key)
    if (field.type !== 'url' || field.default === undefined) continue
    try { if (LOCAL_HOST.test(new URL(String(field.default)).hostname)) owned.add(key) } catch {}
  }
  return owned
}

/**
 * An env file's lines as writes to an App's Variables — `env:push` with
 * `BASECAMP_APP_ID` set. A key the container lacks is a new row on the App; one
 * it holds with another value is left alone unless `overwrite`, and a held
 * secret is never `same`, since its value is not readable. A key in `owned`,
 * or one whose value is under `./db`, is skipped unless `named` holds it by its
 * exact name: naming `ENCRYPTION_KEY` is how an existing database's key travels. `create` and `patch` carry values;
 * the lists beside them are keys only, so the caller never prints a value —
 * `secret` the written keys whose row is a secret.
 */
export function variablePush({ rows, appId, body, owned = new Set(), named = [], overwrite = false }) {
  const held = mergeVariables(rows, appId)
  const out  = { create: [], patch: [], added: [], replaced: [], same: [], differs: [], skipped: [], secret: [] }
  for (const [line, value] of Object.entries(parseEnvText(body))) {
    const key = line.replace(/^export\s+/, '')
    // A value under the app's ./db is a laptop's database path, whatever its name.
    if ((owned.has(key) || LOCAL_DB.test(value)) && !named.includes(key)) { out.skipped.push(key); continue }
    const row = held.get(key)
    if (row && !row.isSecret && row.value === value) { out.same.push(key); continue }
    if (row && !overwrite) { out.differs.push(key); continue }
    if (!row) out.added.push(key)
    else      out.replaced.push(key)
    // An environment-wide row is every App's; this App's own row shadows it.
    // A patch keeps the row's isSecret, which is frozen.
    const isSecret = row?.appId === appId ? !!row.isSecret : SECRET_NAME.test(key)
    if (isSecret) out.secret.push(key)
    if (row?.appId === appId) out.patch.push({ id: row.id, version: row.version, key, value })
    else                      out.create.push({ appId, key, value, isSecret })
  }
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
 * @param migrations `runChecks()` of `migration-history`, or null for an app with no schema
 */
export function releaseFindings({
  app, variables = null, siblings = null, envSpec = null, unread = {},
  databases = [], health = null, image = { workdir: '/', env: {} }, surfaces = [],
  routes = null, prefixes = ['/api', '/ws'], migrations = null,
}) {
  const findings = []
  // A fix fills what is missing and never rewrites a row the App holds
  // (`FJS-D1599`): a second POST of one of its Variables is refused, and the
  // value there may be a hand edit.
  const own = new Set((variables ?? []).filter(r => r.appId === app.id).map(r => r.key))
  const add = (rule, level, title, detail, hint, fix = null) => findings.push({ rule, level, title, detail, hint,
    fix: fix?.variables ? { ...fix, variables: fix.variables.filter(r => !own.has(r.key)) } : fix })

  const vars = variables ? mergeVariables(variables, app.id) : null
  const spec = envSpec?.spec ?? null
  const set  = (key) => {
    const row = vars?.get(key)
    return !!row && (row.isSecret || (row.value ?? '') !== '')
  }

  /** What the container sees for `key`: `{ value, from }`, value undefined
   *  when the variable is a secret (its value is not readable) or unset. */
  const resolve = (key, fallback) => {
    const row = vars?.get(key)
    if (row && (row.isSecret || (row.value ?? '') !== ''))
      return { value: row.isSecret ? undefined : row.value, from: row.isSecret ? 'secret' : 'variable' }
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
        `Add ${key} to the App's Variables${SECRET_NAME.test(key) ? ' as a secret' : ''}` +
        `${key === 'ENCRYPTION_KEY' ? ' (`openssl rand -hex 32`)' : ` — fli env:push ${key} sets it from .env.production`}.`,
        // A credential is somebody's and cannot be invented; the app's own key can.
        key === 'ENCRYPTION_KEY' ? { variables: [{ key, isSecret: true, generate: 'hex32' }] } : null)
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

  // A setup that stopped after the static App's Domain left no route back, and
  // the hostname served the page for /api (`FJS-3529`).
  // Per surface: a widgets App's Domain routes nothing back (`FJS-D1547`), so
  // only web/'s static App is the API's front door.
  const staticApps = (siblings ?? []).filter(s => s.id !== app.id && s.source?.kind === 'inline')
  const statics    = staticApps.filter(s => surfaceOf(s) === 'web')
  const norm    = (p) => String(p).trim().toLowerCase().replace(/\/+$/, '')
  // Basecamp's answer, on the App's detail (`FJS-D1981`): one entry per Domain that fronts it.
  const fronts  = (app.fronts ?? [])
    .filter(s => surfaceOf(staticApps.find(a => a.id === s.id)) === 'web')
    .flatMap(s => (s.domains ?? []).map(d => ({ app: s, domain: d })))
  const fronted = fronts.length > 0
  for (const { app: s, domain: d } of fronts) {
    if (!routes) continue
    const on      = routes.filter(r => r.domainId === d.id)
    const have    = new Set(on.map(r => norm(r.pathPrefix)))
    const missing = prefixes.filter(p => !have.has(norm(p)))
    if (!missing.length) continue
    add('route-missing', 'warn', `${d.hostname} serves ${s.name}, and routes ${missing.join(' and ')} to no App`,
      `It is the Domain of the static App, so a request for the API under ${missing.join(' or ')} is answered with the page.`,
      `Route ${missing.join(' and ')} on ${d.hostname} to '${app.name}'.`,
      { routes: [{ domainId: d.id, hostname: d.hostname, prefixes: missing }] })
  }
  if (!routes && statics.some(s => s.domains?.length))
    add('unreadable', 'warn', "could not read the Domain routes",
      `${unread.routes ?? 'No answer'} — so whether the static App's Domain reaches this App was not checked.`,
      /\b403\b/.test(unread.routes ?? '') ? 'Issue the key with domainRoutes:read.' : 'Run it again, or read the routes in Basecamp.')

  if (!(app.domains ?? []).length && !app.hasExposedPort && !fronted && !(routes ?? []).some(r => r.appId === app.id))
    add('unrouted', 'warn', 'nothing routes to the App',
      'It has no Domain and its port is not exposed, so it answers no one outside the machine.',
      'Add a Domain to the App.',
      // A lone static App with no Domain is web/'s, made by a setup that stopped before its Domain.
      { domain: true, ...(statics.length === 1 ? { webApp: statics[0].id } : {}) })

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

  // ── will it migrate ───────────────────────────────────────────────────────
  for (const f of migrations?.findings ?? [])
    add('migration-history', 'error', 'the migration history does not build the schema', f.message, null)
  for (const s of migrations?.skipped ?? [])
    add('unreadable', 'warn', 'could not ask whether the migration history builds the schema', s.why, null)

  // ── what else ─────────────────────────────────────────────────────────────
  if (siblings) {
    const released = (surface) => staticApps.filter(s => surfaceOf(s) === surface)
    for (const surface of surfaces) {
      if ((surface === 'web' || surface === 'widgets') && released(surface).length) continue
      const fixable = surface === 'web' || surface === 'widgets'
      add('surface-unreleased', 'info', `${surface}/ is released by nothing in ${app.environment?.name ?? 'this environment'}`,
        `This App is the API image, and ${surface}/ is not in it.`,
        fixable
          ? 'Create a static App for it and release it with `fli basecamp:deploy --app <its id>`.'
          : `Release ${surface}/ on its own, or ignore this if it is not meant to be live here.`,
        surface === 'web' ? { web: true } : surface === 'widgets' ? { widgets: true } : null)
    }
    // A setup that stopped after the widgets App left the widget origin with no hostname.
    const widgets = released('widgets')
    if (surfaces.includes('widgets') && widgets.length && !widgets.some(s => s.domains?.length))
      add('widgets-unrouted', 'info', `the widgets App '${widgets[0].name}' has no Domain`,
        'Its files are released, and no hostname reaches them.',
        'Give it a hostname with --widgets-domain, or deploy.widgets.domain in frontier.config.js.',
        { widgetsApp: widgets[0].id })
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

/**
 * Every finding's `fix`, merged into the writes one walkthrough makes. Each
 * fix is something missing, so `empty` is the gate: a run that stopped part
 * way plans the rest, and a settled App plans nothing (`FJS-D1599`).
 *
 *   app        one PATCH /apps/:id
 *   variables  POST /variables rows — `generate: 'hex32'` is minted by the
 *              caller and never printed, `derive: 'origin'` is https://hostname
 *   web        create a static App for web/ (`FJS-D1547`)
 *   domain     `{ hostname, on: 'web' | 'api', webId?, routes }` — on the
 *              static App (`webId` when it exists) with the API's prefixes
 *              routed here, or on this App without one
 *   routes     `{ domainId, hostname, prefixes }` — routes back to this App
 *              on a Domain that already exists
 *   widgets    create a static App for widgets/ — only with a widgets hostname
 *   widgetsDomain  `{ hostname, widgetsId? }` — on the widgets App, and no
 *              route back: the widget origin is cross-origin by definition
 *   askedWidgets  widgets/ is waiting on a hostname, which a guess would write to DNS
 *
 * `hostname` empty leaves `domain` null and the `derive` rows out, and says so
 * in `asked`, so a run with no terminal prints what one answer would unlock.
 * `prefixes` is `routePrefixes(apiPaths(snapshot))` from `core/edge.js`.
 */
export function releasePlan(findings, { hostname = '', widgetsHostname = '', prefixes = ['/api', '/ws'] } = {}) {
  const app  = {}
  const vars = new Map()
  const routes = []
  let web = false, domain = false, webId = null, widgets = false, widgetsId = null
  for (const f of findings) {
    if (!f.fix) continue
    Object.assign(app, f.fix.app ?? {})
    for (const v of f.fix.variables ?? []) if (!vars.has(v.key)) vars.set(v.key, v)
    routes.push(...f.fix.routes ?? [])
    web    ||= !!f.fix.web
    domain ||= !!f.fix.domain
    webId  ??= f.fix.webApp ?? null
    widgets ||= !!f.fix.widgets
    widgetsId ??= f.fix.widgetsApp ?? null
  }
  const fronted = web || !!webId
  const bare = (h) => h.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const host = bare(hostname)
  const widgetsHost = bare(widgetsHostname)
  const wantsWidgets = widgets || !!widgetsId
  const variables = [...vars.values()].flatMap(v => {
    if (v.derive !== 'origin') return [v]
    return host ? [{ key: v.key, value: `https://${host}` }] : []
  })
  const asked = [...vars.values()].filter(v => v.derive === 'origin').map(v => v.key)
  return {
    app, variables, web, routes,
    widgets: widgets && !!widgetsHost,
    widgetsDomain: wantsWidgets && widgetsHost ? { hostname: widgetsHost, ...(widgetsId && !widgets ? { widgetsId } : {}) } : null,
    askedWidgets: wantsWidgets && !widgetsHost,
    domain: domain && host
      ? { hostname: host, on: fronted ? 'web' : 'api', ...(webId && !web ? { webId } : {}), routes: fronted ? prefixes : [] }
      : null,
    asked:  host ? [] : [...(domain ? ['Domain'] : []), ...asked],
    empty:  !Object.keys(app).length && !variables.length && !web && !routes.length && !(domain && host) && !(wantsWidgets && widgetsHost),
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
  if (!entry) return { error: `no env module (${ENV_MODULES.join(', ')})`, absent: true }
  const r = run('bun', ['-e', PROBE, entry], {
    cwd: root, encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  })
  const line = String(r.stdout ?? '').trim().split('\n').at(-1)
  try { return JSON.parse(line) } catch { return { error: `the env module did not load: ${String(r.stderr ?? '').trim().split('\n')[0] || `exit ${r.status}`}` } }
}

/** Where an app with no env module writes its required keys down, in the order read. */
export const ENV_REFERENCES = ['.env.example', '.env.keys']

/**
 * The keys a release refuses to go out without: the `defineEnv` spec's
 * required ones, the set `env-required` grades, so both doors refuse on one
 * set (`FJS-D1977`). An app with no env module falls back to `.env.example`,
 * every key of it. `warning` is why an env module that exists was not read —
 * the fallback then grades a file the app does not boot by.
 * @returns {{ keys: string[], from: string|null, warning?: string }}
 */
export function requiredEnvKeys(root, { run } = {}) {
  const env = readEnvSpec(root, { run })
  if (env.spec) return {
    keys: Object.entries(env.spec).filter(([, f]) => f.required).map(([k]) => k),
    from: 'defineEnv',
  }
  const ref  = ENV_REFERENCES.find(name => existsSync(join(root, name))) ?? null
  const keys = ref
    ? readFileSync(join(root, ref), 'utf8').split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .map(l => l.split('=')[0].trim())
        .filter(Boolean)
    : []
  return { keys, from: ref, ...(env.absent ? {} : { warning: env.error }) }
}

/** Everything `releaseFindings` reads from the app's tree. */
export function gatherReleaseInputs(root, { dockerfile = 'deploy/Dockerfile', dockerfileText, run } = {}) {
  const health = resolveHealthPath(root)
  const dfPath = join(root, dockerfile)
  return {
    envSpec:   readEnvSpec(root, { run }),
    databases: declaredDatabasePaths(join(root, 'db')),
    health:    { path: health.path, declared: declaresHealth(root, health.path).declared },
    image:     imageRuntime(dockerfileText ?? (existsSync(dfPath) ? readFileSync(dfPath, 'utf8') : '')),
    surfaces:  ['web', 'widgets', 'site'].filter(s => existsSync(join(root, s))),
    migrations: existsSync(join(root, 'db', 'schema.lite')) ? runChecks({ root, only: ['migration-history'] }) : null,
  }
}

/**
 * Does `db/migrations` build `db/schema.lite`? The one question both doors ask
 * before a build (`FJS-4071`, `FJS-4102`): the same `migration-history` rule
 * `fli check` runs, graded the way `releaseFindings` grades it. A rule that
 * could not ask is a warning, a gap is an error. An app with no schema has no
 * history to ask about.
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function migrationHistoryVerdict(root) {
  const migrations = gatherReleaseInputs(root).migrations
  return {
    errors:   (migrations?.findings ?? []).map(f => f.message),
    warnings: (migrations?.skipped ?? []).map(s => s.why),
  }
}
