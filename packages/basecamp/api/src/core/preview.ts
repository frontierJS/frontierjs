// src/core/preview.ts — Open: a Workbench branch made a client's preview
// (IDEAS/preview-branch.md, slice 3).
//
// A preview is an Environment whose Release is the branch's `web/`. While
// someone edits, the bytes are the worktree's Vite dev server, which proxies
// production's API by path; the hostname reaches it through a `/route` to the
// dev server's port on the machine holding the worktree.
//
// Freeze builds `web/` with the App's browser variables (`VITE_`,
// `FRONTIER_PUBLIC_`) and publishes the build to the machine itself, then
// releases that digest as an ordinary Deployment: the files never enter a row,
// because a built SPA runs to 180 files and several megabytes, every row here
// is in the audit trail, and a Deployment is pushed whole to every browser in
// the workspace. The commit names the bytes.
// Activating routes the hostname to the static origin. Thaw routes it back to
// the dev server's port. Retire removes the Environment, which takes its App
// off the machine before the App, Variables and Domain go with it.
//
// The rows are written through each row's own service, as the caller, so
// every check a person's create meets is met here too. Nothing here stores
// the preview's state: editing is the route, frozen is an active release,
// retired is the Environment soft-deleted.
//
// The settings live on the CHECKOUT's pin, set once by `configure`: which
// project the previews belong to, which app in the checkout, which machine
// holds the worktrees, the wildcard domain, and production's API origin.

import { execFileSync, spawn }     from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir }                   from 'node:os'
import { isAbsolute, join, normalize, relative } from 'node:path'
import { executorOn, isExecutor, resolveExecutor } from '../providers/executor.ts'
import { snapshotVariables }        from './variables.ts'
import { db }                       from './resource.ts'
import { routedHosts, routedPaths, routedRedirects } from './runtime.ts'
import { childEnv }                 from '@frontierjs/junction'
import type { App }                 from '@frontierjs/junction'
import { env }                      from './env.ts'
import type { MachineAnswer }       from '../services/apps/apps.service.ts'

export type PreviewSettings = {
  projectId: string
  /** The app inside the checkout, relative; its `web/` is what a preview edits. */
  app:       string
  /** `*.<domain>` is the one wildcard record and certificate every preview shares. */
  domain:    string
  /** Production's API origin — the frozen build's `FRONTIER_PUBLIC_API_URL`. */
  apiUrl:    string
  /** The machine whose Outpost routes the hostname to the worktree's dev server. */
  serverId:  string | null
}

/** What Open made, on the branch's pin. */
export type Opened = {
  port:          number
  environmentId: string
  appId:         string
  hostname:      string
  /** Whether the machine took the route, in its words when it did not. */
  route:         { ok: true, note: string | null } | { ok: false, why: string }
}

const LABEL  = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const DOMAIN = (d: string) => d.length <= 200 && d.split('.').length >= 2 && d.split('.').every(l => LABEL.test(l))

/** A branch slug is one hostname label under the wildcard, or the certificate does not cover it. */
export function previewLabelRefusal(slug: string): string | null {
  return LABEL.test(slug) ? null
    : `'${slug}' cannot name a preview — its hostname label takes lowercase letters, digits and inner '-' only`
}

/** The settings a checkout's pin carries, or why not. `root` is the checkout. */
export function previewSettings(input: unknown, root: string): PreviewSettings | { refused: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { refused: 'preview is an object of projectId, app, domain, apiUrl and serverId' }
  const raw = input as Record<string, unknown>
  const projectId = String(raw.projectId ?? '').trim()
  if (!projectId) return { refused: 'preview needs the projectId its environments go under' }

  const app = normalize(String(raw.app ?? '.').trim() || '.')
  if (isAbsolute(app) || app.split('/').includes('..')) return { refused: `'${raw.app}' is not a directory inside the checkout` }
  if (!existsSync(join(root, app, 'web'))) return { refused: `${join(root, app)} has no web/ for a preview to edit` }

  const domain = String(raw.domain ?? '').trim().toLowerCase().replace(/^\*\./, '')
  if (!DOMAIN(domain)) return { refused: `'${raw.domain}' is not a domain a preview's hostname can sit under` }

  let apiUrl: string
  try {
    const u = new URL(String(raw.apiUrl ?? ''))
    if (!/^https?:$/.test(u.protocol)) throw new Error()
    apiUrl = u.origin
  } catch { return { refused: `'${raw.apiUrl}' is not production's API origin — an http(s) URL` } }

  const serverId = raw.serverId == null || raw.serverId === '' ? null : String(raw.serverId)
  return { projectId, app, domain, apiUrl, serverId }
}

// An inline App has files from its first row. While the dev server holds the
// route this page is never served; it answers only before the first route and
// after a route is dropped with no release active.
const PLACEHOLDER = (branch: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Preview</title></head>
<body><p>This preview of ${branch} is not being served right now.</p></body></html>
`

/**
 * The rows, the placement and the route for a branch already cut. Either every
 * row lands or the Environment is removed again; the route is a push, and a
 * machine that refused it is reported, not undone.
 */
export async function openPreview(app: App, settings: PreviewSettings,
  branch: { slug: string, branch: string, port: number }): Promise<Opened> {
  const hostname = `${branch.slug}.${settings.domain}`
  const svc = (name: string) => app.service(name) as any
  const env = await svc('environments').create({
    projectId: settings.projectId, name: `Preview · ${branch.slug}`, slug: `wb-${branch.slug}`, tier: 'preview',
  }) as { id: string }
  let appId: string
  try {
    const made = await svc('apps').create({
      environmentId: env.id, name: 'web', slug: 'web', type: 'static', port: branch.port,
      source: { kind: 'inline', files: [{ path: 'index.html', content: PLACEHOLDER(branch.branch) }] },
    }) as { id: string }
    appId = made.id
    await svc('variables').create({ environmentId: env.id, appId, key: 'FRONTIER_PUBLIC_API_URL', value: settings.apiUrl })
    await svc('domains').create({ appId, hostname })
    if (settings.serverId) await svc('apps').call('place', appId, { serverId: settings.serverId })
  } catch (e) {
    await svc('environments').remove(env.id).catch(() => {})
    throw e
  }

  return { port: branch.port, environmentId: env.id, appId, hostname, route: await routeTo(app, settings.serverId, appId, [hostname], branch.port) }
}

async function routeTo(app: App, serverId: string | null, appId: string, hosts: string[], port: number): Promise<Opened['route']> {
  if (!serverId) return { ok: false, why: 'no machine is named in the checkout\'s preview settings, so nothing routes the hostname' }
  const executor = await executorOn(app, serverId)
  if (!isExecutor(executor)) return { ok: false, why: executor.reason }
  // A /route that names no redirects or paths removes the ones the machine holds.
  const paths     = await routedPaths(app.db, appId)
  const redirects = await routedRedirects(app.db, appId)
  const reply = await executor.call('/route', { app_id: appId, hosts, paths, redirects, port })
  if (reply.error) return { ok: false, why: reply.error.message }
  const note = (reply.data as { note?: unknown } | undefined)?.note
  return { ok: true, note: typeof note === 'string' ? note : null }
}

// ─── Freeze ──────────────────────────────────────────────────────────────

const BUILD_MS = 5 * 60_000

/** What Freeze sent and the release it queued. */
export type Frozen = {
  deploymentId: string
  digest:       string
  files:        number
  bytes:        number
  /** HEAD of the branch, or null when the tree holds work HEAD does not —
   *  the build is of the tree, and a sha that names other bytes is worse
   *  than none. */
  commitSha:    string | null
}

type Wire = { path: string, content: string } | { path: string, content_base64: string }

/**
 * The branch's `web/` built, published to the machine holding its App, and
 * released by digest. Refused before anything reaches the machine when the
 * build fails or its bundle does not carry `FRONTIER_PUBLIC_API_URL`.
 */
export async function freezePreview(app: App, settings: PreviewSettings,
  branch: { path: string, branch: string, appId: string }): Promise<Frozen> {
  const svc   = (name: string) => app.service(name) as any
  const row   = await svc('apps').get(branch.appId) as { id: string, environmentId: string }
  const vars  = (await snapshotVariables(db(), row)).env
  // Only what a bundle may carry — sierra's `ENV_PREFIX` — reaches the build
  // process; the App's secrets never enter it.
  const env   = Object.fromEntries(Object.entries(vars).filter(([k]) => k.startsWith('VITE_') || k.startsWith('FRONTIER_PUBLIC_')))

  const out = mkdtempSync(join(tmpdir(), 'preview-freeze-'))
  try {
    await build(join(branch.path, settings.app, 'web'), out, env)
    const files = filesUnder(out)
    if (env.FRONTIER_PUBLIC_API_URL && !files.some(f => 'content' in f && f.content.includes(env.FRONTIER_PUBLIC_API_URL)))
      throw new Error(`the build finished and no file carries FRONTIER_PUBLIC_API_URL (${env.FRONTIER_PUBLIC_API_URL}) — web/'s sierra.config.js has to read it for junction.url, or the frozen page calls its own origin`)

    const executor = await resolveExecutor(app, branch.appId)
    if (!isExecutor(executor)) throw new Error(executor.reason)
    const reply = await executor.call('/static/publish', { app_id: branch.appId, files }, { timeoutMs: 120_000 })
    if (reply.error) throw new Error(`the machine refused the build: ${reply.error.message}`)
    const digest = String((reply.data as { digest?: unknown })?.digest ?? '')
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('the machine wrote the build and reported no digest')

    const commitSha = cleanHead(branch.path)
    const deployment = await svc('deployments').create({
      appId: branch.appId, trigger: 'freeze', builtImage: digest, commitSha, branch: branch.branch,
    }) as { id: string }
    const bytes = files.reduce((n, f) => n + ('content' in f ? Buffer.byteLength(f.content) : Buffer.from(f.content_base64, 'base64').length), 0)
    return { deploymentId: deployment.id, digest, files: files.length, bytes, commitSha }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

// Sierra's layout first; a plain Vite app keeps its config beside index.html.
const VITE_CONFIGS = ['config/vite.config.js', 'config/vite.config.ts', 'vite.config.js', 'vite.config.ts', 'vite.config.mjs']

/** `vite build` from web/ into `out`, never into web/dist — `vite build`
 *  empties its outDir, and the worktree's own is the dev server's to keep. */
function build(web: string, out: string, vars: Record<string, string>): Promise<void> {
  const config = VITE_CONFIGS.map(c => join(web, c)).find(existsSync)
  if (!config) return Promise.reject(new Error(`${web} has no vite config (looked for ${VITE_CONFIGS.join(', ')})`))
  return new Promise((done, fail) => {
    let tail = ''
    const child = spawn(process.execPath, ['--bun', 'vite', 'build', '-c', config, '--outDir', out, '--emptyOutDir'], {
      cwd: web, env: { ...childEnv(env), ...vars, NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const keep  = (b: Buffer) => { tail = (tail + b.toString('utf8')).slice(-4000) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => child.kill('SIGTERM'), BUILD_MS)
    child.on('error', e => { clearTimeout(timer); fail(e) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) return done()
      fail(new Error(`vite build ${signal ? `stopped after ${BUILD_MS / 60_000} minutes` : `exited ${code}`}:\n${tail.trim().split('\n').slice(-15).join('\n')}`))
    })
  })
}

const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** Every file under the build, text as text and the rest as base64. Sierra
 *  writes the page under `client/` when a server half is built beside it. */
function filesUnder(out: string): Wire[] {
  const root = existsSync(join(out, 'index.html')) ? out : join(out, 'client')
  if (!existsSync(join(root, 'index.html'))) throw new Error('the build wrote no index.html, so its address would serve nothing')
  return (readdirSync(root, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
    .filter(e => e.isFile())
    .map(e => {
      const abs   = join(e.parentPath, e.name)
      const path  = relative(root, abs)
      const bytes = readFileSync(abs)
      try { return { path, content: UTF8.decode(bytes) } }
      catch { return { path, content_base64: bytes.toString('base64') } }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

function cleanHead(path: string): string | null {
  const git = (...argv: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', path, ...argv], { encoding: 'utf8', env: childEnv(env) }).trim()
  try { return git('status', '--porcelain') ? null : git('rev-parse', 'HEAD') }
  catch { return null }
}

// ─── Thaw and Retire ─────────────────────────────────────────────────────

/** The hostnames back on the branch's dev server. A static release stays on
 *  the machine; the route is what says which one serves. The port and the
 *  hostnames are the App's and its Domains' — `opened` is what Open made,
 *  and a row edited since is what the machine must be told. */
export async function thawPreview(app: App, settings: PreviewSettings, opened: Opened): Promise<Opened['route'] & { port: number | null, hosts: string[] }> {
  const row   = await (app.service('apps') as any).get(opened.appId) as { id: string, port: number | null }
  const hosts = await routedHosts(app.db, row.id)
  if (!row.port) return { ok: false, why: 'the App names no port for its dev server', port: null, hosts }
  return { ...await routeTo(app, settings.serverId, row.id, hosts, row.port), port: row.port, hosts }
}

/**
 * The preview off the machine: the Environment removed, which retires its
 * App's files and its hostname's route — whichever port that dialed — before
 * its App, Variables and Domain cascade. A machine that cannot be reached
 * does not keep the rows and is reported: its route still dials the branch's
 * port, which Archive then gives back for another branch to claim.
 */
export async function retirePreview(app: App, opened: Opened): Promise<{ machine: MachineAnswer }> {
  const gone    = (e: { code?: number }) => { if (e?.code !== 404) throw e; return null }
  const removed = await (app.service('environments') as any).remove(opened.environmentId).catch(gone) as { apps: { id: string, machine: MachineAnswer }[] } | null
  return { machine: removed?.apps.find(a => a.id === opened.appId)?.machine ?? { ok: true } }
}
