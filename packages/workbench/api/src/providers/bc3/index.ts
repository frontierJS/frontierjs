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
// The grant is the owner's and the app's (`FJS-D2341`): one sign-in at
// app.basecamp.com by an authorization code with PKCE, through a public client
// Workbench registers once for its loopback redirect, landing on this API at
// TODOS_CONNECTED_PATH. basecamp.json under workbenchDir() keeps the client id,
// its redirect URI, the account and the refresh token, which a rotation
// rewrites and a refused refresh clears. Every to-do is authored as whoever
// signed in.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  authorization, authorizeUrl, basecampSignInTargets, basecampTargets, basecampTokenResolver, bindBasecamp,
  createTodo, exchangeCode, pkcePair, project, projects, registerClient, todolists, translate,
  type BasecampFailure, type BasecampSend, type GrantStore,
} from '@frontierjs/conduit-37signals'
import { withCache, type CredentialResolver } from '@frontierjs/conduit'
import type { App, TransportContext } from '@frontierjs/junction'
import { workbenchDir } from '../../core/env.ts'

const USER_AGENT = 'Workbench (https://frontierjs.dev)'
const REF = 'BC3_TOKEN'

/** Where Basecamp sends the browser back, on this API's own port. */
export const TODOS_CONNECTED_PATH = '/todos-connected'
const SIGN_IN_MS = 10 * 60_000

/** What the person is shown while a sign-in waits; the verifier never leaves the server. */
export type SignInShown = { url: string, expiresAt: number }
type Pending = SignInShown & { state: string, verifier: string, clientId: string, redirectUri: string }

interface Bc3 {
  origins: { apiOrigin?: string, tokenOrigin?: string }
  /** The account whose `api` target the conduit holds, or null. */
  account: string | null
  /** The one sign-in waiting for the browser to come back. */
  signIn: Pending | null
  /** Why the last sign-in stopped without a grant: denied, expired, several_accounts, no_account, or a connector kind. */
  ended: string | null
  resolver: { clientId: string, r: CredentialResolver } | null
}

type Grant = { clientId?: string, redirectUri?: string, accountId?: number, refreshToken?: string }

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
export const signInState = (app: App): { signIn: SignInShown | null, ended: string | null } => {
  const s = bc3Of(app)
  if (s.signIn && s.signIn.expiresAt <= Date.now()) { s.signIn = null; s.ended = 'expired' }
  return { signIn: s.signIn ? { url: s.signIn.url, expiresAt: s.signIn.expiresAt } : null, ended: s.ended }
}

const refusedBy = (e?: BasecampFailure) => ({ error: e ?? ({ kind: 'refused', retryable: false } as BasecampFailure) })

/**
 * Starts a sign-in: registers the client first if none is held for this
 * redirect URI, and answers the URL the person opens. The browser comes back
 * to `landSignIn`. One at a time: a second Connect while one waits shows the
 * same URL.
 */
export async function connect (app: App): Promise<{ signIn: SignInShown } | { error: BasecampFailure }> {
  const s = bc3Of(app)
  const port = (app as unknown as { http?: { port?: number } }).http?.port
  if (!port) throw Object.assign(new Error('to-dos: this API is not listening on a port, so Basecamp has nowhere to send the browser back'), { status: 503 })
  const redirectUri = `http://127.0.0.1:${port}${TODOS_CONNECTED_PATH}`
  const waiting = signInState(app).signIn
  if (waiting && s.signIn?.redirectUri === redirectUri) return { signIn: waiting }
  const g = readGrant()
  let clientId = g.redirectUri === redirectUri ? g.clientId : undefined
  if (!clientId) {
    const r = await registerClient(bindBasecamp(app.conduit!), { clientName: 'Workbench', redirectUri })
    if (!r.clientId) return refusedBy(r.error)
    clientId = r.clientId
    // A held grant belongs to the client it was granted to, so a new client waits for its own landing.
    if (!g.refreshToken) writeGrant({ ...g, clientId, redirectUri })
  }
  const pkce = pkcePair(), state = randomBytes(16).toString('base64url')
  const url = authorizeUrl({ clientId, redirectUri, state, codeChallenge: pkce.challenge, ...(s.origins.tokenOrigin ? { authorizeOrigin: s.origins.tokenOrigin } : {}) })
  s.signIn = { url, expiresAt: Date.now() + SIGN_IN_MS, state, verifier: pkce.verifier, clientId, redirectUri }
  s.ended = null
  return { signIn: { url, expiresAt: s.signIn.expiresAt } }
}

export type Landing = { status: number, message: string }
const NOT_WAITING = 'Workbench is not waiting for a Basecamp sign-in here, so nothing was changed. Press Connect Basecamp on the Laptop screen to start again.'
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const ENDED: Record<string, string> = {
  denied: 'Basecamp sign-in was denied, so nothing was saved.',
  several_accounts: 'That Basecamp login has more than one Basecamp 3 or 4 account; Workbench takes exactly one, so nothing was saved.',
  no_account: 'That Basecamp login has no Basecamp 3 or 4 account, so nothing was saved.',
}

/**
 * The browser's return. A wrong state, or no sign-in waiting, writes nothing
 * and leaves a real sign-in waiting: the state is the whole proof, since the
 * request carries no Workbench session.
 */
export async function landSignIn (app: App, params: URLSearchParams): Promise<Landing> {
  const s = bc3Of(app)
  const expired = !!s.signIn && s.signIn.expiresAt <= Date.now()
  signInState(app)
  const p = s.signIn, state = params.get('state') ?? ''
  if (!p || !state || !same(state, p.state)) return { status: 400, message: expired ? 'That Basecamp sign-in expired, so nothing was saved. Press Connect Basecamp again.' : NOT_WAITING }
  s.signIn = null
  const ended = (why: string, status = 200): Landing => {
    s.ended = why
    return { status, message: ENDED[why] ?? `Basecamp sign-in ended (${why}), so nothing was saved.` }
  }
  const error = params.get('error')
  if (error) return ended(error === 'access_denied' ? 'denied' : 'refused')
  const code = params.get('code') ?? ''
  if (!code) return ended('refused', 400)
  const bc = bindBasecamp(app.conduit!)
  const out = await exchangeCode(bc, { clientId: p.clientId, code, redirectUri: p.redirectUri, codeVerifier: p.verifier })
  if ('ended' in out) return ended(out.ended, 400)
  if ('error' in out) return ended(kindOf(out.error), 400)
  const who = await authorization(bc, { accessToken: out.grant.accessToken, ...(s.origins.apiOrigin ? { apiOrigin: s.origins.apiOrigin } : {}) })
  if (!who.row) return ended(kindOf(who.error), 400)
  // `api` addresses one account; with several, which one to-dos go to is the owner's call and nothing here guesses.
  const bc3 = who.row.accounts.filter(a => a.product === 'bc3')
  if (bc3.length !== 1) return ended(bc3.length ? 'several_accounts' : 'no_account')
  const accountId = bc3[0].id
  if (s.account && s.account !== String(accountId)) await app.conduit!.deregister(accountTarget(app, s.account).id)
  if (s.account !== String(accountId)) await app.conduit!.register(accountTarget(app, accountId))
  writeGrant({ clientId: p.clientId, redirectUri: p.redirectUri, accountId, refreshToken: out.grant.refreshToken })
  s.resolver = null
  s.account = String(accountId)
  s.ended = null
  return { status: 200, message: `Connected to Basecamp account ${bc3[0].name}. You can close this tab and go back to Workbench.` }
}

const esc = (t: string) => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** GET TODOS_CONNECTED_PATH: no session, and no code, token or verifier in anything it answers. */
export const todosConnectedRoute = (app: App) => async (ctx: TransportContext): Promise<Response> => {
  // `ctx.query` is parsed, and a code of digits would arrive as a number.
  const out = await landSignIn(app, new URL(ctx.$raw.url).searchParams).catch((e: Error) => {
    bc3Of(app).ended = 'failed'
    console.warn(`[bc3] sign-in failed: ${e.message}`)
    return { status: 500, message: 'Basecamp sign-in failed, so nothing was saved. Press Connect Basecamp again.' }
  })
  const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Basecamp</title><body style="font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
    `<h1 style="font-size:1.25rem">Basecamp</h1><p>${esc(out.message)}</p>`
  const res = ctx.html(page, out.status)
  res.headers.set('cache-control', 'no-store')
  res.headers.set('referrer-policy', 'no-referrer')
  return res
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
