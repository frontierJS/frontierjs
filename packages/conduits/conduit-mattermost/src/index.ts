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
import { channelModel, channelMemberModel, fileInfoModel, MATTERMOST_TARGET, MATTERMOST_UPLOAD_TARGET, MATTERMOST_USER_TARGET, memberKey, isCategoryId, parseCategory, parseDraft, parsePreference, parseStatus, parseUnread, postModel, reactionModel, teamModel, threadModel, profileModel, type CategoryRow, type ChannelMemberRow, type DraftRow, type PreferenceRow, type StatusRow, type UnreadRow, type ChannelRow, type FileInfoRow, type PostRow, type ReactionRow, type TeamRow, type ThreadRow, type ProfileRow } from './mirror.ts'
import type { Channel, ChannelMember, ChannelUnreadAt, Draft, FileInfo, MattermostId, NewDraft, NewPost, Post, PostList, Preference, Reaction, SearchResult, SidebarCategories, SidebarCategory, StatusName, Team, User, UserStatus, UserThread, UserThreadList } from './types.ts'

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

/**
 * A team's open channels, whoever is in them -- what a person browses to find
 * one to join. Private, direct and group channels are not listed, and the
 * person's own are among them: the caller tells them apart by membership.
 */
export async function browseChannels(mm: MattermostSend, teamExternalId: string, opts: { page?: number; perPage?: number } = {}): Promise<{ rows?: ChannelRow[]; error?: MattermostFailure }> {
  const r = await mm.api<Channel[]>({ method: 'GET', path: `${API}/teams/${needId(teamExternalId, 'teamExternalId')}/channels`, query: { page: opts.page ?? 0, per_page: opts.perPage ?? 200 }, ...LIST })
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
  return pageOf(r.data)
}

/** A post list as a page of rows — `listPosts`, `listPinned`, `listSavedPosts` and `searchPosts` all answer one. */
function pageOf(list: PostList | undefined): PostPage {
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

// ─── What a chat client does beyond the mirror ───────────────
//
// Every verb below is one person's, so each binds `as: 'user'`; the profile id
// a path names is that person's own, and Mattermost refuses another's with a
// 403. A write that sets an absolute state (pin, mute, follow, a preference)
// is `replayable`: doing it twice is doing it once. A category create is the
// exception, since a lost answer may have made one.

/** What a write with no row to answer says. */
export interface Done { ok?: true; error?: MattermostFailure }

const done = (r: ConduitResult<unknown>): Done => r.error ? { error: translate(r.error, r.meta.status, r.meta.headers) } : { ok: true }
const rowsOf = <Remote, Row>(r: ConduitResult<Remote[]>, parse: (x: Remote) => Row | null): { rows?: Row[]; error?: MattermostFailure } =>
  r.error ? { error: translate(r.error, r.meta.status, r.meta.headers) } : { rows: (Array.isArray(r.data) ? r.data : []).map(x => parse(x)).filter((x): x is Row => x !== null) }
const user = (id: unknown) => needId(id, 'profileExternalId')
const categoryId = (v: unknown, what: string) => { if (!isCategoryId(v)) throw new TypeError(`mattermost: ${what} is not a category id`); return v }

// ─── Pins ────────────────────────────────────────────────────

/**
 * `POST /posts/{id}/pin`: any member of the channel may pin any post in it.
 * `Post.update({ isPinned })` is the same change through `/patch`, which only
 * the post's author may make. The server pushes `post_edited` carrying the post
 * with `is_pinned`, so the mirror's Post row follows.
 */
export async function pinPost(mm: MattermostSend, postExternalId: MattermostId): Promise<Done> {
  return done(await mm.api({ method: 'POST', path: `${API}/posts/${needId(postExternalId, 'postExternalId')}/pin`, ...LIST }))
}
export async function unpinPost(mm: MattermostSend, postExternalId: MattermostId): Promise<Done> {
  return done(await mm.api({ method: 'POST', path: `${API}/posts/${needId(postExternalId, 'postExternalId')}/unpin`, ...LIST }))
}
/** `GET /channels/{id}/pinned`: the channel's pinned posts, with reactions and files off their metadata. */
export async function listPinned(mm: MattermostSend, channelExternalId: MattermostId): Promise<PostPage> {
  const r = await mm.api<PostList>({ method: 'GET', path: `${API}/channels/${needId(channelExternalId, 'channelExternalId')}/pinned`, ...LIST })
  return r.error ? { error: translate(r.error, r.meta.status, r.meta.headers) } : pageOf(r.data)
}

// ─── Reading state, mute, membership ─────────────────────────

/**
 * `POST /users/{id}/posts/{post}/set_unread`: the channel reads as unread from
 * that post on, for this person only. With collapsed threads a REPLY marks its
 * thread unread instead of the channel, so the answer is the channel's counts
 * for a root post and the channel's unchanged ones for a reply; read the thread
 * with `getThread`. The server pushes `post_unread` to the person's sockets.
 */
export async function markUnread(mm: MattermostSend, profileExternalId: MattermostId, postExternalId: MattermostId): Promise<Answer<UnreadRow>> {
  const r = await mm.api<ChannelUnreadAt>({ method: 'POST', path: `${API}/users/${user(profileExternalId)}/posts/${needId(postExternalId, 'postExternalId')}/set_unread`, body: { collapsed_threads_supported: true }, ...LIST })
  return answer(r, parseUnread)
}

/**
 * `PUT /channels/{id}/members/{user}/notify_props` with `mark_unread`: `mention`
 * mutes the channel (unread only when it names the member), `all` unmutes it.
 * Only the keys sent change. The server pushes `channel_member_updated`.
 */
export async function muteChannel(mm: MattermostSend, channelExternalId: MattermostId, profileExternalId: MattermostId, muted: boolean): Promise<Done> {
  return done(await mm.api({ method: 'PUT', path: `${API}/channels/${needId(channelExternalId, 'channelExternalId')}/members/${user(profileExternalId)}/notify_props`, body: { mark_unread: muted ? 'mention' : 'all' }, ...LIST }))
}

/** `POST /channels/{id}/members` as the person themselves: an open channel takes them, a private one is a 403. */
export async function joinChannel(mm: MattermostSend, channelExternalId: MattermostId, profileExternalId: MattermostId): Promise<Answer<ChannelMemberRow>> {
  return answer(await mm.api<ChannelMember>({ ...channelMemberModel.create!({ channelExternalId, profileExternalId }), ...LIST }), channelMemberModel.parse)
}
/** `DELETE /channels/{id}/members/{user}` as the person themselves. */
export async function leaveChannel(mm: MattermostSend, channelExternalId: MattermostId, profileExternalId: MattermostId): Promise<Done> {
  return done(await mm.api(channelMemberModel.delete!(memberKey(channelExternalId, profileExternalId))))
}

/**
 * `POST /channels/direct` for the caller and one other: the channel that
 * exists, or the one just made, answered either way with 201. It belongs to no
 * team. The server pushes `direct_added` to both people.
 */
export async function createDirectChannel(mm: MattermostSend, profileExternalId: MattermostId, otherExternalId: MattermostId): Promise<Answer<ChannelRow>> {
  return answer(await mm.api<Channel>({ method: 'POST', path: `${API}/channels/direct`, body: [user(profileExternalId), needId(otherExternalId, 'otherExternalId')], ...LIST }), channelModel.parse)
}

/**
 * `POST /channels/group` for three to eight people, the caller among them.
 * One group per set of people: the same set answers the channel that exists.
 * The server pushes `group_added` to each.
 */
export async function createGroupChannel(mm: MattermostSend, profileExternalIds: MattermostId[]): Promise<Answer<ChannelRow>> {
  const ids = [...new Set(profileExternalIds.map(user))]
  if (ids.length < 3 || ids.length > 8) throw new TypeError('mattermost: a group channel is three to eight people; two is a direct channel')
  return answer(await mm.api<Channel>({ method: 'POST', path: `${API}/channels/group`, body: ids, ...LIST }), channelModel.parse)
}

// ─── Threads ─────────────────────────────────────────────────

const threadPath = (profile: unknown, team: unknown, root: unknown) => `${API}/users/${user(profile)}/teams/${needId(team, 'teamExternalId')}/threads/${needId(root, 'rootExternalId')}`

/** `PUT .../threads/{root}/following`: follow a thread without replying to it. The server pushes `thread_follow_changed`. */
export async function followThread(mm: MattermostSend, profileExternalId: MattermostId, teamExternalId: MattermostId, rootExternalId: MattermostId): Promise<Done> {
  return done(await mm.api({ method: 'PUT', path: `${threadPath(profileExternalId, teamExternalId, rootExternalId)}/following`, ...LIST }))
}
/** `DELETE .../threads/{root}/following`: the thread leaves the person's list and its replies stop counting. */
export async function unfollowThread(mm: MattermostSend, profileExternalId: MattermostId, teamExternalId: MattermostId, rootExternalId: MattermostId): Promise<Done> {
  return done(await mm.api({ method: 'DELETE', path: `${threadPath(profileExternalId, teamExternalId, rootExternalId)}/following`, ...LIST }))
}
/** `PUT /users/{id}/teams/{team}/threads/read`: every followed thread on the team, read now. The push names no thread. */
export async function markAllThreadsRead(mm: MattermostSend, profileExternalId: MattermostId, teamExternalId: MattermostId): Promise<Done> {
  return done(await mm.api({ method: 'PUT', path: `${API}/users/${user(profileExternalId)}/teams/${needId(teamExternalId, 'teamExternalId')}/threads/read`, ...LIST }))
}

// ─── Drafts ──────────────────────────────────────────────────

/**
 * `GET /users/{id}/teams/{team}/drafts`: the person's saved reply boxes on a
 * team, the direct and group channels' under every team. A server with
 * `AllowSyncedDrafts` off answers 404 here.
 */
export async function listDrafts(mm: MattermostSend, profileExternalId: MattermostId, teamExternalId: MattermostId, opts: { since?: number } = {}): Promise<{ rows?: DraftRow[]; error?: MattermostFailure }> {
  return rowsOf(await mm.api<Draft[]>({ method: 'GET', path: `${API}/users/${user(profileExternalId)}/teams/${needId(teamExternalId, 'teamExternalId')}/drafts`, ...(opts.since ? { query: { since: opts.since } } : {}), ...LIST }), parseDraft)
}
/**
 * `POST /drafts`: one draft per person per box (channel, and root for a reply
 * box); a second save replaces the first. The server pushes `draft_created` the
 * first time and `draft_updated` after, to the person's every socket.
 */
export async function saveDraft(mm: MattermostSend, profileExternalId: MattermostId, draft: NewDraft): Promise<Answer<DraftRow>> {
  const files = draft.fileExternalIds ?? []
  const body: Record<string, unknown> = { user_id: user(profileExternalId), channel_id: needId(draft.channelExternalId, 'channelExternalId'), message: draft.message ?? '', root_id: draft.rootExternalId ? needId(draft.rootExternalId, 'rootExternalId') : '' }
  if (files.length) body.file_ids = files.map(f => needId(f, 'fileExternalId'))
  if (draft.props)  body.props = draft.props
  return answer(await mm.api<Draft>({ method: 'POST', path: `${API}/drafts`, body, ...LIST }), parseDraft)
}
/** `DELETE /users/{id}/channels/{channel}/drafts[/{root}]`: the channel's box, or one thread's. The server pushes `draft_deleted`. */
export async function deleteDraft(mm: MattermostSend, profileExternalId: MattermostId, channelExternalId: MattermostId, rootExternalId?: MattermostId | null): Promise<Done> {
  return done(await mm.api({ method: 'DELETE', path: `${API}/users/${user(profileExternalId)}/channels/${needId(channelExternalId, 'channelExternalId')}/drafts${rootExternalId ? `/${needId(rootExternalId, 'rootExternalId')}` : ''}`, ...LIST }))
}

// ─── Preferences: saved posts, favorites ─────────────────────

/** The categories a chat client reads. A saved post is `flagged_post` named for the post, a favorite channel `favorite_channel` named for the channel, both valued `"true"`. */
export const PREFERENCE = { savedPost: 'flagged_post', favoriteChannel: 'favorite_channel' } as const

export async function listPreferences(mm: MattermostSend, profileExternalId: MattermostId, category?: string): Promise<{ rows?: PreferenceRow[]; error?: MattermostFailure }> {
  return rowsOf(await mm.api<Preference[]>({ method: 'GET', path: `${API}/users/${user(profileExternalId)}/preferences${category ? `/${encodeURIComponent(category)}` : ''}`, ...LIST }), parsePreference)
}
/** `PUT /users/{id}/preferences`: each `{ category, name, value }` is set. The server pushes `preferences_changed`. */
export async function savePreferences(mm: MattermostSend, profileExternalId: MattermostId, prefs: { category: string; name: string; value: string }[]): Promise<Done> {
  const uid = user(profileExternalId)
  if (!prefs.length || prefs.some(p => !p.category || !p.name || typeof p.value !== 'string')) throw new TypeError('mattermost: a preference is { category, name, value }, value a string')
  return done(await mm.api({ method: 'PUT', path: `${API}/users/${uid}/preferences`, body: prefs.map(p => ({ user_id: uid, ...p })), ...LIST }))
}
/** `POST /users/{id}/preferences/delete`. The server pushes `preferences_deleted`. */
export async function deletePreferences(mm: MattermostSend, profileExternalId: MattermostId, prefs: { category: string; name: string }[]): Promise<Done> {
  const uid = user(profileExternalId)
  if (!prefs.length || prefs.some(p => !p.category || !p.name)) throw new TypeError('mattermost: a preference to delete is { category, name }')
  return done(await mm.api({ method: 'POST', path: `${API}/users/${uid}/preferences/delete`, body: prefs.map(p => ({ user_id: uid, ...p, value: '' })), ...LIST }))
}
export const savePost    = (mm: MattermostSend, profile: MattermostId, post: MattermostId) => savePreferences(mm, profile, [{ category: PREFERENCE.savedPost, name: needId(post, 'postExternalId'), value: 'true' }])
export const unsavePost  = (mm: MattermostSend, profile: MattermostId, post: MattermostId) => deletePreferences(mm, profile, [{ category: PREFERENCE.savedPost, name: needId(post, 'postExternalId') }])
export const favoriteChannel   = (mm: MattermostSend, profile: MattermostId, channel: MattermostId) => savePreferences(mm, profile, [{ category: PREFERENCE.favoriteChannel, name: needId(channel, 'channelExternalId'), value: 'true' }])
export const unfavoriteChannel = (mm: MattermostSend, profile: MattermostId, channel: MattermostId) => deletePreferences(mm, profile, [{ category: PREFERENCE.favoriteChannel, name: needId(channel, 'channelExternalId') }])

/** `GET /users/{id}/posts/flagged`: the person's saved posts, newest first, optionally one team's and the direct channels'. */
export async function listSavedPosts(mm: MattermostSend, profileExternalId: MattermostId, opts: { teamExternalId?: MattermostId; page?: number; perPage?: number } = {}): Promise<PostPage> {
  const r = await mm.api<PostList>({ method: 'GET', path: `${API}/users/${user(profileExternalId)}/posts/flagged`, query: { page: opts.page ?? 0, per_page: opts.perPage ?? 60, ...(opts.teamExternalId ? { team_id: needId(opts.teamExternalId, 'teamExternalId') } : {}) }, ...LIST })
  return r.error ? { error: translate(r.error, r.meta.status, r.meta.headers) } : pageOf(r.data)
}

// ─── Status ──────────────────────────────────────────────────

/** `GET /users/{id}/status`. `manual` is a status the person set; otherwise it follows their activity. */
export async function getStatus(mm: MattermostSend, profileExternalId: MattermostId): Promise<Answer<StatusRow>> {
  return answer(await mm.api<UserStatus>({ method: 'GET', path: `${API}/users/${user(profileExternalId)}/status`, ...LIST }), parseStatus)
}
/** `POST /users/status/ids`: other people's statuses, which Mattermost's clients poll for the ones on screen. A person Mattermost knows no status for is `offline`. */
export async function listStatuses(mm: MattermostSend, profileExternalIds: MattermostId[]): Promise<{ rows?: StatusRow[]; error?: MattermostFailure }> {
  if (!profileExternalIds.length) return { rows: [] }
  return rowsOf(await mm.api<UserStatus[]>({ method: 'POST', path: `${API}/users/status/ids`, body: profileExternalIds.map(user), ...LIST }), parseStatus)
}
/**
 * `PUT /users/{id}/status`. `dndEndTime` is when `dnd` lapses, in whole
 * seconds — unverified against a live server. The server pushes `status_change`
 * to that person's sockets.
 */
export async function setStatus(mm: MattermostSend, profileExternalId: MattermostId, status: StatusName, opts: { dndEndTime?: number } = {}): Promise<Answer<StatusRow>> {
  if (!['online', 'away', 'offline', 'dnd'].includes(status)) throw new TypeError('mattermost: a status is online, away, offline or dnd')
  const uid = user(profileExternalId)
  return answer(await mm.api<UserStatus>({ method: 'PUT', path: `${API}/users/${uid}/status`, body: { user_id: uid, status, ...(opts.dndEndTime ? { dnd_end_time: Math.floor(opts.dndEndTime) } : {}) }, ...LIST }), parseStatus)
}
/**
 * `PUT /users/{id}/status/custom`: an emoji and a line under the person's name,
 * kept in `props.customStatus` (read it back with `customStatusOf(user)`). The
 * server pushes `user_updated`. `expiresAt` is when it lapses; with none it stays.
 */
export async function setCustomStatus(mm: MattermostSend, profileExternalId: MattermostId, status: { emoji: string; text?: string; expiresAt?: Date }): Promise<Done> {
  if (!status.emoji && !status.text) throw new TypeError('mattermost: a custom status needs an emoji or text')
  const body = { emoji: status.emoji ?? '', text: status.text ?? '', duration: status.expiresAt ? 'date_and_time' : 'dont_clear', ...(status.expiresAt ? { expires_at: status.expiresAt.toISOString() } : {}) }
  return done(await mm.api({ method: 'PUT', path: `${API}/users/${user(profileExternalId)}/status/custom`, body, ...LIST }))
}
export async function clearCustomStatus(mm: MattermostSend, profileExternalId: MattermostId): Promise<Done> {
  return done(await mm.api({ method: 'DELETE', path: `${API}/users/${user(profileExternalId)}/status/custom`, ...LIST }))
}

// ─── Typing ──────────────────────────────────────────────────

/**
 * The `user_typing` action for a channel, or one thread's reply box, as the text
 * a client writes on its own socket. It rides the socket and has no REST form;
 * conduit's broker holds the connection and offers an app no way to write to it,
 * so a caller that wants to relay typing writes this frame on a link of its own.
 * `seq` counts the frames that link has sent.
 */
export function typingFrame(seq: number, channelExternalId: MattermostId, parentExternalId?: MattermostId | null): string {
  return JSON.stringify({ action: 'user_typing', seq, data: { channel_id: needId(channelExternalId, 'channelExternalId'), parent_id: parentExternalId ? needId(parentExternalId, 'parentExternalId') : '' } })
}

// ─── Sidebar categories ──────────────────────────────────────

const categoriesPath = (profile: unknown, team: unknown) => `${API}/users/${user(profile)}/teams/${needId(team, 'teamExternalId')}/channels/categories`
const wireCategory = (c: CategoryRow): Record<string, unknown> => ({ id: c.externalId, user_id: c.profileExternalId, team_id: c.teamExternalId, type: c.type, display_name: c.displayName, sorting: c.sorting, channel_ids: c.channelExternalIds, muted: c.muted, collapsed: c.collapsed })

/** `GET .../channels/categories`: the person's sidebar on a team, `order` being the categories' ids top to bottom. System categories (`favorites`, `channels`, `direct_messages`) are always present. */
export async function listCategories(mm: MattermostSend, profileExternalId: MattermostId, teamExternalId: MattermostId): Promise<{ order?: MattermostId[]; rows?: CategoryRow[]; error?: MattermostFailure }> {
  const r = await mm.api<SidebarCategories>({ method: 'GET', path: categoriesPath(profileExternalId, teamExternalId), ...LIST })
  if (r.error) return { error: translate(r.error, r.meta.status, r.meta.headers) }
  if (!r.data || !Array.isArray(r.data.categories)) return { error: { kind: 'invalid_response', message: 'Mattermost answered something that is not a category list', retryable: false } }
  return { order: r.data.order ?? [], rows: r.data.categories.map(parseCategory).filter((x): x is CategoryRow => !!x) }
}
/** `POST .../channels/categories`: a custom category, with channels moved into it if named. Not replayable: a lost answer may have made one. */
export async function createCategory(mm: MattermostSend, profileExternalId: MattermostId, teamExternalId: MattermostId, input: { displayName: string; channelExternalIds?: MattermostId[] }): Promise<Answer<CategoryRow>> {
  if (typeof input.displayName !== 'string' || !input.displayName.trim()) throw new TypeError('mattermost: a category needs a display name')
  const body = { user_id: user(profileExternalId), team_id: needId(teamExternalId, 'teamExternalId'), type: 'custom', display_name: input.displayName.trim(), channel_ids: (input.channelExternalIds ?? []).map(c => needId(c, 'channelExternalId')) }
  return answer(await mm.api<SidebarCategory>({ method: 'POST', path: categoriesPath(profileExternalId, teamExternalId), body }), parseCategory)
}
/**
 * `PUT .../channels/categories/{id}` with the WHOLE category: its name, its
 * channels in order, its sorting, muted and collapsed. Mattermost replaces what
 * is stored, so a `channelExternalIds` left short drops channels from it; read
 * the row, change it, send it back. Moving a channel into a category takes it
 * out of the one it was in; the server pushes `sidebar_category_updated`.
 */
export async function updateCategory(mm: MattermostSend, profileExternalId: MattermostId, teamExternalId: MattermostId, category: CategoryRow): Promise<Answer<CategoryRow>> {
  return answer(await mm.api<SidebarCategory>({ method: 'PUT', path: `${categoriesPath(profileExternalId, teamExternalId)}/${categoryId(category.externalId, 'category.externalId')}`, body: wireCategory(category), ...LIST }), parseCategory)
}
/** `DELETE .../categories/{id}`: a custom category; its channels return to Channels or Direct Messages. A system category is a 400. */
export async function deleteCategory(mm: MattermostSend, profileExternalId: MattermostId, teamExternalId: MattermostId, categoryExternalId: MattermostId): Promise<Done> {
  return done(await mm.api({ method: 'DELETE', path: `${categoriesPath(profileExternalId, teamExternalId)}/${categoryId(categoryExternalId, 'categoryExternalId')}`, ...LIST }))
}
/** `PUT .../categories/order`: the whole list of category ids, top to bottom. */
export async function reorderCategories(mm: MattermostSend, profileExternalId: MattermostId, teamExternalId: MattermostId, order: MattermostId[]): Promise<{ order?: MattermostId[]; error?: MattermostFailure }> {
  const r = await mm.api<MattermostId[]>({ method: 'PUT', path: `${categoriesPath(profileExternalId, teamExternalId)}/order`, body: order.map(c => categoryId(c, 'categoryExternalId')), ...LIST })
  return r.error ? { error: translate(r.error, r.meta.status, r.meta.headers) } : { order: Array.isArray(r.data) ? r.data : order }
}

// ─── Search, history, reminders ──────────────────────────────

/**
 * `POST /teams/{id}/posts/search`: posts in the channels the person belongs to
 * whose words match every term, or any with `orSearch`. A read behind a POST,
 * so replayable. `matches` is, per post, the terms that hit it.
 */
export async function searchPosts(mm: MattermostSend, teamExternalId: MattermostId, terms: string, opts: { orSearch?: boolean; includeDeletedChannels?: boolean; page?: number; perPage?: number } = {}): Promise<PostPage & { matches?: Record<MattermostId, string[]> }> {
  if (typeof terms !== 'string' || !terms.trim()) throw new TypeError('mattermost: a search needs terms')
  const r = await mm.api<SearchResult>({ method: 'POST', path: `${API}/teams/${needId(teamExternalId, 'teamExternalId')}/posts/search`, body: { terms: terms.trim(), is_or_search: !!opts.orSearch, include_deleted_channels: !!opts.includeDeletedChannels, time_zone_offset: 0, page: opts.page ?? 0, per_page: opts.perPage ?? 20 }, ...LIST })
  if (r.error) return { error: translate(r.error, r.meta.status, r.meta.headers) }
  return { ...pageOf(r.data), ...(r.data?.matches ? { matches: r.data.matches } : {}) }
}

/**
 * `GET /posts/{id}/edit_history`: the versions a post had before each edit,
 * newest first, each under an id of its own with `deletedAt` set. Only the
 * post's author may ask; anyone else's is a 404 `app.post.get.app_error`.
 */
export async function editHistory(mm: MattermostSend, postExternalId: MattermostId): Promise<{ rows?: PostRow[]; error?: MattermostFailure }> {
  return rowsOf(await mm.api<Post[]>({ method: 'GET', path: `${API}/posts/${needId(postExternalId, 'postExternalId')}/edit_history`, ...LIST }), x => postModel.parse(x))
}

/** `POST /users/{id}/posts/{post}/reminder`: Mattermost's own bot messages the person about the post at `at`. `target_time` goes in whole seconds. */
export async function setReminder(mm: MattermostSend, profileExternalId: MattermostId, postExternalId: MattermostId, at: Date | number): Promise<Done> {
  const ms = at instanceof Date ? at.getTime() : at
  if (!Number.isFinite(ms) || ms <= 0) throw new TypeError('mattermost: setReminder takes the time to remind at')
  return done(await mm.api({ method: 'POST', path: `${API}/users/${user(profileExternalId)}/posts/${needId(postExternalId, 'postExternalId')}/reminder`, body: { target_time: Math.floor(ms / 1000) }, ...LIST }))
}
