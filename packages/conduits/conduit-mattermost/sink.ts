// sink.ts — Mattermost, standing in for Mattermost.
//
// Bearer tokens, JSON, snake_case, ms epochs with 0 for never; a refusal is
// `{ id, message, status_code }` on every status; a 403 for a channel the
// caller is not in; a 404 for a post that is gone; a post collapsed under
// `pending_post_id` inside a 30 s window; a 429 that carries
// `X-Ratelimit-Reset` and no `Retry-After`, as the real one does.
// Seeded: one team, an open channel every user is in, a private channel
// only alice is in, two people and the service bot.
// Chaos: `{ lost }`, `{ rateLimit: { reset } }`, `{ failNext }`, `{ deliverTwice }`.
//
// The deliveries Mattermost makes are made here too, encoded by hand (C10):
// `POST /api/v4/hooks/outgoing` registers an outgoing webhook, and a post
// whose first word is one of its trigger words is delivered to its callback
// URLs — form or JSON as `content_type` says, token in the body and in
// `Authorization: Token` — and a 200 with `text` becomes the hook's post, in
// the thread when `response_type` is `comment`. `POST /api/v4/commands`
// registers a slash command and `POST /api/v4/commands/execute` runs one as
// the caller, form-encoded with the header, minting a `response_url` under
// `/hooks/commands/{id}` that takes five messages. What came back is under
// `/_sink/seen` as `deliveries` and `replies`.
//
// The WebSocket at `/api/v4/websocket` authenticates by the upgrade's
// `Authorization: Bearer` or by an `authentication_challenge` after open,
// answers the challenge `{ status, seq_reply }`, then sends `hello` with a
// `connection_id` at seq 0; `seq` counts per connection. A post, an edit, a
// delete, a channel patch or delete and a member added or removed are pushed
// to every connection whose user is in the channel, `post` and `channel` as
// JSON strings inside `data`, as the real one does. Chaos: `{ socketHeader:
// false }` ignores the header so only the challenge authenticates,
// `{ frameTwice }` sends the next frame twice under one seq, `{ dropSockets }`
// closes every connection from the server's side, and `{ silenceSocket: id }`
// turns that connection into a dead link that never closes: no frame, no
// reply to `ping`. `{ skipSeq: n }` moves every open connection's `seq` on by
// n, as n events the server dropped would. A `ping` is answered `{ status: 'OK', seq_reply, data:
// { text: 'pong' } }` and counted per connection. `POST /_sink/socket` pushes
// `{ event, data, broadcast }` or `{ raw }` to every authenticated connection.
//
// What a backfill reads is read as the real one answers it: a user's channels
// on a team include their direct channels (`team_id: ''`) and, with
// `include_deleted`, the archived ones; `since` answers every post whose
// `update_at` is later, deletions included, at most 1000 rows in no stated
// order (`{ sinceLimit }` lowers the cap so a drive can meet it); a post
// carries its reactions and files under `metadata`. `POST /channels/direct`
// makes a direct channel and pushes `direct_added` to both people; a channel
// made by `POST /channels` pushes `channel_created` to its creator; a reaction
// added or removed is pushed to the channel. `POST /files` takes one file's
// bytes as the body with `channel_id` and `filename` in the query, a post's
// `file_ids` claim the caller's unclaimed uploads, and `GET /files/{id}`
// answers the bytes to a member of the post's channel or to the uploader;
// its `/preview` and `/thumbnail` are the same bytes, since no image is
// resized here.
//
// What a person has read is kept as the real one keeps it: a channel counts
// its posts and its root posts, a member what they have seen and been
// mentioned in of each, and a post's `mentions` (named, `@channel`, or the
// other side of a direct channel) ride its `posted` frame as a JSON string.
// `POST /channels/members/me/view` reads a channel and pushes
// `multiple_channels_viewed` to the reader; `PUT /channels/{id}/members/{user}
// /notify_props` mutes (`mark_unread: mention`) and pushes
// `channel_member_updated`. A reply makes its author, the root's author and
// whoever it mentions follow the thread, and each follower is pushed
// `thread_updated` with their own unread counts; `GET .../threads` lists a
// person's followed threads (`since`, `before`, `per_page`) and `PUT
// .../threads/{id}/read/{at}` reads one and pushes `thread_read_changed`.

import type { Channel, ChannelMember, FileInfo, Post, Reaction, Team, User, UserThread } from './src/types.ts'

export interface MattermostSinkOptions { port?: number }

const json   = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } })
const refuse = (status: number, id: string, message: string) => json({ id, message, detailed_error: '', request_id: mint('req'), status_code: status }, status)
let n = 0
const mint = (prefix: string) => `${prefix}${(++n).toString(36)}`.padEnd(26, '0')
const PENDING_WINDOW_MS = 30_000
const SINCE_LIMIT = 1000

interface SocketData { caller: string | null; seq: number; connectionId: string; authBy: 'header' | 'challenge' | null; silent?: boolean }

export function startMattermostSink(opts: MattermostSinkOptions = {}) {
  const now = () => Date.now()
  const users: Record<string, User> = {}
  const user = (username: string, extra: Partial<User> = {}): User => {
    const u: User = { id: mint(username), create_at: now(), update_at: now(), delete_at: 0, username, roles: 'system_user', email: `${username}@example.test`, ...extra }
    users[u.id] = u
    return u
  }
  const bot   = user('bot', { is_bot: true })
  const alice = user('alice', { first_name: 'Ada' })
  const bob   = user('bob')
  const tokens: Record<string, string> = { 'svc-token-dev': bot.id, 'alice-token-dev': alice.id, 'bob-token-dev': bob.id }

  const team: Team = { id: mint('team'), create_at: now(), update_at: now(), delete_at: 0, display_name: 'Town', name: 'town', description: '', type: 'O', allow_open_invite: true }
  const channels: Record<string, Channel> = {}
  const members:  ChannelMember[] = []
  const posts:    Record<string, Post> = {}
  const reactions: Reaction[] = []
  const files:    Record<string, { info: FileInfo; bytes: Uint8Array }> = {}
  const pending = new Map<string, { id: string; at: number }>()
  const channel = (name: string, type: Channel['type'], creator: string, who: string[]): Channel => {
    const c: Channel = { id: mint(name), create_at: now(), update_at: now(), delete_at: 0, team_id: team.id, type, display_name: name[0].toUpperCase() + name.slice(1), name, header: '', purpose: '', last_post_at: 0, total_msg_count: 0, total_msg_count_root: 0, last_root_post_at: 0, creator_id: creator }
    channels[c.id] = c
    for (const u of who) join(c.id, u)
    return c
  }
  function join(channel_id: string, user_id: string): ChannelMember {
    const m: ChannelMember = { channel_id, user_id, roles: 'channel_user', last_viewed_at: 0, msg_count: 0, mention_count: 0, msg_count_root: 0, mention_count_root: 0, notify_props: { mark_unread: 'all' }, last_update_at: now(), scheme_user: true, scheme_admin: false }
    members.push(m)
    return m
  }
  const isMember = (channel_id: string, user_id: string) => members.some(m => m.channel_id === channel_id && m.user_id === user_id)
  const memberOf = (channel_id: string, user_id: string) => members.find(m => m.channel_id === channel_id && m.user_id === user_id)
  // Who a post notifies, its author never: an @name in the channel, everyone on @channel/@all/@here, the other side of a direct channel.
  const mentionsIn = (c: Channel, message: string, author: string): string[] => {
    const inChannel = members.filter(m => m.channel_id === c.id && m.user_id !== author).map(m => m.user_id)
    if (c.type === 'D' || /(^|[^\w@])@(channel|all|here)\b/i.test(message)) return inChannel
    return inChannel.filter(u => new RegExp(`(^|[^\\w@])@${users[u].username}(?![\\w.-]*\\w)`, 'i').test(message))
  }
  // A person's view of a thread, by `user:root`.
  interface ThreadMember { following: boolean; last_viewed_at: number; unread_replies: number; unread_mentions: number; last_update_at: number }
  const threadMembers = new Map<string, ThreadMember>()
  const threadOf = (user: string, rootId: string): UserThread => {
    const tm = threadMembers.get(`${user}:${rootId}`)!, root = posts[rootId]
    return { id: rootId, reply_count: root.reply_count ?? 0, last_reply_at: root.last_reply_at ?? 0, last_viewed_at: tm.last_viewed_at, participants: [], post: withMetadata(root), unread_replies: tm.unread_replies, unread_mentions: tm.unread_mentions, is_following: tm.following, delete_at: root.delete_at }
  }
  const withMetadata = (p: Post): Post => {
    const rs = reactions.filter(r => r.post_id === p.id)
    return { ...p, metadata: { ...(rs.length ? { reactions: rs } : {}), files: Object.values(files).filter(f => f.info.post_id === p.id).map(f => f.info) } }
  }
  const open    = channel('general', 'O', bot.id, [bot.id, alice.id, bob.id])
  const secret  = channel('ops', 'P', alice.id, [alice.id])

  const seen: { method: string; path: string; headers: Record<string, string>; body: string; status: number }[] = []
  const armed = { lost: false, failNext: false, rateLimit: null as null | { reset: number }, deliverTwice: false, socketHeader: true, frameTwice: false, sinceLimit: SINCE_LIMIT }
  const hanging: Array<() => void> = []

  // ─── The socket ────────────────────────────────────────────
  type Sock = import('bun').ServerWebSocket<SocketData>
  const sockets = new Set<Sock>()
  const socketLog: { connectionId: string; user: string | null; authBy: string | null; frames: number; pings: number; open: boolean }[] = []
  const frame = (ws: Sock, f: Record<string, unknown>) => {
    if (ws.data.silent) return
    const text = JSON.stringify({ ...f, seq: ws.data.seq++ })
    ws.send(text)
    if (armed.frameTwice && f.event !== 'hello') { armed.frameTwice = false; ws.send(text) }
    const row = socketLog.find(r => r.connectionId === ws.data.connectionId)
    if (row) row.frames++
  }
  const hello = (ws: Sock) => frame(ws, { event: 'hello', data: { server_version: '10.0.0.sink', connection_id: ws.data.connectionId }, broadcast: { user_id: ws.data.caller } })
  // To every authenticated connection whose user may see it: a channel's members, or the one user named.
  function emit(event: string, data: Record<string, unknown>, to: { channel_id?: string; user_id?: string; team_id?: string }) {
    for (const ws of sockets) {
      const u = ws.data.caller
      if (!u) continue
      if (to.channel_id ? !isMember(to.channel_id, u) && to.user_id !== u : to.user_id && to.user_id !== u) continue
      frame(ws, { event, data, broadcast: { omit_users: null, user_id: to.user_id ?? '', channel_id: to.channel_id ?? '', team_id: to.team_id ?? '' } })
    }
  }
  const posted = (event: 'posted' | 'post_edited' | 'post_deleted', p: Post, mentions: string[] = []) => {
    const c = channels[p.channel_id]
    emit(event, event === 'posted'
      ? { channel_display_name: c.display_name, channel_name: c.name, channel_type: c.type, post: JSON.stringify(withMetadata(p)), sender_name: `@${users[p.user_id]?.username ?? ''}`, team_id: team.id, ...(mentions.length ? { mentions: JSON.stringify(mentions) } : {}) }
      : { post: JSON.stringify(p) }, { channel_id: p.channel_id })
  }
  // A new post as the counts see it: the channel's totals move, the author has
  // seen their own, and each person it mentions is owed one more.
  function count(c: Channel, p: Post, mentions: string[]) {
    c.last_post_at = p.create_at; c.total_msg_count++
    if (!p.root_id) { c.total_msg_count_root = (c.total_msg_count_root ?? 0) + 1; c.last_root_post_at = p.create_at }
    for (const m of members.filter(x => x.channel_id === c.id)) {
      if (m.user_id === p.user_id) { m.msg_count = c.total_msg_count; m.msg_count_root = c.total_msg_count_root; m.last_viewed_at = p.create_at }
      else if (mentions.includes(m.user_id)) { m.mention_count++; if (!p.root_id) m.mention_count_root = (m.mention_count_root ?? 0) + 1 }
    }
  }
  // A reply: the root's count moves, its author, the replier and those named follow, and each follower hears of it.
  function replied(p: Post, mentions: string[]) {
    const root = posts[p.root_id]
    if (!root) return
    root.reply_count = (root.reply_count ?? 0) + 1; root.last_reply_at = p.create_at
    for (const u of new Set([root.user_id, p.user_id, ...mentions])) {
      const key = `${u}:${root.id}`
      const tm = threadMembers.get(key) ?? { following: true, last_viewed_at: 0, unread_replies: 0, unread_mentions: 0, last_update_at: 0 }
      if (u === p.user_id || mentions.includes(u)) tm.following = true
      if (!tm.following) continue
      if (u === p.user_id) Object.assign(tm, { last_viewed_at: p.create_at, unread_replies: 0, unread_mentions: 0 })
      else { tm.unread_replies++; if (mentions.includes(u)) tm.unread_mentions++ }
      tm.last_update_at = p.create_at
      threadMembers.set(key, tm)
      emit('thread_updated', { thread: JSON.stringify(threadOf(u, root.id)) }, { user_id: u, team_id: team.id })
    }
  }

  // ─── What Mattermost delivers ──────────────────────────────
  interface OutgoingHook { id: string; token: string; channel_id: string; team_id: string; trigger_words: string[]; callback_urls: string[]; content_type: string; display_name: string; create_at: number; update_at: number; delete_at: 0; creator_id: string; trigger_when: 0; description: ''; username: ''; icon_url: '' }
  interface Command { id: string; token: string; team_id: string; trigger: string; url: string; method: 'P' | 'G'; display_name: string; create_at: number; update_at: number; delete_at: 0; creator_id: string; auto_complete: false; description: ''; username: ''; icon_url: '' }
  const hooks:    OutgoingHook[] = []
  const commands: Command[] = []
  const responseUrls = new Map<string, { user_id: string; channel_id: string; uses: number; expires: number }>()
  const deliveries: { kind: 'webhook' | 'command'; url: string; contentType: string; headers: Record<string, string>; body: string; status: number | null; answered: unknown }[] = []
  const replies:    { via: 'response' | 'response_url'; kind: 'webhook' | 'command'; response_type: string; text: string; user_id?: string; channel_id: string }[] = []
  const RESPONSE_URL_USES = 5, RESPONSE_URL_TTL_MS = 30 * 60_000

  const encode = (contentType: string, payload: Record<string, string | number>) =>
    contentType === 'application/json' ? JSON.stringify(payload) : new URLSearchParams(Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v)]))).toString()
  async function deliver(kind: 'webhook' | 'command', url: string, contentType: string, token: string, payload: Record<string, string | number>) {
    const times = armed.deliverTwice ? 2 : 1; armed.deliverTwice = false
    let last: { status: number | null; answered: unknown } = { status: null, answered: null }
    for (let i = 0; i < times; i++) {
      const headers = { 'content-type': contentType, accept: 'application/json', authorization: `Token ${token}`, 'user-agent': 'Mattermost-Bot/1.1' }
      const entry = { kind, url, contentType, headers, body: encode(contentType, payload), status: null as number | null, answered: null as unknown }
      deliveries.push(entry)
      try {
        const res = await fetch(url, { method: 'POST', headers, body: entry.body })
        entry.status = res.status
        const text = await res.text()
        if (res.status === 200 && (res.headers.get('content-type') ?? '').includes('json')) { try { entry.answered = JSON.parse(text) } catch { entry.answered = null } }
      } catch { /* an unreachable callback: Mattermost logs it and drops the delivery */ }
      last = { status: entry.status, answered: entry.answered }
    }
    return last
  }
  function fireHooks(p: Post): Promise<unknown>[] {
    if ((p.props as Record<string, unknown> | undefined)?.from_webhook) return []
    const first = p.message.trim().split(/\s+/)[0] ?? ''
    const c = channels[p.channel_id], u = users[p.user_id]
    const out: Promise<unknown>[] = []
    for (const h of hooks) {
      if (h.channel_id !== p.channel_id) continue
      const word = h.trigger_words.length ? h.trigger_words.find(w => w === first) : ''
      if (word === undefined) continue
      const payload = { token: h.token, team_id: team.id, team_domain: team.name, channel_id: c.id, channel_name: c.name, timestamp: p.create_at, user_id: u.id, user_name: u.username, post_id: p.id, text: p.message, trigger_word: word, file_ids: '' }
      for (const url of h.callback_urls) out.push(deliver('webhook', url, h.content_type, h.token, payload).then(({ answered }) => {
        const a = answered as { text?: string; response_type?: string } | null
        if (!a?.text) return
        const t = now()
        const reply: Post = { id: mint('post'), create_at: t, update_at: t, edit_at: 0, delete_at: 0, is_pinned: false, user_id: h.creator_id, channel_id: c.id, root_id: a.response_type === 'comment' ? (p.root_id || p.id) : '', original_id: '', message: a.text, type: '', props: { from_webhook: 'true', webhook_display_name: h.display_name }, hashtags: '', pending_post_id: '', reply_count: 0, last_reply_at: 0, metadata: {} }
        posts[reply.id] = reply
        posted('posted', reply)
        replies.push({ via: 'response', kind: 'webhook', response_type: a.response_type ?? '', text: a.text, channel_id: c.id })
      }))
    }
    return out
  }

  const server = Bun.serve<SocketData, never>({
    port: opts.port ?? 0,
    websocket: {
      open(ws) {
        sockets.add(ws)
        socketLog.push({ connectionId: ws.data.connectionId, user: ws.data.caller, authBy: ws.data.authBy, frames: 0, pings: 0, open: true })
        if (ws.data.caller) hello(ws)
      },
      close(ws) {
        sockets.delete(ws)
        const row = socketLog.find(r => r.connectionId === ws.data.connectionId)
        if (row) row.open = false
      },
      message(ws, raw) {
        let m: { seq?: number; action?: string; data?: { token?: unknown } } = {}
        try { m = JSON.parse(String(raw)) } catch { return }
        if (m.action === 'ping' && ws.data.caller && !ws.data.silent) {
          const row = socketLog.find(r => r.connectionId === ws.data.connectionId)
          if (row) row.pings++
          ws.send(JSON.stringify({ status: 'OK', seq_reply: m.seq, data: { text: 'pong', version: '10.0.0.sink', server_time: now(), node_id: '' } }))
          return
        }
        if (m.action !== 'authentication_challenge') return
        // An authenticated connection ignores a second challenge and answers nothing.
        if (ws.data.caller) return
        const caller = tokens[String(m.data?.token ?? '')]
        if (!caller) { ws.send(JSON.stringify({ status: 'FAIL', seq_reply: m.seq, error: { id: 'api.web_socket_router.not_authenticated.app_error', message: 'Not authenticated' } })); return }
        ws.data.caller = caller; ws.data.authBy = 'challenge'
        const row = socketLog.find(r => r.connectionId === ws.data.connectionId)
        if (row) { row.user = caller; row.authBy = 'challenge' }
        ws.send(JSON.stringify({ status: 'OK', seq_reply: m.seq }))
        hello(ws)
      },
    },
    async fetch(req, srv) {
      const url = new URL(req.url), path = url.pathname
      if (path === '/api/v4/websocket') {
        const h = req.headers.get('authorization') ?? ''
        const caller = armed.socketHeader && h.startsWith('Bearer ') ? tokens[h.slice(7)] ?? null : null
        return srv.upgrade(req, { data: { caller, seq: 0, connectionId: mint('conn'), authBy: caller ? 'header' : null } })
          ? undefined
          : refuse(400, 'api.web_socket.connect.upgrade.app_error', 'Failed to upgrade websocket connection')
      }
      if (path === '/_sink/socket' && req.method === 'POST') {
        const b = await req.json() as { event?: string; data?: Record<string, unknown>; broadcast?: Record<string, unknown>; raw?: string }
        for (const ws of sockets) if (ws.data.caller) b.raw !== undefined ? ws.send(b.raw) : frame(ws, { event: b.event, data: b.data ?? {}, broadcast: b.broadcast ?? {} })
        return json({ ok: true })
      }
      if (path === '/_sink/seen')  return json({ requests: seen, posts: Object.values(posts).length, reactions: reactions.length, members: members.length, deliveries, replies, allPosts: Object.values(posts), sockets: socketLog })
      if (path === '/_sink/reset') { seen.length = 0; deliveries.length = 0; replies.length = 0; Object.assign(armed, { lost: false, failNext: false, rateLimit: null, deliverTwice: false, socketHeader: true, frameTwice: false, sinceLimit: SINCE_LIMIT }); return json({ ok: true }) }
      if (path === '/_sink/arm')   {
        const { dropSockets, silenceSocket, skipSeq, ...rest } = await req.json() as { dropSockets?: boolean; silenceSocket?: string; skipSeq?: number } & Record<string, unknown>
        Object.assign(armed, rest)
        if (dropSockets) for (const ws of sockets) ws.close(1001, 'going away')
        if (silenceSocket) for (const ws of sockets) if (ws.data.connectionId === silenceSocket) ws.data.silent = true
        if (skipSeq) for (const ws of sockets) ws.data.seq += skipSeq
        return json({ ok: true })
      }
      if (path === '/_sink/seed')  return json({ team: team.id, open: open.id, secret: secret.id, bot: bot.id, alice: alice.id, bob: bob.id })

      const raw = new Uint8Array(await req.arrayBuffer()), text = new TextDecoder().decode(raw)
      const entry = { method: req.method, path, headers: Object.fromEntries(req.headers), body: text, status: 0 }; seen.push(entry)
      const record = async (r: Response) => { if (armed.lost) { armed.lost = false; await new Promise<void>(res => hanging.push(res)) } entry.status = r.status; return r }

      // A command's response URL: unauthenticated, on this origin, five uses inside 30 minutes.
      let hookMatch: RegExpMatchArray | null
      if ((hookMatch = path.match(/^\/hooks\/commands\/([a-z0-9]{26})$/)) && req.method === 'POST') {
        const slot = responseUrls.get(hookMatch[1])
        if (!slot || slot.uses >= RESPONSE_URL_USES || now() > slot.expires) return record(refuse(404, 'api.command.command_response_url.invalid.app_error', 'Invalid or expired response URL'))
        slot.uses++
        let b: { text?: string; response_type?: string } = {}
        try { b = JSON.parse(text) } catch { b = { text } }
        if (!b.text) return record(refuse(400, 'api.command.command_response_url.empty.app_error', 'Response has no text'))
        replies.push({ via: 'response_url', kind: 'command', response_type: b.response_type || 'ephemeral', text: b.text, user_id: slot.user_id, channel_id: slot.channel_id })
        return record(json({ status: 'OK' }))
      }

      const auth = req.headers.get('authorization') ?? ''
      const caller = auth.startsWith('Bearer ') ? tokens[auth.slice(7)] : undefined
      if (!caller) return record(refuse(401, 'api.context.session_expired.app_error', 'Invalid or expired session, please login again.'))
      if (armed.rateLimit) { const { reset } = armed.rateLimit; armed.rateLimit = null; return record(new Response('You have reached the maximum number of requests.', { status: 429, headers: { 'content-type': 'text/plain', 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } })) }
      if (armed.failNext) { armed.failNext = false; return record(refuse(500, 'api.context.500.app_error', 'Internal server error')) }

      let x0: RegExpMatchArray | null
      if (path === '/api/v4/files' && req.method === 'POST') {
        const channel_id = url.searchParams.get('channel_id') ?? '', name = url.searchParams.get('filename') ?? ''
        if (!channels[channel_id] || !isMember(channel_id, caller)) return record(refuse(403, 'api.context.permissions.app_error', 'You do not have the appropriate permissions.'))
        if (!name || !raw.byteLength) return record(refuse(400, 'api.file.upload_file.incorrect_number_of_files.app_error', 'Unable to upload files. Incorrect number of files specified.'))
        const mime = (req.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim()
        const t = now(), dot = name.lastIndexOf('.')
        const info: FileInfo = { id: mint('file'), user_id: caller, post_id: '', create_at: t, update_at: t, delete_at: 0, name, extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : '', size: raw.byteLength, mime_type: mime, has_preview_image: mime.startsWith('image/') }
        files[info.id] = { info, bytes: raw }
        return record(json({ file_infos: [info], client_ids: [] }, 201))
      }
      if ((x0 = path.match(/^\/api\/v4\/files\/([a-z0-9]{26})(?:\/(preview|thumbnail))?$/)) && req.method === 'GET') {
        const f = files[x0[1]]
        const post = f?.info.post_id ? posts[f.info.post_id] : undefined
        if (!f || f.info.delete_at || (post && post.delete_at)) return record(refuse(404, 'app.file_info.get.app_error', 'Unable to find the file.'))
        if (f.info.user_id !== caller && !(post && isMember(post.channel_id, caller))) return record(refuse(403, 'api.context.permissions.app_error', 'You do not have the appropriate permissions.'))
        if (x0[2] && !f.info.has_preview_image) return record(refuse(400, 'api.file.get_file_preview.no_preview.app_error', 'File doesn\'t have a preview image.'))
        return record(new Response(f.bytes, { headers: { 'content-type': f.info.mime_type } }))
      }

      let body: Record<string, unknown> = {}
      if (text) { try { body = JSON.parse(text) } catch { return record(refuse(400, 'api.context.invalid_body.app_error', 'Invalid or missing body in request')) } }
      const m = (re: RegExp) => path.match(re)
      let x: RegExpMatchArray | null

      if (path === '/api/v4/users/me') return record(json(users[caller]))
      if ((x = m(/^\/api\/v4\/users\/([a-z0-9]{26})\/teams$/)))
        return record(json(users[x[1]] ? [team] : []))
      if ((x = m(/^\/api\/v4\/users\/([a-z0-9]{26})\/teams\/([a-z0-9]{26})\/channels$/))) {
        const deleted = url.searchParams.get('include_deleted') === 'true'
        return record(json(Object.values(channels).filter(c => (deleted || !c.delete_at) && (c.team_id === x![2] || c.team_id === '') && isMember(c.id, x![1]))))
      }
      if (path === '/api/v4/users/ids' && req.method === 'POST') {
        const asked = Array.isArray(body) ? body as unknown[] : []
        return record(json(asked.map(id => users[String(id)]).filter(Boolean)))
      }
      if (path === '/api/v4/channels/direct' && req.method === 'POST') {
        const pair = Array.isArray(body) ? (body as unknown[]).map(String) : []
        if (pair.length !== 2 || !pair.every(u => users[u]) || !pair.includes(caller)) return record(refuse(400, 'api.context.invalid_body_param.app_error', 'Invalid or missing user_ids in request body.'))
        const name = [...pair].sort().join('__')
        const had = Object.values(channels).find(c => c.type === 'D' && c.name === name)
        if (had) return record(json(had, 201))
        const c: Channel = { id: mint('dm'), create_at: now(), update_at: now(), delete_at: 0, team_id: '', type: 'D', display_name: '', name, header: '', purpose: '', last_post_at: 0, total_msg_count: 0, total_msg_count_root: 0, last_root_post_at: 0, creator_id: caller }
        channels[c.id] = c
        for (const u of new Set(pair)) join(c.id, u)
        emit('direct_added', { creator_id: caller, teammate_id: pair.find(v => v !== caller) ?? caller }, { channel_id: c.id })
        return record(json(c, 201))
      }
      if ((x = m(/^\/api\/v4\/channels\/([a-z0-9]{26})\/members$/)) && req.method === 'GET')
        return record(json(members.filter(mm => mm.channel_id === x![1])))
      if ((x = m(/^\/api\/v4\/channels\/([a-z0-9]{26})\/members$/)) && req.method === 'POST') {
        const c = channels[x[1]]
        if (!c || !isMember(c.id, caller)) return record(refuse(403, 'api.context.permissions.app_error', 'You do not have the appropriate permissions.'))
        const uid = String(body.user_id ?? '')
        if (!users[uid]) return record(refuse(400, 'model.channel_member.is_valid.user_id.app_error', 'Invalid user id.'))
        const had = members.find(mm => mm.channel_id === c.id && mm.user_id === uid)
        if (had) return record(json(had, 201))
        const added = join(c.id, uid)
        emit('user_added', { team_id: team.id, user_id: uid }, { channel_id: c.id })
        return record(json(added, 201))
      }
      if ((x = m(/^\/api\/v4\/channels\/([a-z0-9]{26})\/members\/([a-z0-9]{26})$/)) && req.method === 'DELETE') {
        if (!isMember(x[1], caller)) return record(refuse(403, 'api.context.permissions.app_error', 'You do not have the appropriate permissions.'))
        const i = members.findIndex(mm => mm.channel_id === x![1] && mm.user_id === x![2])
        if (i < 0) return record(refuse(404, 'app.channel.get_member.missing.app_error', 'No channel member found for that user ID and channel ID'))
        members.splice(i, 1)
        // The others are told on the channel; the removed user, no longer a member, by name.
        emit('user_removed', { remover_id: caller, user_id: x[2] }, { channel_id: x[1] })
        emit('user_removed', { channel_id: x[1], remover_id: caller }, { user_id: x[2] })
        return record(json({ status: 'OK' }))
      }
      if ((x = m(/^\/api\/v4\/channels\/([a-z0-9]{26})\/posts$/))) {
        const c = channels[x[1]]
        if (!c || !isMember(c.id, caller)) return record(refuse(403, 'api.context.permissions.app_error', 'You do not have the appropriate permissions.'))
        const since = Number(url.searchParams.get('since') ?? 0)
        const perPage = Number(url.searchParams.get('per_page') ?? 60), page = Number(url.searchParams.get('page') ?? 0)
        let list = Object.values(posts).filter(p => p.channel_id === c.id && (since ? p.update_at > since : !p.delete_at))
        // The real `since` query takes its LIMIT inside a CTE with no ORDER BY,
        // so which rows a capped answer holds is unstated: the most recently
        // changed here, which loses the oldest of the gap as the real one may.
        if (since) list = list.sort((a, b) => b.update_at - a.update_at).slice(0, armed.sinceLimit)
        list.sort((a, b) => b.create_at - a.create_at)
        if (!since) list = list.slice(page * perPage, (page + 1) * perPage)
        return record(json({ order: list.map(p => p.id), posts: Object.fromEntries(list.map(p => [p.id, withMetadata(p)])), next_post_id: '', prev_post_id: '' }))
      }
      if (path === '/api/v4/posts' && req.method === 'POST') {
        const channel_id = String(body.channel_id ?? ''), message = String(body.message ?? ''), root_id = String(body.root_id ?? ''), pid = body.pending_post_id ? String(body.pending_post_id) : ''
        const c = channels[channel_id]
        if (!c || c.delete_at || !isMember(c.id, caller)) return record(refuse(403, 'api.context.permissions.app_error', 'You do not have the appropriate permissions.'))
        const fileIds = Array.isArray(body.file_ids) ? (body.file_ids as unknown[]).map(String) : []
        if (fileIds.some(id => !files[id] || files[id].info.user_id !== caller || files[id].info.post_id)) return record(refuse(400, 'api.post.create_post.file_ids.app_error', 'A file is not one you uploaded, or it is already attached to a post.'))
        if (!message && !fileIds.length) return record(refuse(400, 'api.post.create_post.app_error', 'Invalid or missing post in request body'))
        if (root_id && !posts[root_id]) return record(refuse(400, 'api.post.create_post.channel_root_id.app_error', 'Invalid RootId parameter'))
        const hit = pid ? pending.get(`${caller}:${pid}`) : undefined
        if (hit && now() - hit.at < PENDING_WINDOW_MS) return record(json(posts[hit.id], 201))
        const t = now()
        const p: Post = { id: mint('post'), create_at: t, update_at: t, edit_at: 0, delete_at: 0, is_pinned: false, user_id: caller, channel_id, root_id, original_id: '', message, type: '', props: (body.props as Record<string, unknown>) ?? {}, hashtags: '', pending_post_id: pid, reply_count: 0, last_reply_at: 0, ...(fileIds.length ? { file_ids: fileIds } : {}), metadata: {} }
        posts[p.id] = p
        for (const id of fileIds) Object.assign(files[id].info, { post_id: p.id, update_at: t })
        if (pid) pending.set(`${caller}:${pid}`, { id: p.id, at: t })
        const mentions = mentionsIn(c, message, caller)
        count(c, p, mentions)
        if (root_id) replied(p, mentions)
        posted('posted', p, mentions)
        // Mattermost fires a hook on its own goroutine; the sink waits for it so a drive reads the outcome in order.
        await Promise.all(fireHooks(p))
        return record(json(withMetadata(p), 201))
      }
      if (path === '/api/v4/hooks/outgoing' && req.method === 'POST') {
        const channel_id = String(body.channel_id ?? ''), words = Array.isArray(body.trigger_words) ? body.trigger_words.map(String) : [], urls = Array.isArray(body.callback_urls) ? body.callback_urls.map(String) : []
        if (!channels[channel_id]) return record(refuse(400, 'model.outgoing_hook.is_valid.channel_id.app_error', 'Invalid channel id'))
        if (!urls.length || urls.some(u => !/^https?:\/\//.test(u))) return record(refuse(400, 'model.outgoing_hook.is_valid.callback.app_error', 'Invalid callback URLs'))
        const content_type = String(body.content_type ?? 'application/x-www-form-urlencoded')
        if (content_type !== 'application/json' && content_type !== 'application/x-www-form-urlencoded') return record(refuse(400, 'model.outgoing_hook.is_valid.content_type.app_error', 'Invalid content type'))
        const h: OutgoingHook = { id: mint('hook'), token: mint('tok'), channel_id, team_id: team.id, trigger_words: words, callback_urls: urls, content_type, display_name: String(body.display_name ?? ''), create_at: now(), update_at: now(), delete_at: 0, creator_id: caller, trigger_when: 0, description: '', username: '', icon_url: '' }
        hooks.push(h)
        return record(json(h, 201))
      }
      if (path === '/api/v4/commands' && req.method === 'POST') {
        const trigger = String(body.trigger ?? ''), url = String(body.url ?? ''), method = body.method === 'G' ? 'G' : 'P'
        if (!/^[a-z0-9_-]+$/.test(trigger)) return record(refuse(400, 'model.command.is_valid.trigger.app_error', 'Invalid trigger'))
        if (commands.some(k => k.trigger === trigger)) return record(refuse(400, 'api.command.duplicate_trigger.app_error', 'This trigger word is already in use. Please choose another word.'))
        if (!/^https?:\/\//.test(url)) return record(refuse(400, 'model.command.is_valid.url_http.app_error', 'Invalid URL. Must be a valid URL and start with http:// or https://'))
        const k: Command = { id: mint('cmd'), token: mint('tok'), team_id: team.id, trigger, url, method, display_name: String(body.display_name ?? trigger), create_at: now(), update_at: now(), delete_at: 0, creator_id: caller, auto_complete: false, description: '', username: '', icon_url: '' }
        commands.push(k)
        return record(json(k, 201))
      }
      if (path === '/api/v4/commands/execute' && req.method === 'POST') {
        const channel_id = String(body.channel_id ?? ''), line = String(body.command ?? '').trim()
        const c = channels[channel_id], u = users[caller]
        if (!c || !isMember(c.id, caller)) return record(refuse(403, 'api.context.permissions.app_error', 'You do not have the appropriate permissions.'))
        const [trigger, ...rest] = line.replace(/^\//, '').split(/\s+/)
        const k = commands.find(x => x.trigger === trigger)
        if (!k) return record(refuse(404, 'api.command.execute_command.not_found.app_error', `Command with a trigger of '${trigger}' not found`))
        if (k.method !== 'P') return record(refuse(500, 'api.command.execute_command.failed.app_error', `Command with a trigger of '${trigger}' failed: the sink delivers POST only`))
        const hookId = mint('rurl')
        responseUrls.set(hookId, { user_id: caller, channel_id: c.id, uses: 0, expires: now() + RESPONSE_URL_TTL_MS })
        const payload = { token: k.token, team_id: team.id, team_domain: team.name, channel_id: c.id, channel_name: c.name, user_id: u.id, user_name: u.username, command: `/${trigger}`, text: rest.join(' '), response_url: `http://127.0.0.1:${server.port}/hooks/commands/${hookId}`, trigger_id: mint('trig') }
        const { status, answered } = await deliver('command', k.url, 'application/x-www-form-urlencoded', k.token, payload)
        if (status !== 200) return record(refuse(500, 'api.command.execute_command.failed_resp.app_error', `Command with a trigger of '/${trigger}' returned response ${status ?? 'none'}`))
        const a = (answered ?? {}) as { text?: string; response_type?: string }
        if (a.text) replies.push({ via: 'response', kind: 'command', response_type: a.response_type || 'ephemeral', text: a.text, user_id: caller, channel_id: c.id })
        return record(json(a))
      }
      if ((x = m(/^\/api\/v4\/posts\/([a-z0-9]{26})\/patch$/)) && req.method === 'PUT') {
        const p = posts[x[1]]
        if (!p || p.delete_at) return record(refuse(404, 'app.post.get.app_error', 'Unable to get the post.'))
        if (p.user_id !== caller) return record(refuse(403, 'api.context.permissions.app_error', 'You do not have the appropriate permissions.'))
        const t = now()
        if (typeof body.message === 'string' && body.message !== p.message) { p.message = body.message; p.edit_at = t }
        if (typeof body.is_pinned === 'boolean') p.is_pinned = body.is_pinned
        if (body.props && typeof body.props === 'object') p.props = body.props as Record<string, unknown>
        p.update_at = t
        posted('post_edited', p)
        return record(json(p))
      }
      if ((x = m(/^\/api\/v4\/posts\/([a-z0-9]{26})$/)) && req.method === 'DELETE') {
        const p = posts[x[1]]
        if (!p || p.delete_at) return record(refuse(404, 'app.post.get.app_error', 'Unable to get the post.'))
        if (p.user_id !== caller) return record(refuse(403, 'api.context.permissions.app_error', 'You do not have the appropriate permissions.'))
        p.delete_at = now(); p.update_at = p.delete_at
        posted('post_deleted', p)
        return record(json({ status: 'OK' }))
      }
      if (path === '/api/v4/reactions' && req.method === 'POST') {
        const post_id = String(body.post_id ?? ''), user_id = String(body.user_id ?? ''), emoji_name = String(body.emoji_name ?? '')
        if (user_id !== caller) return record(refuse(403, 'api.context.permissions.app_error', 'You do not have the appropriate permissions.'))
        const p = posts[post_id]
        if (!p || p.delete_at) return record(refuse(404, 'app.post.get.app_error', 'Unable to get the post.'))
        if (!emoji_name) return record(refuse(400, 'model.reaction.is_valid.emoji_name.app_error', 'Invalid emoji name.'))
        const had = reactions.find(r => r.user_id === user_id && r.post_id === post_id && r.emoji_name === emoji_name)
        if (had) return record(json(had))
        const r: Reaction = { user_id, post_id, emoji_name, create_at: now() }
        reactions.push(r)
        p.update_at = now()
        emit('reaction_added', { reaction: JSON.stringify(r) }, { channel_id: p.channel_id })
        return record(json(r))
      }
      if ((x = m(/^\/api\/v4\/users\/([a-z0-9]{26})\/posts\/([a-z0-9]{26})\/reactions\/([^/]+)$/)) && req.method === 'DELETE') {
        if (x[1] !== caller) return record(refuse(403, 'api.context.permissions.app_error', 'You do not have the appropriate permissions.'))
        const i = reactions.findIndex(r => r.user_id === x![1] && r.post_id === x![2] && r.emoji_name === decodeURIComponent(x![3]))
        if (i < 0) return record(refuse(404, 'app.reaction.get.app_error', 'Unable to get the reaction.'))
        const [gone] = reactions.splice(i, 1)
        const p = posts[gone.post_id]
        if (p) { p.update_at = now(); emit('reaction_removed', { reaction: JSON.stringify(gone) }, { channel_id: p.channel_id }) }
        return record(json({ status: 'OK' }))
      }
      if (path === '/api/v4/channels' && req.method === 'POST') {
        const name = String(body.name ?? ''), type = String(body.type ?? '')
        if (body.team_id !== team.id) return record(refuse(403, 'api.context.permissions.app_error', 'You do not have the appropriate permissions.'))
        if (!/^[a-z0-9-]{2,64}$/.test(name)) return record(refuse(400, 'model.channel.is_valid.2_or_more.app_error', 'Name must be 2 or more lowercase alphanumeric characters'))
        if (Object.values(channels).some(c => c.name === name && !c.delete_at)) return record(refuse(400, 'store.sql_channel.save_channel.exists.app_error', 'A channel with that name already exists on the same team'))
        if (type !== 'O' && type !== 'P') return record(refuse(400, 'model.channel.is_valid.type.app_error', 'Invalid type'))
        const c = channel(name, type, caller, [caller])
        c.display_name = String(body.display_name ?? name); c.purpose = String(body.purpose ?? ''); c.header = String(body.header ?? '')
        emit('channel_created', { channel_id: c.id, team_id: team.id }, { user_id: caller })
        return record(json(c, 201))
      }
      if ((x = m(/^\/api\/v4\/channels\/([a-z0-9]{26})\/patch$/)) && req.method === 'PUT') {
        const c = channels[x[1]]
        if (!c || c.delete_at) return record(refuse(404, 'app.channel.get.existing.app_error', 'Unable to find the existing channel'))
        if (!isMember(c.id, caller)) return record(refuse(403, 'api.context.permissions.app_error', 'You do not have the appropriate permissions.'))
        if (typeof body.name === 'string') c.name = body.name
        if (typeof body.display_name === 'string') c.display_name = body.display_name
        if (typeof body.purpose === 'string') c.purpose = body.purpose
        if (typeof body.header === 'string') c.header = body.header
        c.update_at = now()
        emit('channel_updated', { channel: JSON.stringify(c) }, { channel_id: c.id })
        return record(json(c))
      }
      if ((x = m(/^\/api\/v4\/channels\/([a-z0-9]{26})$/)) && req.method === 'DELETE') {
        const c = channels[x[1]]
        if (!c || c.delete_at) return record(refuse(404, 'app.channel.get.existing.app_error', 'Unable to find the existing channel'))
        if (!isMember(c.id, caller)) return record(refuse(403, 'api.context.permissions.app_error', 'You do not have the appropriate permissions.'))
        c.delete_at = now(); c.update_at = c.delete_at
        emit('channel_deleted', { channel_id: c.id, delete_at: c.delete_at }, { channel_id: c.id })
        return record(json({ status: 'OK' }))
      }
      if (path === '/api/v4/channels/members/me/view' && req.method === 'POST') {
        const t = now(), times: Record<string, number> = {}
        for (const id of [String(body.channel_id ?? ''), String(body.prev_channel_id ?? '')]) {
          const c = channels[id], mm = c && memberOf(id, caller)
          if (!mm) continue
          Object.assign(mm, { msg_count: c.total_msg_count, msg_count_root: c.total_msg_count_root, mention_count: 0, mention_count_root: 0, last_viewed_at: t, last_update_at: t })
          times[id] = t
        }
        if (Object.keys(times).length) emit('multiple_channels_viewed', { channel_times: times }, { user_id: caller })
        return record(json({ status: 'OK', last_viewed_at_times: times }))
      }
      if ((x = m(/^\/api\/v4\/channels\/([a-z0-9]{26})\/members\/([a-z0-9]{26})\/notify_props$/)) && req.method === 'PUT') {
        if (x[2] !== caller) return record(refuse(403, 'api.context.permissions.app_error', 'You do not have the appropriate permissions.'))
        const mm = memberOf(x[1], caller)
        if (!mm) return record(refuse(404, 'app.channel.get_member.missing.app_error', 'No channel member found for that user ID and channel ID'))
        mm.notify_props = { ...mm.notify_props, ...Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)])) }
        mm.last_update_at = now()
        emit('channel_member_updated', { channelMember: JSON.stringify(mm) }, { user_id: caller })
        return record(json({ status: 'OK' }))
      }
      if ((x = m(/^\/api\/v4\/users\/([a-z0-9]{26})\/teams\/([a-z0-9]{26})\/threads$/)) && req.method === 'GET') {
        if (x[1] !== caller) return record(refuse(403, 'api.context.permissions.app_error', 'You do not have the appropriate permissions.'))
        const since = Number(url.searchParams.get('since') ?? 0), before = url.searchParams.get('before') ?? '', perPage = Number(url.searchParams.get('per_page') ?? 25)
        let mine = [...threadMembers.entries()].filter(([k, tm]) => k.startsWith(`${caller}:`) && tm.following && (!since || tm.last_update_at > since)).map(([k]) => threadOf(caller, k.split(':')[1]))
        mine.sort((a, b) => b.last_reply_at - a.last_reply_at || (a.id < b.id ? 1 : -1))
        if (before) mine = mine.slice(mine.findIndex(t => t.id === before) + 1)
        const page = mine.slice(0, perPage)
        return record(json({ total: mine.length, total_unread_threads: mine.filter(t => t.unread_replies).length, total_unread_mentions: mine.reduce((n, t) => n + t.unread_mentions, 0), threads: page }))
      }
      if ((x = m(/^\/api\/v4\/users\/([a-z0-9]{26})\/teams\/([a-z0-9]{26})\/threads\/([a-z0-9]{26})(?:\/read\/(\d+))?$/))) {
        if (x[1] !== caller) return record(refuse(403, 'api.context.permissions.app_error', 'You do not have the appropriate permissions.'))
        const tm = threadMembers.get(`${caller}:${x[3]}`)
        if (!tm || !posts[x[3]]) return record(refuse(404, 'app.thread.get_thread_membership.app_error', 'Unable to get thread membership.'))
        if (req.method === 'PUT' && x[4]) {
          const at = Number(x[4]), root = posts[x[3]]
          tm.last_viewed_at = at; tm.last_update_at = now()
          tm.unread_replies = Object.values(posts).filter(p => p.root_id === root.id && p.user_id !== caller && p.create_at > at && !p.delete_at).length
          if (!tm.unread_replies) tm.unread_mentions = 0
          emit('thread_read_changed', { thread_id: root.id, timestamp: at, unread_replies: tm.unread_replies, unread_mentions: tm.unread_mentions, channel_id: root.channel_id }, { user_id: caller, team_id: x[2] })
          return record(json(threadOf(caller, root.id)))
        }
        if (req.method === 'GET') return record(json(threadOf(caller, x[3])))
      }
      return record(refuse(404, 'api.context.404.app_error', `Unable to find the requested resource: ${req.method} ${path}`))
    },
  })
  return {
    port: server.port, url: `http://127.0.0.1:${server.port}`,
    tokens: { service: 'svc-token-dev', alice: 'alice-token-dev', bob: 'bob-token-dev' },
    ids:    { team: team.id, open: open.id, secret: secret.id, bot: bot.id, alice: alice.id, bob: bob.id },
    stop() { for (const r of hanging) r(); for (const ws of sockets) ws.close(); server.stop(true) },
  }
}
if (import.meta.main) console.log(`[mattermost-sink] ${startMattermostSink({ port: Number(process.env.MATTERMOST_SINK_PORT ?? 0) }).url}`)
