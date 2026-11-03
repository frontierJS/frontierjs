// src/domain/workbench/workbench-preview.ts -- the settings a checkout's pin carries
// for a client preview, and what a preview is called. Opening one is Basecamp's
// `apps.preview`, dialed as a peer (`domain/peer/basecamp.ts`); these are the
// shapes the dialer sends and stores, copied from Basecamp's own
// `api/src/domain/workbench/workbench-preview.ts` -- the two apps import nothing
// from each other.
//
// The settings live on the CHECKOUT's pin, set once by `configure`: which
// project the previews belong to, which app in the checkout, which machine
// holds the worktrees, the wildcard domain, and production's API origin.

import { existsSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'

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

