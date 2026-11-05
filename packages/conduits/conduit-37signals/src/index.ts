// @frontierjs/conduit-37signals — Basecamp over conduit (`IDEAS/conduit-37signals.md`).
//
// An app that reaches Basecamp at runtime cannot shell out to the `basecamp`
// CLI: its token is one person's, in one machine's keyring, and a shell-out
// skips `conduit.send()` and with it resilience, receipts and `translate()`.
//
// ─── The targets, from one builder ───────────────────────────────────────
// `api` is ONE ACCOUNT (C1): every path sits under `/{account}`, so the account
// is part of the address and a call names only what follows it. `person` is
// `api` spending the caller's own grant (`per_caller`, `FJS-D1182`), for a verb
// that must appear as its author rather than as the app's; which of the two a
// bundle spends is chosen once, at `bindBasecamp(…, { as })`, never per call. `token` is the
// authorization server, a second origin (`app.basecamp.com`), spent with
// `auth: none` because a refresh is a send that carries its own grant
// (`FJS-D933`). The token the CLI holds is that server's, not Launchpad's —
// Launchpad answers it 401 (0.2) — so `token` is the refresh's target (2.6).
//
// ─── The User-Agent is the target's ──────────────────────────────────────
// Basecamp answers an empty `User-Agent` `400` `text/plain`, so it rides the
// descriptor where no call can forget it, and the builder refuses without one.
// That refusal is the only guard: Bun's fetch fills an ABSENT header with
// `Bun/<version>`, which Basecamp answers 200, so a target
// that forgot it would run, as an app Basecamp cannot name or contact.
//
// ─── Nothing is keyed ────────────────────────────────────────────────────
// Basecamp names no idempotency key, in a header or a body: every create is
// unkeyed and unreplayable, and a lost answer is resolved by a read (C6):
// `findCreated`, below the writes.

import { MintError, type ConduitRequest, type ConduitResult, type CredentialCaller, type CredentialResolver, type FrameDialect, type Material, type ReceivedEvent, type TargetDescriptor } from '@frontierjs/conduit'
import { bodyOf, translate, type BasecampFailure } from './errors.ts'
import type { ChatLine, Comment, FeedEvent, FeedPage, Message, Person, Project, Recording, Todo, Todolist } from './types.ts'

export * from './types.ts'
export * from './errors.ts'

export const BASECAMP_API_TARGET   = 'provider:37signals:api'
export const BASECAMP_PERSON_TARGET = 'provider:37signals:person'
export const BASECAMP_TOKEN_TARGET = 'provider:37signals:token'
export const BASECAMP_STREAM_TARGET = 'broker:37signals'
export const BASECAMP_API_ORIGIN   = 'https://3.basecampapi.com'
export const BASECAMP_TOKEN_ORIGIN = 'https://app.basecamp.com'
/** The token endpoint's path on `token`, from `app.basecamp.com`'s authorization-server metadata. */
export const BASECAMP_TOKEN_PATH   = '/oauth/tokens'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>

/** Whose credential the account's API spends: the process's (`api`) or the caller's own grant (`person`). */
export type BasecampAs = 'api' | 'person'

/**
 * One Send per role. Every call takes this and picks its own: a read or a
 * write goes through `api`, a refresh through `token`. `api` spends whichever
 * credential the bind chose, so a call never decides whose token it spends.
 */
export interface BasecampSend { api: Send; token: Send; as: BasecampAs }

export interface BindOptions {
  /** `person` binds `api` to the per-caller target, so every call appears as its author. */
  as?:  BasecampAs
  /** Whose grant `person` spends. Under junction the plugin fills it off the call; a drive states it. */
  who?: CredentialCaller
}

type Bindable = { api: { id: string }; person: { id: string }; token: { id: string } }
const DEFAULT_IDS: Bindable = { api: { id: BASECAMP_API_TARGET }, person: { id: BASECAMP_PERSON_TARGET }, token: { id: BASECAMP_TOKEN_TARGET } }

export function bindBasecamp(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, targets: BasecampTargets | Bindable = DEFAULT_IDS, opts: BindOptions = {}): BasecampSend {
  const as = opts.as ?? 'api'
  const account = as === 'person' ? targets.person.id : targets.api.id
  const who = opts.who ? { who: opts.who } : {}
  return {
    api:   req => conduit.send({ target: account, ...who, ...req }),
    token: req => conduit.send({ target: targets.token.id, ...req }),
    as,
  }
}

export interface BasecampTargets { api: TargetDescriptor; person: TargetDescriptor; token: TargetDescriptor; stream: TargetDescriptor }

/**
 * `userAgent` names the app and how to reach whoever runs it — Basecamp asks
 * for `My App (https://example.com/myapp)`. The origins are overridable for a
 * sink; a real deployment moves neither.
 */
export function basecampTargets(opts: { accountId: string | number; userAgent: string; ref?: string; apiOrigin?: string; tokenOrigin?: string }): BasecampTargets {
  const account = String(opts.accountId ?? '')
  if (!/^\d+$/.test(account)) throw new TypeError('37signals: accountId is the number in 3.basecampapi.com/<accountId>, from authorization.json\'s accounts')
  if (!opts.userAgent?.trim()) throw new TypeError('37signals: userAgent is required — Basecamp answers a request without one 400; name the app and a contact, "My App (https://example.com/myapp)"')
  const headers = { 'user-agent': opts.userAgent }
  const common = { kind: 'provider' as const, protocol: 'http' as const, headers, registered_at: Date.now(), last_seen_at: null }
  const api: TargetDescriptor = {
    ...common, id: BASECAMP_API_TARGET,
    address: `${(opts.apiOrigin ?? BASECAMP_API_ORIGIN).replace(/\/+$/, '')}/${account}`,
    auth: { type: 'bearer', ref: opts.ref ?? 'BASECAMP_TOKEN' },
  }
  return {
    api,
    person: { ...api, id: BASECAMP_PERSON_TARGET, auth: { type: 'bearer', ref: 'BASECAMP_PERSON_TOKEN', per_caller: true } },
    token: {
      ...common, id: BASECAMP_TOKEN_TARGET,
      address: (opts.tokenOrigin ?? BASECAMP_TOKEN_ORIGIN).replace(/\/+$/, ''),
      auth: { type: 'none' }, encoding: 'form',
    },
    // No address and no credential: `basecampStreamDialect`'s dial mints both,
    // the ticket in the URL, through `api` (3.4).
    stream: {
      id: BASECAMP_STREAM_TARGET, kind: 'broker', protocol: 'websocket', address: '',
      auth: { type: 'none' }, registered_at: Date.now(), last_seen_at: null,
    },
  }
}

// ─── The token (2.6) ──────────────────────────────────────────────────────
// `api`'s bearer lives an hour, so a refresh is routine. The resolver below is
// the mint and nothing else: wrapped in `withCache({ ttl_ms: Infinity })` it
// is held until Basecamp's own `expires_in` (`FJS-D1075`), two sends that find
// it expired share one refresh, and a `401` from `api` forgets it and replays
// once on a fresh one. A lock across processes is the app's, on its own row.
//
// A refused refresh is `MintError`, so the `api` send is `auth_failed` with
// the token endpoint's `retryable`: an `invalid_grant` is permanent and
// `onLost` tells the app to stop answering the grant, and an outage there is
// worth sending again later. Never a loop.

/** The person's grant, as the app holds it on their row (`FJS-D1126`); `conduit-oidc`'s spelling. */
export interface GrantStore {
  /** The refresh token for this grant; null means none, and the send fails closed. */
  refreshTokenFor(ref: string): Promise<string | null> | string | null
  /** Basecamp answered a new refresh token: `next` replaces `previous` on the app's row. */
  onRotated?(ref: string, next: string, previous: string): Promise<void> | void
  /** `invalid_grant`: the grant is dead, and the person connects Basecamp again. */
  onLost?(ref: string, failure: BasecampFailure): Promise<void> | void
}

/**
 * The refresh goes through the bundle's `token`. `clientId` is the OAuth client the
 * grant was issued to; `app.basecamp.com` offers `none` as a client's auth, so
 * a public client sends its id in the form and no secret.
 *
 * `grants` is the process's grant, which `api` spends; `grantsFor(who)` is the
 * caller's, which `person` spends, read off their row. A store per caller
 * rather than a `who` argument on `grants`: a store that ignored the argument
 * would answer one person's grant for everyone, and conduit refuses a
 * `per_caller` target only where the resolver has no `getFor`.
 */
export function basecampTokenResolver(bc: BasecampSend, opts: { clientId: string; grants?: GrantStore; grantsFor?: (who: CredentialCaller) => GrantStore }): CredentialResolver {
  if (!opts.clientId) throw new TypeError('37signals: clientId is required — the OAuth client the refresh token was issued to')
  if (!opts.grants && !opts.grantsFor) throw new TypeError('37signals: a token resolver needs grants (the app\'s, for api), grantsFor (each caller\'s, for person), or both')
  const mint = async (grants: GrantStore, ref: string): Promise<Material | null> => {
    const current = await grants.refreshTokenFor(ref)
    if (!current) return null
    // Unreplayable: if Basecamp rotates, a lost answer already burned
    // `current`, and resending it is an `invalid_grant` for a live grant.
    const r = await bc.token<{ access_token?: string; expires_in?: number; refresh_token?: string }>({
      method: 'POST', path: BASECAMP_TOKEN_PATH,
      body: { grant_type: 'refresh_token', refresh_token: current, client_id: opts.clientId },
    })
    if (r.error) {
      if (bodyOf(r.error.raw)?.error === 'invalid_grant') await grants.onLost?.(ref, { ...failure(r), code: 'invalid_grant' })
      throw new MintError(r.error)
    }
    const t = r.data
    if (!t?.access_token) throw new TypeError('37signals: the token endpoint answered no access_token')
    // Handed over before the token is answered: a caller that crashes with
    // the access token must not leave the app holding a burned refresh token.
    if (t.refresh_token && t.refresh_token !== current) await grants.onRotated?.(ref, t.refresh_token, current)
    return typeof t.expires_in === 'number' ? { value: t.access_token, expires_at: Date.now() + t.expires_in * 1000 } : t.access_token
  }
  const { grants, grantsFor } = opts
  return {
    get: ref => grants ? mint(grants, ref) : Promise.resolve(null),
    ...(grantsFor ? { getFor: (ref: string, who: CredentialCaller) => mint(grantsFor(who), ref) } : {}),
  }
}

// ─── Reads, every one replayable ─────────────────────────────────────────
// `etag` in, `unchanged: true` out — S3's spelling — and the cached body stays
// the app's (C12). A tag is sent exactly as Basecamp gave it: every one is weak
// (`W/"…"`), and the same tag without its `W/` answers 200 (0.3).

export type Read<T> = { row?: T; etag?: string; unchanged?: true; error?: BasecampFailure }
export type Walked<T> = { rows?: T[]; etags?: string[]; unchanged?: true; error?: BasecampFailure }

const READ = { method: 'GET', replayable: true } as const
/** Where a read goes — a path under the account, or a URL Basecamp handed back. */
type Where = Omit<ConduitRequest, 'target' | 'method'>
const conditional = (etag?: string) => (etag ? { headers: { 'if-none-match': etag } } : {})
const failure = (r: ConduitResult<unknown>) => translate(r.error!, r.meta.status, r.meta.headers)
const malformed = (what: string): BasecampFailure => ({ kind: 'invalid_response', message: `Basecamp answered something that is not ${what}`, retryable: false })

/** A URL Basecamp handed back — a `Link`, a body's `url` — sent whole, never rebuilt: it already carries the account, and the docs forbid building one. Conduit refuses it unless it is the target's own origin. */
const at = (url: string): Where => ({ address: url, path: '' })

/** `rel="next"` from a `Link` header, or nothing. */
export function nextLink(link: string | undefined): string | undefined {
  return link?.split(',').map(part => part.match(/<([^>]+)>\s*;\s*rel="?next"?/)).find(Boolean)?.[1]
}

async function readOne<T>(send: Send, req: Where, etag: string | undefined, what: string): Promise<Read<T>> {
  const r = await send<T>({ ...READ, ...req, ...conditional(etag) })
  if (r.error) return { error: failure(r) }
  const tag = r.meta.headers?.etag
  if (r.meta.status === 304) return { unchanged: true, ...(tag ? { etag: tag } : {}) }
  if (!r.data || typeof r.data !== 'object' || Array.isArray(r.data)) return { error: malformed(what) }
  return { row: r.data, ...(tag ? { etag: tag } : {}) }
}

/**
 * Every page of a list, by `Link rel="next"`. It stops on an EMPTY page or a
 * missing `Link`: `projects.json` sends `rel="next"` past its last page,
 * forever (0.3), so a walk that waited for the header to go never ends.
 *
 * `etags` are a previous walk's, one per page. One tag cannot stand for the
 * list: a renamed project on page 3 leaves page 1's tag alone. So every page is
 * asked conditionally, and only every page answering `304` is `unchanged`; the
 * first that does not restarts the walk plainly, because a `304` page has no
 * body to keep.
 */
export async function walk<T>(bc: BasecampSend, path: string, opts: { etags?: string[] } = {}): Promise<Walked<T>> {
  if (opts.etags?.length) {
    let req: Where = { path }
    for (const [i, etag] of opts.etags.entries()) {
      const r = await bc.api<T[]>({ ...READ, ...req, ...conditional(etag) })
      if (r.error) return { error: failure(r) }
      if (r.meta.status !== 304) break
      if (i === opts.etags.length - 1) return { unchanged: true, etags: opts.etags }
      const next = nextLink(r.meta.headers?.link)
      if (!next) break
      req = at(next)
    }
  }
  const rows: T[] = [], etags: string[] = []
  for await (const page of pages<T>(bc.api, path)) {
    if ('error' in page) return { error: page.error }
    rows.push(...page.rows)
    etags.push(page.etag)
  }
  return { rows, etags }
}

/** One page at a time, for a reader that can stop early; `walk` is every page. A `Link` that returns to a page already read is `invalid_response`. */
async function* pages<T>(send: Send, path: string): AsyncGenerator<{ rows: T[]; etag: string } | { error: BasecampFailure }> {
  const seen = new Set<string>()
  let req: Where = { path }
  for (;;) {
    const r = await send<T[]>({ ...READ, ...req })
    if (r.error) { yield { error: failure(r) }; return }
    if (!Array.isArray(r.data)) { yield { error: malformed('a page of a list') }; return }
    yield { rows: r.data, etag: r.meta.headers?.etag ?? '' }
    const next = nextLink(r.meta.headers?.link)
    if (!r.data.length || !next) return
    if (seen.has(next)) { yield { error: malformed(`a list: its Link returns to ${next}`) }; return }
    seen.add(next)
    req = at(next)
  }
}

/** Whose token `bc.api` spends: the process's, or the caller's under `as: 'person'`. */
export function me(bc: BasecampSend, opts: { etag?: string } = {}): Promise<Read<Person>> {
  return readOne(bc.api, { path: '/my/profile.json' }, opts.etag, 'a person')
}

/** The active projects this principal can see, newest first. */
export function projects(bc: BasecampSend, opts: { etags?: string[] } = {}): Promise<Walked<Project>> {
  return walk(bc, '/projects.json', opts)
}

export function project(bc: BasecampSend, id: number, opts: { etag?: string } = {}): Promise<Read<Project>> {
  return readOne(bc.api, { path: `/projects/${idOf(id, 'project')}.json` }, opts.etag, 'a project')
}

/** The typed read for each recording this connector names. */
export const RECORDING_PATHS = { Todo: 'todos', Todolist: 'todolists', Message: 'messages', Comment: 'comments' } as const
export type RecordingType = keyof typeof RECORDING_PATHS
type Typed = { Todo: Todo; Todolist: Todolist; Message: Message; Comment: Comment }

/**
 * One recording, whole. `buckets/{b}/recordings/{id}.json` answers only the
 * envelope every recording shares — no `completed`, `content`, `description`,
 * `assignees` — and its `url` is the typed read (measured 2026-10-16). With
 * `type` this is that typed read, one request; without, it is the envelope
 * and then its `url`, two, which is how a recording no event names the type
 * of (a boost's, a chat line's) is read. `etag` rides the typed read.
 */
export async function recording<K extends RecordingType>(bc: BasecampSend, bucket: number, id: number, opts: { type: K; etag?: string }): Promise<Read<Typed[K]>>
export async function recording(bc: BasecampSend, bucket: number, id: number, opts?: { etag?: string }): Promise<Read<Recording>>
export async function recording(bc: BasecampSend, bucket: number, id: number, opts: { type?: RecordingType; etag?: string } = {}): Promise<Read<Recording>> {
  const b = idOf(bucket, 'bucket'), r = idOf(id, 'recording')
  if (opts.type) {
    if (!Object.hasOwn(RECORDING_PATHS, opts.type)) throw new TypeError(`37signals: recording type '${opts.type}' is not one of ${Object.keys(RECORDING_PATHS).join(', ')}; omit it to read any recording through its envelope`)
    return readOne(bc.api, { path: `/buckets/${b}/${RECORDING_PATHS[opts.type]}/${r}.json` }, opts.etag, `a ${opts.type}`)
  }
  const envelope = await readOne<Recording>(bc.api, { path: `/buckets/${b}/recordings/${r}.json` }, undefined, 'a recording')
  if (!envelope.row) return envelope
  if (typeof envelope.row.url !== 'string') return { error: malformed('a recording with a url') }
  return readOne(bc.api, at(envelope.row.url), opts.etag, 'a recording')
}

/**
 * A project's to-do lists. Its to-dos live in the dock's `todoset` that is
 * `enabled` — a project can carry a second, disabled one (0.4) — and a project
 * with the To-dos tool off has none, which answers `rows: []`.
 */
export function todolists(bc: BasecampSend, project: Pick<Project, 'id' | 'dock'>, opts: { etags?: string[] } = {}): Promise<Walked<Todolist>> {
  const set = project.dock.find(d => d.name === 'todoset' && d.enabled)
  if (!set) return Promise.resolve({ rows: [], etags: [] })
  return walk(bc, `/buckets/${idOf(project.id, 'project')}/todosets/${idOf(set.id, 'todoset')}/todolists.json`, opts)
}

// ─── The feed (3.1) ──────────────────────────────────────────────────────
// `events.json` is one cursor over the whole account: thin pointers, oldest
// first, up to 100 a page. An event names a recording and is never the
// recording, so nothing acts on one before re-reading what it points at (3.3);
// and the feed is "not guaranteed delivery", so the scope walk is the floor
// (0.4). A poll is ONE page because the caller persists `position` only after
// each event on that page is applied or queued under its own id (`FJS-D1354`):
// a position stored first loses the page on a crash.
//
// No `exclude_performers=self`. Under Jordan's token `self` is Jordan, and it
// would drop Jordan's own activity (`FJS-D1182`, amended); an echo of the
// app's own write is a no-op once 3.3 applies the recording's current state.

/**
 * The types this connector reads, 0.4's nouns, sent when a poll names none.
 * With no `types` the feed serves its whole catalog, which grows under a held
 * position on the deploy that adds a type. Changing this list changes the
 * filter set, so every held position answers `filters_changed` once.
 */
export const FEED_TYPES = [
  'todo.created', 'todo.completed', 'todo.moved', 'todo.content_changed', 'todo.description_changed',
  'todo.scheduled', 'todo.rescheduled', 'todo.unscheduled', 'todo.assignment_changed',
  'message.created', 'message.content_changed', 'message.subject_changed',
  'comment.created', 'comment.content_changed',
  'chat.line.created', 'boost.created',
] as const

/**
 * Where a poll starts — exactly one. `since` ENTERS the feed after an event
 * id, at `0` for everything served back to the epoch, or at `'now'`; it is how
 * a refused cursor comes back in, from the last event applied. `position`
 * resumes from a page's durable token. `url` follows one the feed handed back,
 * a page's `next` or `before_epoch`'s `resume`, whole: it already carries the
 * filters it was minted with, so `types` and `buckets` are not added to it.
 */
export type FeedFrom =
  | { since: number | 'now'; position?: never; url?: never }
  | { position: string; since?: never; url?: never }
  | { url: string; since?: never; position?: never }
export type FeedFilters = { types?: readonly string[]; buckets?: number[] }
export type Polled = Partial<FeedPage> & { error?: BasecampFailure }

const FEED_TYPE = /^[a-z_]+(\.[a-z_]+)+$/

/**
 * One page of the feed. Follow `next` with `{ url: next }` until it is absent,
 * queuing each event under `eventJobId(event)` and then storing the page's `position`; poll again later from
 * that position. A refused cursor is `refused` with a `code` that says how to
 * re-enter: `invalid_position` and `filters_changed` by `since` (the last
 * event applied), `before_epoch` by its `resume`. `invalid_filter` is the
 * filters, which no cursor fixes.
 */
export async function pollEvents(bc: BasecampSend, from: FeedFrom & FeedFilters): Promise<Polled> {
  const given = (['since', 'position', 'url'] as const).filter(k => from[k] !== undefined)
  if (given.length !== 1) throw new TypeError(`37signals: a poll starts from exactly one of since, position or url, got ${given.join(' and ') || 'none'} — enter with { since: 'now' } or { since: 0 }`)
  const page = await bc.api<FeedPage>({ ...READ, ...feedRequest(from) })
  if (page.error) return { error: failure(page) }
  const d = page.data
  if (!d || !Array.isArray(d.events) || typeof d.position !== 'string') return { error: malformed('a page of the event feed') }
  return { events: d.events, position: d.position, ...(typeof d.next === 'string' ? { next: d.next } : {}) }
}

function feedRequest(from: FeedFrom & FeedFilters): Where {
  if (from.url !== undefined) {
    if (typeof from.url !== 'string' || !from.url) throw new TypeError('37signals: url is one the feed handed back, a page\'s next or a refusal\'s resume')
    return at(from.url)
  }
  const query = feedFilters(from)
  if (from.position !== undefined) {
    if (typeof from.position !== 'string' || !from.position) throw new TypeError('37signals: position is the token a page answered')
    query.position = from.position
  } else if (from.since === 'now' || (Number.isSafeInteger(from.since) && (from.since as number) >= 0)) {
    query.since = String(from.since)
  } else {
    throw new TypeError(`37signals: since is an event id, 0 or 'now' — never a time; got ${String(from.since)}`)
  }
  return { path: '/events.json', query }
}

/** The filters as the feed reads them, a poll's query and a subscription's identifier alike. */
function feedFilters(f: FeedFilters): Record<string, string> {
  const types = f.types ?? FEED_TYPES
  if (!types.length || !types.every(t => typeof t === 'string' && FEED_TYPE.test(t))) throw new TypeError(`37signals: types are the feed's event types, such as 'todo.created', and at least one — omit types for FEED_TYPES`)
  if (f.buckets && f.buckets.length > 100) throw new TypeError(`37signals: the feed takes at most 100 buckets, got ${f.buckets.length}`)
  const out: Record<string, string> = { types: types.join(',') }
  if (f.buckets?.length) out.buckets = f.buckets.map(b => idOf(b, 'bucket')).join(',')
  return out
}

/**
 * The id the poll job dispatches an event under (`FJS-D1354`). It is a
 * function of the event alone, so a replayed page names the jobs it already
 * queued and caravan's primary key makes each dispatch a no-op.
 */
export function eventJobId(event: Pick<FeedEvent, 'id'>): string {
  return `37signals:event:${idOf(event.id, 'event')}`
}

// ─── The re-read (3.3) ───────────────────────────────────────────────────
// The apply job's first request. An event is a pointer that may be minutes
// old by the time its job runs, so what is applied is the recording as it is
// NOW, and an echo of the app's own write applies the state it already holds.
// `gone` is the job's drop: deleted or never visible, nothing to apply, and a
// retry asks the same question again. Every other failure is the job's to retry.

/**
 * The recording an event points at, read now. `todo.*`, `message.*` and
 * `comment.*` name their type, so the typed read is one request; any other
 * (a chat line, a boost, whose `recording_id` is the BOOSTED recording) is
 * read through its envelope, two. A `200` with `status: trashed` is a row,
 * not `gone` (unmeasured, 2.5).
 */
export async function reread(bc: BasecampSend, event: Pick<FeedEvent, 'event_type' | 'bucket_id' | 'recording_id'>): Promise<Read<Recording>> {
  if (typeof event?.event_type !== 'string' || !FEED_TYPE.test(event.event_type)) throw new TypeError('37signals: reread takes an event as the feed answered it, with its event_type')
  const noun = event.event_type.split('.')[0]
  const type = (Object.keys(RECORDING_PATHS) as RecordingType[]).find(k => k.toLowerCase() === noun)
  return type
    ? recording(bc, event.bucket_id, event.recording_id, { type }) as Promise<Read<Recording>>
    : recording(bc, event.bucket_id, event.recording_id)
}

// ─── The live stream (3.4) ───────────────────────────────────────────────
// A pointer sooner, never a cursor: "live event ids never advance your durable
// position". A poll serves an event only once it is about 30 s old, so a frame
// that merely woke the poll would find nothing new. The app dispatches the
// frame's event under the `eventJobId` the poll will name it by about 30 s
// later, caravan runs it once whichever lane came first, and the poll alone
// stores `position` and repairs a frame the socket dropped.
//
// The URL is minted, never built: `POST /events/stream_ticket.json` answers it
// whole, host and ticket, and a ticket lives about two minutes, so `dial` mints
// one per connection. The ticket is the credential, so the target has none.
//
// ActionCable: `welcome` on open, ONE `subscribe` to `EventsChannel` with the
// poll's filters, then `confirm_subscription`, because an open socket is not a
// subscribed one. `reject_subscription` (the filters) and `disconnect` (a
// malformed command) are thrown from the handshake and conduit redials them,
// a mint per backoff step; the filters are checked before the first dial, so
// that loop is Basecamp's catalog moving, not a typo. The server pings every
// 3 s and takes no ping back (an unknown command closes the socket for good),
// so the keepalive only listens.

/** One frame of the stream: the feed's pointer, plus `actor_type` and `visible_to_clients`, which only a live frame carries. */
export type StreamEvent = ReceivedEvent & { type: 'event'; payload: FeedEvent & { actor_type?: string; visible_to_clients?: boolean } }

const readJson = (raw: string): Record<string, any> | null => {
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : null } catch { return null }
}

/**
 * The stream on `BASECAMP_STREAM_TARGET`, for `app.conduit.receive({ target,
 * dialect })`. `bc.api` mints each dial's ticket, so the bundle must be bound
 * `as: 'api'`: a dial runs outside any call, and a `person` send there has no
 * caller whose grant it could spend. `filters` are the poll's, `FEED_TYPES`
 * when it names none.
 */
export function basecampStreamDialect(bc: BasecampSend, filters: FeedFilters = {}): FrameDialect<StreamEvent> {
  if (bc.as !== 'api') throw new TypeError('37signals: the stream mints its ticket on the process token; bind it with bindBasecamp(conduit, targets, { as: \'api\' })')
  const identifier = JSON.stringify({ channel: 'EventsChannel', ...feedFilters(filters) })
  return {
    framing: {
      async dial() {
        const r = await bc.api<{ ticket?: unknown; url?: unknown }>({ method: 'POST', path: '/events/stream_ticket.json', replayable: true })
        if (r.error) { const f = failure(r); throw new Error(`37signals: the stream ticket was refused, ${f.kind}: ${f.message}`) }
        if (typeof r.data?.url !== 'string') throw new Error('37signals: the stream ticket answered no url')
        return r.data.url
      },
      async handshake(link) {
        await link.next(raw => readJson(raw)?.type === 'welcome')
        link.send(JSON.stringify({ command: 'subscribe', identifier }))
        const f = readJson(await link.next(raw => ['confirm_subscription', 'reject_subscription', 'disconnect'].includes(readJson(raw)?.type)))!
        if (f.type !== 'confirm_subscription') throw new Error(`37signals: the stream refused the subscription, ${f.type}${f.reason ? ` (${f.reason})` : ''}`)
      },
      decode(raw) {
        const e = readJson(raw)?.message
        if (!e || typeof e !== 'object' || !Number.isSafeInteger(e.id) || e.id <= 0 || typeof e.event_type !== 'string') return null
        return { id: String(e.id), body: e }
      },
      keepalive: { beat: raw => readJson(raw)?.type === 'ping', dead_ms: 9_000 },
    },
    parse: (m) => ({ id: m.id, type: 'event', payload: m.body as StreamEvent['payload'] }),
    dedupeKey: (m) => eventJobId({ id: Number(m.id) }),
  }
}

// ─── Writes ──────────────────────────────────────────────────────────────
// Every create is unkeyed and unreplayable: Basecamp names no idempotency key,
// so conduit sends it once and a lost answer is `indeterminate`. Each create
// returns its `attempt` on every outcome, and `findCreated(bc, attempt)` is
// the read that says whether it landed (C6). That read is the parent's own
// list, not the event feed: a poll serves only events older than about 30 s
// and the feed is "not guaranteed delivery", where the list is the record.

/**
 * Rich text is HTML that Basecamp parses, so a body says which it is: `text`
 * is the caller's words, escaped here with each line break a `<br>`
 * (`rich_text.md`), and `html` is markup the caller built. A bare string is
 * refused rather than guessed at: its `<` would be a tag.
 */
export type RichText = { text: string; html?: never } | { html: string; text?: never }

export type CreatedType = 'Todo' | 'Message' | 'Comment' | 'ChatLine'
type CreatedRow = { Todo: Todo; Message: Message; Comment: Comment; ChatLine: ChatLine }

/** What a create sent, enough for `findCreated` to find it: where, when, and the field it matches on as plain text. */
export interface Attempt<K extends CreatedType = CreatedType> {
  type:      K
  bucket:    number
  parent:    number
  startedAt: string
  match:     string
}
export type Created<K extends CreatedType> = { row?: CreatedRow[K]; attempt: Attempt<K>; error?: BasecampFailure }

/**
 * Where each create goes, under its bucket and parent. It is the path the
 * create POSTs to and the list `findCreated` reads, one path for both. `newest`
 * is the list's order (measured 2026-10-16 for lines and comments; messages
 * are the docs' `created_at desc` default; to-dos are in position order), so a
 * newest-first read stops at the first page that reaches before the attempt.
 */
const CREATES: { [K in CreatedType]: { path: (b: number, p: number) => string; field: keyof CreatedRow[K] & string; rich: boolean; newest: boolean; parent: string } } = {
  Todo:     { path: (b, p) => `/buckets/${b}/todolists/${p}/todos.json`,         field: 'content', rich: false, newest: false, parent: 'todolist' },
  Message:  { path: (b, p) => `/buckets/${b}/message_boards/${p}/messages.json`, field: 'subject', rich: false, newest: true,  parent: 'message board' },
  Comment:  { path: (b, p) => `/buckets/${b}/recordings/${p}/comments.json`,     field: 'content', rich: true,  newest: false, parent: 'recording' },
  ChatLine: { path: (b, p) => `/buckets/${b}/chats/${p}/lines.json`,             field: 'content', rich: true,  newest: true,  parent: 'chat' },
}

/** How far this machine's clock may run ahead of Basecamp's `created_at` and a lost create still be found. */
const CLOCK_SKEW_MS = 120_000

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
/** Text as a match compares it: a line break and a run of spaces are one space, because Basecamp's `<div>` and `<br>` are not the writer's words. */
const words = (s: string) => s.replace(/\s+/g, ' ').trim()
/**
 * Rich text reduced to what Basecamp keeps of it: it wraps a body in `<div>`
 * and drops tags it does not allow, so a match compares text, never markup.
 * Tags go BEFORE entities are decoded, not after as `rich_text.md` orders it,
 * because an escaped `&lt;x&gt;` is the writer's text and decoding first would
 * strip it as a tag.
 */
function plain(html: string): string {
  return words(html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e: string) =>
      e[0] !== '#' ? ENTITIES[e.toLowerCase()] ?? m : String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))))
}

/** The HTML a body sends, and the text `findCreated` will match it by. */
function richText(body: RichText | undefined, what: string): { html: string; text: string } {
  const text = body?.text, html = body?.html
  if ((typeof text === 'string') === (typeof html === 'string')) throw new TypeError(`37signals: ${what} is rich text — pass { text } for words, which are escaped, or { html } for markup, exactly one`)
  if (typeof html === 'string') return { html, text: plain(html) }
  return { html: text!.replace(/[&<>"']/g, c => ESCAPES[c]).replace(/\r?\n/g, '<br>'), text: words(text!) }
}

/** `match` is the text a reader sees: a plain field's words, or a rich field's `richText().text`. */
async function create<K extends CreatedType>(send: Send, type: K, bucket: number, parent: number, body: Record<string, unknown>, match: string): Promise<Created<K>> {
  const how = CREATES[type]
  const b = idOf(bucket, 'bucket'), p = idOf(parent, how.parent)
  const attempt: Attempt<K> = { type, bucket: b, parent: p, startedAt: new Date().toISOString(), match: words(match) }
  const r = await send<CreatedRow[K]>({ method: 'POST', path: how.path(b, p), body })
  if (r.error) return { attempt, error: failure(r) }
  if (!r.data || typeof r.data !== 'object' || Array.isArray(r.data)) return { attempt, error: malformed(`a created ${type}`) }
  return { row: r.data, attempt }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
function dateOf(d: string | undefined, what: string): string | undefined {
  if (d !== undefined && !DATE.test(d)) throw new TypeError(`37signals: ${what} is a date, YYYY-MM-DD, got '${d}'`)
  return d
}

export interface NewTodo {
  bucket:       number
  todolist:     number
  /** The to-do's name: plain text, not rich text. */
  content:      string
  description?: RichText
  assigneeIds?: number[]
  dueOn?:       string
  startsOn?:    string
  /** Tell the assignees they were assigned. */
  notify?:      boolean
}

/** `POST buckets/{b}/todolists/{l}/todos.json`, `201` with the to-do. */
export async function createTodo(bc: BasecampSend, todo: NewTodo): Promise<Created<'Todo'>> {
  if (!todo.content?.trim()) throw new TypeError('37signals: a to-do needs content, its name')
  const dueOn = dateOf(todo.dueOn, 'dueOn'), startsOn = dateOf(todo.startsOn, 'startsOn')
  return create(bc.api, 'Todo', todo.bucket, todo.todolist, {
    content: todo.content,
    ...(todo.description ? { description: richText(todo.description, 'a to-do\'s description').html } : {}),
    ...(todo.assigneeIds ? { assignee_ids: todo.assigneeIds.map(id => idOf(id, 'person')) } : {}),
    ...(dueOn ? { due_on: dueOn } : {}),
    ...(startsOn ? { starts_on: startsOn } : {}),
    ...(todo.notify ? { notify: true } : {}),
  }, todo.content)
}

/**
 * `POST` the to-do's `completion_url`, whole: it has no bucket in it (0.4), so
 * it is followed as `walk()` follows a `Link`. `204`. A completion is a state,
 * so it is replayable and a lost answer is resent, where every create is not.
 */
export async function completeTodo(bc: BasecampSend, todo: Pick<Todo, 'completion_url'>): Promise<{ ok?: true; error?: BasecampFailure }> {
  if (typeof todo.completion_url !== 'string') throw new TypeError('37signals: completeTodo takes the to-do as Basecamp answered it, with its completion_url')
  const r = await bc.api<null>({ method: 'POST', replayable: true, ...at(todo.completion_url) })
  return r.error ? { error: failure(r) } : { ok: true }
}

export interface NewMessage { bucket: number; board: number; subject: string; content?: RichText; categoryId?: number }

/**
 * `POST buckets/{b}/message_boards/{m}/messages.json` with `status: active`:
 * without it Basecamp makes a DRAFT, which nobody is told about and no list
 * of the board shows.
 */
export async function postMessage(bc: BasecampSend, msg: NewMessage): Promise<Created<'Message'>> {
  if (!msg.subject?.trim()) throw new TypeError('37signals: a message needs a subject')
  return create(bc.api, 'Message', msg.bucket, msg.board, {
    subject: msg.subject, status: 'active',
    ...(msg.content ? { content: richText(msg.content, 'a message\'s content').html } : {}),
    ...(msg.categoryId !== undefined ? { category_id: idOf(msg.categoryId, 'message type') } : {}),
  }, msg.subject)
}

/** `POST buckets/{b}/recordings/{id}/comments.json` — a comment on any recording: a to-do, a message, a document. */
export async function comment(bc: BasecampSend, c: { bucket: number; recording: number; content: RichText }): Promise<Created<'Comment'>> {
  const body = richText(c.content, 'a comment')
  if (!body.text) throw new TypeError('37signals: a comment needs content')
  return create(bc.api, 'Comment', c.bucket, c.recording, { content: body.html }, body.text)
}

/**
 * `POST buckets/{b}/chats/{c}/lines.json` with `content_type: text/html`, so a
 * line is rich text like a comment's and is matched the same way. Without it
 * Basecamp makes a plain-text line, whose stored form no read has measured;
 * every line in the account's feed is `Chat::Lines::RichText` (0.2).
 */
export async function chatLine(bc: BasecampSend, line: { bucket: number; chat: number; content: RichText }): Promise<Created<'ChatLine'>> {
  const body = richText(line.content, 'a chat line')
  if (!body.text) throw new TypeError('37signals: a chat line needs content')
  return create(bc.api, 'ChatLine', line.bucket, line.chat, { content: body.html, content_type: 'text/html' }, body.text)
}

/**
 * The C6 read: did a create whose answer was lost land? It reads the parent's
 * list for rows this principal created since the attempt began whose text is
 * the attempt's. `[]` means it did not land, and the caller may create again;
 * more than one means the same person wrote the same thing twice in that
 * window, and the newest is the likeliest.
 *
 * A match, not a key: Basecamp stores none, so two identical comments from the
 * same person a minute apart are indistinguishable here. A to-do completed
 * since the attempt has left its list's default read and is not found.
 */
export async function findCreated<K extends CreatedType>(bc: BasecampSend, attempt: Attempt<K>): Promise<{ found?: CreatedRow[K][]; error?: BasecampFailure }> {
  const how = CREATES[attempt.type]
  if (!how) throw new TypeError(`37signals: findCreated reads a create's attempt, and '${String(attempt.type)}' is not one of ${Object.keys(CREATES).join(', ')}`)
  const who = await me(bc)
  if (!who.row) return { error: who.error ?? malformed('a person') }
  const since = Date.parse(attempt.startedAt) - CLOCK_SKEW_MS
  const found: CreatedRow[K][] = []
  for await (const page of pages<CreatedRow[K]>(bc.api, how.path(idOf(attempt.bucket, 'bucket'), idOf(attempt.parent, how.parent)))) {
    if ('error' in page) return { error: page.error }
    for (const row of page.rows) {
      const text = row[how.field as keyof CreatedRow[K]]
      if (row.creator?.id === who.row.id && Date.parse(row.created_at) >= since && typeof text === 'string' && (how.rich ? plain(text) : words(text)) === attempt.match) found.push(row)
    }
    if (how.newest && page.rows.some(r => Date.parse(r.created_at) < since)) break
  }
  return { found }
}

function idOf(id: number, what: string): number {
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError(`37signals: a ${what} id is a positive integer, got ${String(id)}`)
  return id
}
