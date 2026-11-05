// @frontierjs/conduit-mattermost — Mattermost over conduit.
//
// The connector of the first mirror app (`IDEAS/mirror-apps.md`): the nouns a
// chat surface lists land in the app's own litestone under `@@mirror`, and the
// verbs that act once go through here. Mattermost is SELF-HOSTED, so there is
// no default address — the builder refuses without one.
//
// One builder, one bind, one bundle (CONTRACT C1 — the bundle): the service
// token, for what no person's view holds, and a per-user bearer, `per_caller`,
// that a human's verb spends — a message is posted as its author, or not at all
// (rule 3). Which of the two a call spends is chosen once, at bind (`as`), and
// every verb takes the bundle and picks its role, so no call can be handed the
// wrong target. The resolver's `getFor(ref, who)` reads the user's own token off
// the app's `@encrypted` column (`FJS-D1126`); conduit never holds it.
//
// Nothing is keyed under a header: Mattermost honors no `Idempotency-Key`. A
// post is collapsed only under the body's `pending_post_id`, which is the
// CALLER's key and the one case a write here is `replayable`. Team Edition
// self-hosted states no history cap and no user cap, so `missingSince` on a
// mirrored row means Mattermost deleted it, never that it aged out.

import type { ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import { translate, type MattermostFailure } from './errors.ts'
import { channelModel, channelMemberModel, fileInfoModel, MATTERMOST_TARGET, MATTERMOST_UPLOAD_TARGET, MATTERMOST_USER_TARGET, postModel, reactionModel, teamModel, threadModel, profileModel, type ChannelMemberRow, type ChannelRow, type FileInfoRow, type PostRow, type ReactionRow, type TeamRow, type ThreadRow, type ProfileRow } from './mirror.ts'
import type { Channel, ChannelMember, FileInfo, MattermostId, NewPost, Post, PostList, Reaction, Team, User, UserThread, UserThreadList } from './types.ts'

export * from './types.ts'
export * from './errors.ts'
export * from './mirror.ts'
export * from './receive.ts'
export * from './socket.ts'

export const API = '/api/v4'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>

/**
 * The roles a call picks from. `api` is every REST verb, through the bot's
 * token or the person's as the bind chose; `upload` is `POST /files`, whose
 * body is the file's bytes as they are — a body's encoding is a target's
 * (FJS-651), so the bytes need a target of their own on the person's ref.
 */
export interface MattermostSend { api: Send; upload: Send }

export interface MattermostTargets {
  /** The service credential — a bot or admin token; the sync's and the backfill's. */
  service: TargetDescriptor
  /** The human's credential: one ref, resolved per caller, so a verb spends the token of the person in the call. */
  user:    TargetDescriptor
  /** The human's credential again, with `encoding: 'binary'`, for an upload. */
  upload:  TargetDescriptor
}

function origin(address: string | undefined): string {
  if (!address || !/^https?:\/\//.test(address)) throw new TypeError('mattermost: address is the instance\'s origin, https://chat.example — Mattermost is self-hosted and has no default')
  return address.replace(/\/+$/, '')
}

/**
 * Every REST target, keyed by role. `ref` is the service token's, `userRef`
 * the person's; `id` renames the service target and the other two follow it
 * (`<id>:user`, `<id>:upload`). The socket is not here: it is one per person,
 * built when it is dialed (`mattermostSocketTarget`).
 */
export function mattermostTargets(opts: { address: string; ref?: string; userRef?: string; id?: string }): MattermostTargets {
  const address = origin(opts?.address), id = opts.id ?? MATTERMOST_TARGET
  const base = { kind: 'provider', protocol: 'http', address, registered_at: Date.now(), last_seen_at: null } as const
  const person = { type: 'bearer', ref: opts.userRef ?? 'MATTERMOST_USER_TOKEN', per_caller: true } as const
  return {
    service: { ...base, id, auth: { type: 'bearer', ref: opts.ref ?? 'MATTERMOST_TOKEN' } },
    user:    { ...base, id: opts.id ? `${id}:user` : MATTERMOST_USER_TARGET, auth: person },
    upload:  { ...base, id: opts.id ? `${id}:upload` : MATTERMOST_UPLOAD_TARGET, auth: person, encoding: 'binary' },
  }
}

/**
 * One `Send` per role. WHOSE token a call spends is the caller's choice, made
 * here once: `as: 'user'` is the person in the call (`who`, under junction the
 * principal of the call in progress), `as: 'service'` is the bot. An upload is
 * a person's, never the bot's — a file lands in a channel as its author or not
 * at all (rule 3) — so under `as: 'service'` the `upload` role refuses before
 * anything is sent.
 */
export function bindMattermost(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, targets: MattermostTargets | Record<keyof MattermostTargets, { id: string }>, opts: { as: 'service' | 'user' }): MattermostSend {
  const as = opts?.as
  if (as !== 'service' && as !== 'user') throw new TypeError('mattermost: bindMattermost takes { as: \'service\' } (the bot\'s token) or { as: \'user\' } (the caller\'s)')
  const via = (id: string): Send => req => conduit.send({ target: id, ...req })
  return {
    api:    via(as === 'user' ? targets.user.id : targets.service.id),
    upload: as === 'user' ? via(targets.upload.id) : () => { throw new TypeError('mattermost: an upload is a person\'s — bind with { as: \'user\' }') },
  }
}

type Answer<T> = { row?: T; error?: MattermostFailure }
const answer = <Remote, Row>(r: ConduitResult<Remote>, parse: (x: Remote) => Row | null): Answer<Row> => {
  if (r.error) return { error: translate(r.error, r.meta.status, r.meta.headers) }
  const row = parse(r.data)
  return row ? { row } : { error: { kind: 'invalid_response', message: 'Mattermost answered something that is not the row asked for', retryable: false } }
}

// ─── Verbs ───────────────────────────────────────────────────

/** `POST /posts` as whoever the bundle was bound `as`; the `Post` verb the claim's `create` states, with the response as a row. */
export async function postMessage(mm: MattermostSend, msg: NewPost): Promise<Answer<PostRow>> {
  return answer(await mm.api<Post>(postModel.create!(msg)), postModel.parse)
}

// ─── Reads — the backfill's, every one replayable ────────────

const LIST = { replayable: true } as const

export async function me(mm: MattermostSend): Promise<Answer<ProfileRow>> {
  return answer(await mm.api<User>({ method: 'GET', path: `${API}/users/me`, ...LIST }), profileModel.parse)
}

export async function listTeams(mm: MattermostSend, profileExternalId: string): Promise<{ rows?: TeamRow[]; error?: MattermostFailure }> {
  const r = await mm.api<Team[]>({ method: 'GET', path: `${API}/users/${profileExternalId}/teams`, ...LIST })
  if (r.error) return { error: translate(r.error, r.meta.status, r.meta.headers) }
  return { rows: (Array.isArray(r.data) ? r.data : []).map(x => teamModel.parse(x)).filter((x): x is TeamRow => !!x) }
}

/**
 * A person's channels on a team — their direct and group channels too, which
 * belong to no team and are listed under every one. `includeDeleted` adds the
 * archived ones, which is how a backfill learns an archive it missed.
 */
export async function listChannels(mm: MattermostSend, profileExternalId: string, teamExternalId: string, opts: { includeDeleted?: boolean } = {}): Promise<{ rows?: ChannelRow[]; error?: MattermostFailure }> {
  const r = await mm.api<Channel[]>({ method: 'GET', path: `${API}/users/${profileExternalId}/teams/${teamExternalId}/channels`, ...(opts.includeDeleted ? { query: { include_deleted: true } } : {}), ...LIST })
  if (r.error) return { error: translate(r.error, r.meta.status, r.meta.headers) }
  return { rows: (Array.isArray(r.data) ? r.data : []).map(x => channelModel.parse(x)).filter((x): x is ChannelRow => !!x) }
}

export async function listMembers(mm: MattermostSend, channelExternalId: string, opts: { page?: number; perPage?: number } = {}): Promise<{ rows?: ChannelMemberRow[]; error?: MattermostFailure }> {
  const r = await mm.api<ChannelMember[]>({ method: 'GET', path: `${API}/channels/${channelExternalId}/members`, query: { page: opts.page ?? 0, per_page: opts.perPage ?? 200 }, ...LIST })
  if (r.error) return { error: translate(r.error, r.meta.status, r.meta.headers) }
  return { rows: (Array.isArray(r.data) ? r.data : []).map(x => channelMemberModel.parse(x)).filter((x): x is ChannelMemberRow => !!x) }
}

/**
 * `GET /channels/{id}/posts`, newest first, in Mattermost's `order`. `since` is
 * a ms epoch and answers every post CHANGED after it, deletions included (as
 * `delete_at`), which is what a backfill after a gap wants; `before`/`after`
 * page by post id. Pass at most one.
 */
export interface PostPage {
  rows?: PostRow[]
  /** Each post's reactions and files, from its `metadata` — the whole set for every post in `rows`. */
  reactions?: ReactionRow[]; files?: FileInfoRow[]
  nextPostId?: string | null; prevPostId?: string | null
  error?: MattermostFailure
}

export async function listPosts(mm: MattermostSend, channelExternalId: string, opts: { since?: number; before?: string; after?: string; perPage?: number; page?: number } = {}): Promise<PostPage> {
  if ([opts.since, opts.before, opts.after].filter(x => x !== undefined).length > 1) throw new TypeError('mattermost: listPosts takes one of since, before, after')
  const r = await mm.api<PostList>({ method: 'GET', path: `${API}/channels/${channelExternalId}/posts`, query: { since: opts.since, before: opts.before, after: opts.after, per_page: opts.perPage ?? 60, page: opts.page ?? 0 }, ...LIST })
  if (r.error) return { error: translate(r.error, r.meta.status, r.meta.headers) }
  const list = r.data
  if (!list || !Array.isArray(list.order) || !list.posts) return { error: { kind: 'invalid_response', message: 'Mattermost answered something that is not a post list', retryable: false } }
  const posts = list.order.map(id => list.posts[id]).filter(Boolean)
  const meta = (p: Post) => (p.metadata && typeof p.metadata === 'object' ? p.metadata : {}) as { reactions?: Reaction[]; files?: FileInfo[] }
  return {
    rows:       posts.map(p => postModel.parse(p)).filter((x): x is PostRow => !!x),
    reactions:  posts.flatMap(p => meta(p).reactions ?? []).map(x => reactionModel.parse(x)).filter((x): x is ReactionRow => !!x),
    files:      posts.flatMap(p => meta(p).files ?? []).map(x => fileInfoModel.parse(x)).filter((x): x is FileInfoRow => !!x),
    nextPostId: list.next_post_id || null,
    prevPostId: list.prev_post_id || null,
  }
}

/** Mattermost's `since` answers at most this many posts. */
export const SINCE_LIMIT = 1000

/**
 * Every post in a channel changed after `since` (ms) — edits and deletions
 * included — as far as Mattermost can say. `since` takes its 1000-row cap
 * inside a query with no ORDER BY, so a full answer is an UNSTATED subset of
 * the gap and cannot be paged past by its latest time: that would skip the
 * rows the cap left out. A full answer is therefore `truncated`, and the read
 * falls back to the channel newest-first, page by page, back to `since` —
 * which brings every post CREATED in the gap but not an older post edited or
 * deleted in it beyond what the capped answer held. `truncated` is how a
 * caller learns that, and nothing reads it as complete.
 */
export async function postsSince(mm: MattermostSend, channelExternalId: string, since: number, opts: { limit?: number; perPage?: number } = {}): Promise<PostPage & { truncated?: boolean }> {
  const capped = await listPosts(mm, channelExternalId, { since })
  if (capped.error || capped.rows!.length < (opts.limit ?? SINCE_LIMIT)) return capped
  const seen = new Set(capped.rows!.map(r => r.externalId))
  const out = { rows: [...capped.rows!], reactions: [...capped.reactions!], files: [...capped.files!], truncated: true }
  const perPage = opts.perPage ?? 200
  for (let page = 0;; page++) {
    const p = await listPosts(mm, channelExternalId, { page, perPage })
    if (p.error) return { ...out, error: p.error }
    const fresh = p.rows!.filter(r => !seen.has(r.externalId) && (r.createdAt?.getTime() ?? 0) > since)
    for (const r of fresh) seen.add(r.externalId)
    const ids = new Set(fresh.map(r => r.externalId))
    out.rows.push(...fresh)
    out.reactions.push(...p.reactions!.filter(r => ids.has(r.postExternalId)))
    out.files.push(...p.files!.filter(f => !!f.postExternalId && ids.has(f.postExternalId)))
    const oldest = Math.min(...p.rows!.map(r => r.createdAt?.getTime() ?? 0))
    if (p.rows!.length < perPage || oldest <= since) return out
  }
}

// ─── Reading state — the caller's own watermark ─────────────

const isId = (v: unknown): v is MattermostId => typeof v === 'string' && /^[a-z0-9]{26}$/.test(v)
const needId = (v: unknown, what: string) => { if (!isId(v)) throw new TypeError(`mattermost: ${what} is not a Mattermost id`); return v }

/**
 * `POST /channels/members/me/view` as the caller: they have read the channel,
 * so its counts are theirs again and Mattermost's own clients clear it too.
 * `prevChannelExternalId` is the one they left, which Mattermost marks read at
 * the moment they left it. The answer is each channel's new `last_viewed_at`;
 * the server then pushes `channel_viewed` (or `multiple_channels_viewed`) to the
 * caller's sockets. Viewing twice is viewing once, so the read is replayable.
 */
export async function viewChannel(mm: MattermostSend, channelExternalId: MattermostId, prevChannelExternalId?: MattermostId | null): Promise<{ times?: Record<MattermostId, Date>; error?: MattermostFailure }> {
  const body = { channel_id: needId(channelExternalId, 'channelExternalId'), prev_channel_id: isId(prevChannelExternalId) ? prevChannelExternalId : '', collapsed_threads_supported: true }
  const r = await mm.api<{ status?: string; last_viewed_at_times?: Record<string, number> }>({ method: 'POST', path: `${API}/channels/members/me/view`, body, ...LIST })
  if (r.error) return { error: translate(r.error, r.meta.status, r.meta.headers) }
  const raw = r.data?.last_viewed_at_times ?? {}
  return { times: Object.fromEntries(Object.entries(raw).filter(([id, t]) => isId(id) && typeof t === 'number' && t > 0).map(([id, t]) => [id, new Date(t)])) }
}

/** What a thread read answers: the person's view of each thread, and each thread's root as a post. */
export interface ThreadPage { rows?: ThreadRow[]; roots?: PostRow[]; error?: MattermostFailure }

const threadsOf = (list: UserThread[], profileExternalId: MattermostId) => ({
  rows:  list.map(t => threadModel.parse(t, { profileExternalId })).filter((x): x is ThreadRow => !!x),
  roots: list.map(t => t.post ? postModel.parse(t.post) : null).filter((x): x is PostRow => !!x),
})

/**
 * `GET /users/{id}/teams/{team}/threads` — the threads a person follows, as
 * they see them, newest reply first and paged back by `before`. `since` (ms)
 * answers only threads changed after it, deleted roots included, which is the
 * backfill's read. A direct or group channel's threads are listed under every
 * team, so a caller reading several teams keys them once.
 */
export async function listThreads(mm: MattermostSend, profileExternalId: MattermostId, teamExternalId: MattermostId, opts: { since?: number; perPage?: number; maxPages?: number } = {}): Promise<ThreadPage> {
  needId(profileExternalId, 'profileExternalId'); needId(teamExternalId, 'teamExternalId')
  const perPage = opts.perPage ?? 100
  const out: Required<Omit<ThreadPage, 'error'>> = { rows: [], roots: [] }
  let before: string | undefined
  for (let page = 0; page < (opts.maxPages ?? 10); page++) {
    const r = await mm.api<UserThreadList>({ method: 'GET', path: `${API}/users/${profileExternalId}/teams/${teamExternalId}/threads`, query: { per_page: perPage, deleted: true, extended: false, ...(opts.since ? { since: opts.since } : {}), ...(before ? { before } : {}) }, ...LIST })
    if (r.error) return { ...out, error: translate(r.error, r.meta.status, r.meta.headers) }
    const list = Array.isArray(r.data?.threads) ? r.data.threads : []
    const got = threadsOf(list, profileExternalId)
    out.rows.push(...got.rows); out.roots.push(...got.roots)
    if (list.length < perPage) break
    before = list.at(-1)!.id
  }
  return out
}

/** One thread as the person sees it — what a follow arriving for a thread not yet listed reads. */
export async function getThread(mm: MattermostSend, profileExternalId: MattermostId, teamExternalId: MattermostId, rootExternalId: MattermostId): Promise<ThreadPage> {
  const r = await mm.api<UserThread>({ method: 'GET', path: `${API}/users/${needId(profileExternalId, 'profileExternalId')}/teams/${needId(teamExternalId, 'teamExternalId')}/threads/${needId(rootExternalId, 'rootExternalId')}`, ...LIST })
  if (r.error) return { error: translate(r.error, r.meta.status, r.meta.headers) }
  return r.data && isId(r.data.id) ? threadsOf([r.data], profileExternalId) : { error: { kind: 'invalid_response', message: 'Mattermost answered something that is not a thread', retryable: false } }
}

/**
 * `PUT /users/{id}/teams/{team}/threads/{root}/read/{at}` as the caller: the
 * thread is read up to `at` (ms). Read a thread at `max(now, lastReplyAt)`, so a
 * reply whose time is ahead of this clock is read too. A direct channel's
 * thread is read under any team the person is on. Replayable: the same `at`
 * twice is one read.
 */
export async function markThreadRead(mm: MattermostSend, profileExternalId: MattermostId, teamExternalId: MattermostId, rootExternalId: MattermostId, at: number): Promise<Answer<ThreadRow>> {
  if (!Number.isFinite(at) || at <= 0) throw new TypeError('mattermost: markThreadRead takes the read time in ms')
  const r = await mm.api<UserThread>({ method: 'PUT', path: `${API}/users/${needId(profileExternalId, 'profileExternalId')}/teams/${needId(teamExternalId, 'teamExternalId')}/threads/${needId(rootExternalId, 'rootExternalId')}/read/${Math.floor(at)}`, ...LIST })
  return answer(r, t => threadModel.parse(t, { profileExternalId }))
}

/** `POST /users/ids` — the people a backfill met as authors and members. */
export async function listProfiles(mm: MattermostSend, ids: MattermostId[]): Promise<{ rows?: ProfileRow[]; error?: MattermostFailure }> {
  if (!ids.length) return { rows: [] }
  const r = await mm.api<User[]>({ method: 'POST', path: `${API}/users/ids`, body: ids, ...LIST })
  if (r.error) return { error: translate(r.error, r.meta.status, r.meta.headers) }
  return { rows: (Array.isArray(r.data) ? r.data : []).map(x => profileModel.parse(x)).filter((x): x is ProfileRow => !!x) }
}

// ─── Files ───────────────────────────────────────────────────

/**
 * What Mattermost keeps of an upload: the bytes as sent, and for an image a
 * `preview` (screen-sized JPEG) and a `thumbnail` (small JPEG) — the latter two
 * only where the FileInfo says `hasPreviewImage`.
 */
export type FileSize = 'full' | 'preview' | 'thumbnail'

/** One file to upload: its bytes, the name it is shown under, and its type as the uploader's machine said. */
export interface NewFile {
  channelExternalId: MattermostId
  name:              string
  bytes:             Uint8Array
  mimeType?:         string
}

/**
 * `POST /files` through the `upload` role, as the person in the call: the
 * bytes as the body, the channel and the name in the query, which is the form
 * Mattermost takes for one file. The answer is the FileInfo with no post yet;
 * a post made with its id in `fileExternalIds` claims it, and Mattermost
 * forgets an unclaimed one. Not replayable: nothing collapses a second upload
 * into the first, so a lost answer is an orphan and not two attachments.
 */
export async function uploadFile(mm: MattermostSend, file: NewFile): Promise<Answer<FileInfoRow>> {
  const channel = file.channelExternalId
  if (!/^[a-z0-9]{26}$/.test(channel ?? '')) throw new TypeError('mattermost: uploadFile takes the channel\'s Mattermost id')
  if (typeof file.name !== 'string' || !file.name.trim()) throw new TypeError('mattermost: an upload needs a file name')
  if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength === 0) throw new TypeError('mattermost: an upload needs its bytes')
  const r = await mm.upload<{ file_infos?: FileInfo[] }>({
    method: 'POST', path: `${API}/files`, query: { channel_id: channel, filename: file.name.trim() },
    body: file.bytes, headers: { 'Content-Type': file.mimeType || 'application/octet-stream' },
  })
  return answer(r, x => fileInfoModel.parse(x?.file_infos?.[0] as FileInfo))
}

/**
 * `GET /files/{id}`, or its preview or thumbnail, as whoever the bundle was
 * bound `as`: Mattermost answers a file only to a member of its post's channel,
 * so a person's read binds `as: 'user'`. The bytes come back as
 * conduit hands any non-text body (`FJS-D585`), capped by the target's
 * `max_response_bytes`.
 */
export async function fileBytes(mm: MattermostSend, fileExternalId: MattermostId, size: FileSize = 'full'): Promise<{ bytes?: Uint8Array; type?: string; error?: MattermostFailure }> {
  if (!/^[a-z0-9]{26}$/.test(fileExternalId)) throw new TypeError('mattermost: fileBytes takes a Mattermost file id')
  const r = await mm.api<Uint8Array>({ method: 'GET', path: `${API}/files/${fileExternalId}${size === 'full' ? '' : `/${size}`}`, ...LIST })
  if (r.error) return { error: translate(r.error, r.meta.status, r.meta.headers) }
  if (!(r.data instanceof Uint8Array)) return { error: { kind: 'invalid_response', message: 'Mattermost answered a file with something that is not bytes', retryable: false } }
  return { bytes: r.data, type: r.meta.headers?.['content-type'] ?? 'application/octet-stream' }
}
