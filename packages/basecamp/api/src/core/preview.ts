// src/core/preview.ts — Open: a Workbench branch made a client's preview
// (IDEAS/preview-branch.md, slice 3).
//
// A preview is an Environment whose Release is the branch's `web/`. While
// someone edits, the bytes are the worktree's Vite dev server, which proxies
// production's API by path; the hostname reaches it through a `/route` to the
// dev server's port on the machine holding the worktree. Freeze (slice 4)
// replaces that with a static release of the same App.
//
// The rows are written through each row's own service, as the caller, so
// every check a person's create meets is met here too. Nothing here stores
// the preview's state: editing is the route, frozen is an active release,
// retired is the Environment soft-deleted.
//
// The settings live on the CHECKOUT's pin, set once by `configure`: which
// project the previews belong to, which app in the checkout, which machine
// holds the worktrees, the wildcard domain, and production's API origin.

import { existsSync }               from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import { executorOn, isExecutor }   from '../providers/executor.ts'
import type { BasecampApp }         from '../basecamp.types.ts'

export type PreviewSettings = {
  projectId: string
  /** The app inside the checkout, relative; its `web/` is what a preview edits. */
  app:       string
  /** `*.<domain>` is the one wildcard record and certificate every preview shares. */
  domain:    string
  /** Production's API origin — the frozen build's `VITE_API_URL`. */
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
export async function openPreview(app: BasecampApp, settings: PreviewSettings,
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
    await svc('variables').create({ environmentId: env.id, appId, key: 'VITE_API_URL', value: settings.apiUrl })
    await svc('domains').create({ appId, hostname })
    if (settings.serverId) await svc('apps').call('place', appId, { serverId: settings.serverId })
  } catch (e) {
    await svc('environments').remove(env.id).catch(() => {})
    throw e
  }

  return { port: branch.port, environmentId: env.id, appId, hostname, route: await routeTo(app, settings.serverId, appId, hostname, branch.port) }
}

async function routeTo(app: BasecampApp, serverId: string | null, appId: string, hostname: string, port: number): Promise<Opened['route']> {
  if (!serverId) return { ok: false, why: 'no machine is named in the checkout\'s preview settings, so nothing routes the hostname' }
  const executor = await executorOn(app, serverId)
  if (!isExecutor(executor)) return { ok: false, why: executor.reason }
  const reply = await executor.call('/route', { app_id: appId, hosts: [hostname], port })
  if (reply.error) return { ok: false, why: reply.error.message }
  const note = (reply.data as { note?: unknown } | undefined)?.note
  return { ok: true, note: typeof note === 'string' ? note : null }
}
