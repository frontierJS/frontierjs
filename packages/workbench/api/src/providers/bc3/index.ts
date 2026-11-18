// api/src/providers/bc3/index.ts -- Basecamp, the 37signals product, and the
// ONE folder in Workbench that names it (`FJS-D2264`). `BASECAMP` in this app's
// environment is the FrontierJS Basecamp, so everything else here says "to-do"
// and imports from this file.
//
// What crosses to Basecamp is a client-visible record that cannot be taken
// back, so a to-do is built here from the fields the person saw -- a project,
// a list, a title -- and a permalink the server computes, never from a post's
// text (`FJS-D2262`). The process's own token sends it (`as: 'api'`); there is
// no per-member grant until the owner seeds one.

import {
  basecampTargets, bindBasecamp, createTodo, project, projects, todolists, translate,
  type BasecampFailure, type BasecampSend,
} from '@frontierjs/conduit-37signals'
import type { CredentialResolver } from '@frontierjs/conduit'
import type { App } from '@frontierjs/junction'

const USER_AGENT = 'Workbench (https://frontierjs.dev)'

export interface Bc3 {
  /** The targets and the token, or null: no account or no token is to-dos off. */
  targets: ReturnType<typeof basecampTargets> | null
}

const bc3Of = (app: App): Bc3 => (app as unknown as { bc3: Bc3 }).bc3

/** Whether an account and a token are configured at all. */
export const todosOn = (app: App) => !!bc3Of(app).targets

/**
 * Claims `app.bc3`. `credentials` is what the conduit's resolver gets for
 * `BC3_TOKEN`, so the one conduit plugin the chat provider configures
 * carries these targets too.
 */
export function bc3Provider (app: App, opts: { accountId?: string | null, token?: string | null, origin?: string | null }): {
  targets: ReturnType<typeof basecampTargets>['api'][]
  credentials: Record<string, CredentialResolver>
} {
  const on = !!(opts.accountId && opts.token)
  const targets = on ? basecampTargets({ accountId: opts.accountId!, userAgent: USER_AGENT, ref: 'BC3_TOKEN', ...(opts.origin ? { apiOrigin: opts.origin } : {}) }) : null
  app.own('bc3', { targets } satisfies Bc3)
  return targets
    ? { targets: [targets.api], credentials: { BC3_TOKEN: { get: async () => opts.token ?? null } } }
    : { targets: [], credentials: {} }
}

const bound = (app: App): BasecampSend => {
  const { targets } = bc3Of(app)
  if (!targets) throw Object.assign(new Error('to-dos: Basecamp is not configured on this machine (BC3_ACCOUNT_ID, BC3_TOKEN)'), { status: 503 })
  return bindBasecamp(app.conduit!, targets, { as: 'api' })
}

type Place = { id: number, name: string }
type Answer<T> = { rows: T[] } | { error: BasecampFailure }

/** The connector's kind (`forbidden`, `gone`, `rate_limited`...) is what the caller is told, never a body. */
export const kindOf = (e: BasecampFailure | { kind?: string } | undefined) => e?.kind ?? 'no answer'

export async function projectsOf (app: App): Promise<Answer<Place>> {
  const r = await projects(bound(app))
  if (!('rows' in r) || !r.rows) return { error: ('error' in r && r.error) || { kind: 'refused', retryable: false } as BasecampFailure }
  return { rows: r.rows.map(p => ({ id: p.id, name: p.name })) }
}

export async function listsOf (app: App, projectId: number): Promise<Answer<Place>> {
  const bc = bound(app)
  const p = await project(bc, projectId)
  if (!p.row) return { error: p.error ?? { kind: 'refused', retryable: false } as BasecampFailure }
  const r = await todolists(bc, p.row)
  if (!('rows' in r) || !r.rows) return { error: ('error' in r && r.error) || { kind: 'refused', retryable: false } as BasecampFailure }
  return { rows: r.rows.map(l => ({ id: l.id, name: l.name })) }
}

/** The to-do, made once; a lost answer is the connector's `indeterminate`, and the person sees its kind. */
export async function makeTodo (app: App, todo: { projectId: number, listId: number, title: string, notes: string }) {
  const r = await createTodo(bound(app), {
    bucket: todo.projectId, todolist: todo.listId, content: todo.title, description: { text: todo.notes },
  })
  if (!r.row) return { error: r.error ?? ({ kind: 'refused', retryable: false } as BasecampFailure) }
  return { row: { id: r.row.id, appUrl: r.row.app_url } }
}

export { translate }
