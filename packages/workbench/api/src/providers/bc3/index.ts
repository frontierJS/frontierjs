// api/src/providers/bc3/index.ts -- Basecamp, the 37signals product, and the
// ONE folder in Workbench that names it (`FJS-D2264`). `BASECAMP` in this app's
// environment is the FrontierJS Basecamp, so everything else here says "to-do"
// and imports from this file.
//
// What crosses to Basecamp is a client-visible record that cannot be taken
// back, so a to-do is built here from the fields the person saw -- a project,
// a list, a title -- and a permalink the server computes, never from a post's
// text (`FJS-D2262`).
//
// The grant is the owner's and the app's (`FJS-D2341`): one device-code
// sign-in at app.basecamp.com, through a public client Workbench registers
// once, kept in basecamp.json under workbenchDir() -- the client id, the
// account and the refresh token, which a rotation rewrites and a refused
// refresh clears. Every to-do is authored as whoever signed in.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  authorization, awaitDeviceGrant, basecampSignInTargets, basecampTargets, basecampTokenResolver, bindBasecamp,
  createTodo, project, projects, registerClient, startDeviceSignIn, todolists, translate,
  type BasecampFailure, type BasecampSend, type DeviceSignIn, type GrantStore,
} from '@frontierjs/conduit-37signals'
import { withCache, type CredentialResolver } from '@frontierjs/conduit'
import type { App } from '@frontierjs/junction'
import { workbenchDir } from '../../core/env.ts'

const USER_AGENT = 'Workbench (https://frontierjs.dev)'
const REF = 'BC3_TOKEN'

/** What the person is shown while a sign-in waits; the device code never leaves the server. */
export type SignInShown = { userCode: string, verificationUri: string, verificationUriComplete: string | null, expiresAt: number }

interface Bc3 {
  origins: { apiOrigin?: string, tokenOrigin?: string }
  /** The account whose `api` target the conduit holds, or null. */
  account: string | null
  signIn: SignInShown | null
  /** Why the last sign-in stopped without a grant: denied, expired, several_accounts, or a connector kind. */
  ended: string | null
  resolver: { clientId: string, r: CredentialResolver } | null
}

type Grant = { clientId?: string, accountId?: number, refreshToken?: string }

export const grantFile = () => join(workbenchDir(), 'basecamp.json')
const readGrant = (): Grant => {
  try { return JSON.parse(readFileSync(grantFile(), 'utf8')) ?? {} } catch { return {} }
}
// The mode on writeFileSync applies only to a file it creates.
const writeGrant = (g: Grant) => {
  const f = grantFile()
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, JSON.stringify(g, null, 2) + '\n', { mode: 0o600 })
  chmodSync(f, 0o600)
}

const bc3Of = (app: App): Bc3 => (app as unknown as { bc3: Bc3 }).bc3

/** Whether a grant is held and its account's target registered. */
export const todosOn = (app: App) => {
  const g = readGrant()
  return !!(g.refreshToken && g.accountId) && bc3Of(app).account === String(g.accountId)
}

const store: GrantStore = {
  refreshTokenFor: () => readGrant().refreshToken ?? null,
  onRotated: (_ref, next) => writeGrant({ ...readGrant(), refreshToken: next }),
  // The client and the account stay, so Connect again reuses the client.
  onLost: () => { const { refreshToken: _lost, ...rest } = readGrant(); writeGrant(rest) },
}

// Rebuilt when the client changes or a sign-in lands, so an access token
// cached for the last grant is never spent for the next one.
const resolverOf = (app: App): CredentialResolver | null => {
  const s = bc3Of(app), clientId = readGrant().clientId
  if (!clientId) return null
  if (s.resolver?.clientId !== clientId) {
    const r = withCache(basecampTokenResolver(bindBasecamp(app.conduit!), { clientId, grants: store }), { ttl_ms: Infinity })
    s.resolver = { clientId, r }
  }
  return s.resolver.r
}

const accountTarget = (app: App, accountId: number | string) =>
  basecampTargets({ accountId, userAgent: USER_AGENT, ref: REF, ...bc3Of(app).origins }).api

/**
 * Claims `app.bc3`. `credentials` is what the conduit's resolver gets for
 * `BC3_TOKEN`, so the one conduit plugin the chat provider configures carries
 * these targets too. The account's target is registered here when a grant is
 * held, else by the sign-in that lands one.
 */
export function bc3Provider (app: App, opts: { apiOrigin?: string | null, tokenOrigin?: string | null }): {
  targets: ReturnType<typeof basecampTargets>['api'][]
  credentials: Record<string, CredentialResolver>
} {
  const origins = { ...(opts.apiOrigin ? { apiOrigin: opts.apiOrigin } : {}), ...(opts.tokenOrigin ? { tokenOrigin: opts.tokenOrigin } : {}) }
  const g = readGrant()
  const account = g.accountId && g.refreshToken ? String(g.accountId) : null
  app.own('bc3', { origins, account, signIn: null, ended: null, resolver: null } satisfies Bc3)
  const signIn = basecampSignInTargets({ userAgent: USER_AGENT, ...origins })
  return {
    targets: [signIn.token, signIn.register, ...(account ? [accountTarget(app, account)] : [])],
    credentials: { [REF]: { get: async ref => resolverOf(app)?.get(ref) ?? null } },
  }
}

/** The card's view: on, waiting for the person, or why the last sign-in stopped. */
export const signInState = (app: App) => {
  const s = bc3Of(app)
  if (s.signIn && s.signIn.expiresAt <= Date.now()) { s.signIn = null; s.ended = 'expired' }
  return { signIn: s.signIn, ended: s.ended }
}

/**
 * Starts a sign-in, registering the client first if none is held, and polls
 * in this process until the person approves; the card reads `signInState`.
 * One at a time: a second Connect while one waits shows the same code.
 */
export async function connect (app: App): Promise<{ signIn: SignInShown } | { error: BasecampFailure }> {
  const s = bc3Of(app)
  const waiting = signInState(app).signIn
  if (waiting) return { signIn: waiting }
  const bc = bindBasecamp(app.conduit!)
  let g = readGrant()
  if (!g.clientId) {
    const r = await registerClient(bc, { clientName: 'Workbench' })
    if (!r.clientId) return { error: r.error ?? ({ kind: 'refused', retryable: false } as BasecampFailure) }
    g = { ...g, clientId: r.clientId }
    writeGrant(g)
  }
  const started = await startDeviceSignIn(bc, { clientId: g.clientId! })
  if (!started.signIn) return { error: started.error ?? ({ kind: 'refused', retryable: false } as BasecampFailure) }
  const d = started.signIn
  s.signIn = { userCode: d.userCode, verificationUri: d.verificationUri, verificationUriComplete: d.verificationUriComplete ?? null, expiresAt: d.expiresAt }
  s.ended = null
  land(app, bc, g.clientId!, d).catch(e => {
    s.signIn = null; s.ended = 'failed'
    console.warn(`[bc3] sign-in failed: ${(e as Error).message}`)
  })
  return { signIn: s.signIn }
}

async function land (app: App, bc: BasecampSend, clientId: string, d: DeviceSignIn) {
  const s = bc3Of(app)
  const out = await awaitDeviceGrant(bc, { clientId, signIn: d })
  s.signIn = null
  if (!('grant' in out)) { s.ended = 'ended' in out ? out.ended : kindOf(out.error); return }
  const who = await authorization(bc, { accessToken: out.grant.accessToken, ...(s.origins.apiOrigin ? { apiOrigin: s.origins.apiOrigin } : {}) })
  if (!who.row) { s.ended = kindOf(who.error); return }
  // `api` addresses one account; with several, which one to-dos go to is the owner's call and nothing here guesses.
  const bc3 = who.row.accounts.filter(a => a.product === 'bc3')
  if (bc3.length !== 1) { s.ended = bc3.length ? 'several_accounts' : 'no_account'; return }
  const accountId = bc3[0].id
  if (s.account && s.account !== String(accountId)) await app.conduit!.deregister(accountTarget(app, s.account).id)
  if (s.account !== String(accountId)) await app.conduit!.register(accountTarget(app, accountId))
  writeGrant({ clientId, accountId, refreshToken: out.grant.refreshToken })
  s.resolver = null
  s.account = String(accountId)
  s.ended = null
}

const bound = (app: App): BasecampSend => {
  if (!todosOn(app)) throw Object.assign(new Error('to-dos: Basecamp is not connected on this machine'), { status: 503 })
  return bindBasecamp(app.conduit!, undefined, { as: 'api' })
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
