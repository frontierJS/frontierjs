// src/providers/platform/cloudflare.ts
// Cloudflare Workers as a platform: the scripts an account runs, their
// versions, and which of them serve traffic. The envelope is edge's (`unwrap`,
// `walk` in `../edge/cloudflare.ts`), so a 200 carrying `success: false` is
// refused in Cloudflare's own words here as it is for DNS.
//
// The token is the account-owned one (`FJS-D558`). Every read below answers
// to it; `/builds/` does not and is not called here (`FJS-D1638`).
//
// A build's deployment reads like a laptop's (`source: wrangler`, the token
// owner's email, no message), so nothing here can tell them apart — that is
// the Builds API's version-to-build lookup, under the user token.

import { unwrap, walk } from '../edge/cloudflare.ts'
import type { PlatformConnector, PlatformProject, PlatformVersion, PlatformDeployment } from './index.ts'

/** Cloudflare pages versions at 100 at most. */
const VERSIONS_PER_PAGE = 100

type Row = Record<string, unknown>

const str = (v: unknown): string        => typeof v === 'string' ? v : ''
const opt = (v: unknown): string | null => typeof v === 'string' && v ? v : null
const num = (v: unknown): number        => typeof v === 'number' && Number.isFinite(v) ? v : 0

const scripts = (account: string) => `/accounts/${encodeURIComponent(account)}/workers/scripts`
const script  = (account: string, name: string) => `${scripts(account)}/${encodeURIComponent(name)}`

/** An assets-only Worker answers no `fetch` of its own: it is a site. */
function toProject(s: Row): PlatformProject {
  const handlers = Array.isArray(s.handlers) ? s.handlers as unknown[] : []
  return {
    name:             str(s.id),
    id:               str(s.tag) || str(s.id),
    kind:             s.has_assets === true && !handlers.includes('fetch') ? 'site' : 'worker',
    createdAt:        str(s.created_on),
    modifiedAt:       str(s.modified_on),
    lastDeployedFrom: opt(s.last_deployed_from),
  }
}

function toVersion(v: Row): PlatformVersion {
  const meta = (v.metadata ?? {}) as Row
  const ann  = (v.annotations ?? {}) as Row
  return {
    id:          str(v.id),
    number:      num(v.number),
    createdAt:   str(meta.created_on),
    source:      opt(meta.source),
    author:      opt(meta.author_email),
    message:     opt(ann['workers/message']),
    triggeredBy: opt(ann['workers/triggered_by']),
  }
}

function toDeployment(d: Row): PlatformDeployment {
  const ann = (d.annotations ?? {}) as Row
  return {
    id:        str(d.id),
    createdAt: str(d.created_on),
    source:    opt(d.source),
    author:    opt(d.author_email),
    message:   opt(ann['workers/message']),
    versions:  (Array.isArray(d.versions) ? d.versions as Row[] : [])
      .map(v => ({ id: str(v.version_id), percent: num(v.percentage) })),
  }
}

export const cloudflare: PlatformConnector = {
  kind:  'cloudflare',
  label: 'Cloudflare Workers',

  async verify(send): Promise<boolean> {
    // `/accounts` rather than a token-verify path: an account-owned token is
    // verified under `/accounts/<id>/`, and the id is what this finds out. A
    // 4xx is Cloudflare refusing THIS token; anything else is not knowing.
    const res = await send({ method: 'GET', path: '/accounts?per_page=5' })
    if (res.error) {
      if (res.status && res.status < 500) return false
      throw new Error(`Cloudflare: ${res.error.kind}`)
    }
    const { result } = unwrap(res)
    return Array.isArray(result) && result.length > 0
  },

  async accounts(send) {
    return (await walk(send, '/accounts?per_page=50')).map(a => ({ id: str(a.id), name: str(a.name) }))
  },

  async projects(send, account) {
    const { result } = unwrap(await send({ method: 'GET', path: scripts(account) }))
    return (Array.isArray(result) ? result as Row[] : []).map(toProject)
  },

  async project(send, account, name) {
    // `GET …/scripts/<name>` answers the script's CODE as multipart, not its
    // settings; the list is one request and carries every field adopting reads.
    return (await this.projects(send, account)).find(p => p.name === name) ?? null
  },

  async versions(send, account, name, opts = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), VERSIONS_PER_PAGE)
    const { result } = unwrap(await send({ method: 'GET', path: `${script(account, name)}/versions?per_page=${limit}` }))
    const items = ((result ?? {}) as Row).items
    return (Array.isArray(items) ? items as Row[] : []).map(toVersion)
  },

  async deployments(send, account, name) {
    const { result } = unwrap(await send({ method: 'GET', path: `${script(account, name)}/deployments` }))
    const list = ((result ?? {}) as Row).deployments
    return (Array.isArray(list) ? list as Row[] : []).map(toDeployment)
  },
}
