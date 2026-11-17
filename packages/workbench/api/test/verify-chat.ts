// api/test/verify-chat.ts -- the team chat mirror in Workbench, on the sink
// (`IDEAS/workbench-messages.md` 1.6). Never the live server: the chat URL is
// the sink's, handed to the app, and CHAT_* from the environment is dropped.
//
//   bun run verify:chat
//
// Grades Phase 1's done-when: a member links (chat.connect on a sink token),
// their backfill lands the channels they can read, a post someone else makes
// on the server arrives through the member's socket, a post made here is
// forwarded to the server as its author, and a second member reads none of
// the first's private channels; then each verb a member has beyond posting
// (pin, mark unread, mute, follow, open a direct or group channel, join and
// leave), each asserted on the sink AND on the mirror row, done here and done
// on the server by someone else; and a private room's post reaching its member
// as a pushed /ws frame. The databases (main, chat, jobs) and the
// config folder are a temp directory; the sink and the app take OS ports.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const holds = []

for (const k of Object.keys(process.env)) if (k.startsWith('CHAT_')) delete process.env[k]
const WORK = mkdtempSync(join(tmpdir(), 'workbench-chat-'))
process.env.JOBS_DATABASE_URL = join(WORK, 'jobs.db')
process.env.XDG_CONFIG_HOME   = WORK
process.env.WORKBENCH_DIR     = join(WORK, 'workbench')
process.env.WORKBENCH_PUSH_FILE = join(WORK, 'push.json')

const { startMattermostSink } = await import('@frontierjs/conduit-mattermost/sink')
const { createTestEnv, session } = await import('@frontierjs/testing')
const { createJunctionClient } = await import('@frontierjs/junction/client')
const { buildWorkbenchApp } = await import('../src/app.ts')
const { applyFrame } = await import('../src/providers/chat/sync.ts')

const DB = join(import.meta.dir, '..', '..', 'db')
let failed = 0
const check = (ok: unknown, label: string, evidence: unknown = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence !== '') console.log(`    ${JSON.stringify(evidence).slice(0, 1200)}`) }
  return !!ok
}
async function until<T> (pred: () => Promise<T> | T, ms = 8000): Promise<T | null> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { const v = await pred(); if (v) return v } catch {}
    await new Promise(r => setTimeout(r, 100))
  }
  return null
}

const sink = startMattermostSink({ port: 0 })
const ids = sink.ids
const sinkCall = async (path: string, token: string, init: { method?: string, body?: unknown } = {}) => {
  const res = await fetch(`${sink.url}/api/v4${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

// Every ntfy send the app makes lands here: a drive's push never leaves the machine.
const pushes: { url: string, title: string, body: string }[] = []
let env: any
try {
  env = await createTestEnv({
    schema: join(DB, 'schema.lite'), migrations: join(DB, 'migrations'), encryptionKey: '0'.repeat(64),
    api: ({ db }: any) => buildWorkbenchApp({ db, key: 'test-key', chatUrl: sink.url, deliver: (async (url: string, init: any) => { pushes.push({ url, title: init?.headers?.Title ?? '', body: String(init?.body ?? '') }); return new Response('', { status: 200 }) }) as unknown as typeof fetch }),
    listen: true,
  } as any)
  const sys = env.system
  const ada = await sys.member.create({ data: { nick: 'ada' } })
  const bo  = await sys.member.create({ data: { nick: 'bo' } })
  const as  = (m: { id: number }) => env.as(session({ id: String(m.id), isAdmin: true }))

  // ── link ──────────────────────────────────────────────────────────────
  const refused = await as(ada).service('chat').call('connect', null, { token: 'not-a-token' }).then(() => null, (e: any) => e)
  check((refused?.status ?? refused?.code) === 422, 'a token the server refuses is 422 and is not kept', { ...refused, message: refused?.message, name: refused?.name })
  const linked = await as(ada).service('chat').call('connect', null, { token: sink.tokens.alice })
  check(linked?.profileExternalId === ids.alice, 'chat.connect links the member to the token\'s profile', linked)
  const row = await sys.member.findUnique({ where: { id: ada.id }, select: { profileExternalId: true } })
  check(row?.profileExternalId === ids.alice, 'Member.profileExternalId is the server\'s answer', row)
  const shown = await as(ada).service('chat').call('status', null, {})
  check(shown?.username === 'alice' && !('chatToken' in shown) && !JSON.stringify(shown).includes(sink.tokens.alice), 'chat.status names the link and never the token', shown)

  // ── backfill ──────────────────────────────────────────────────────────
  const synced = await until(async () => (await sys.member.findUnique({ where: { id: ada.id }, select: { chatSyncedAt: true } }))?.chatSyncedAt)
  check(synced, 'the socket\'s first connection queued a backfill that ran to its end')
  const rooms = (await sys.channel.findMany({ select: { externalId: true } })).map((c: any) => c.externalId).sort()
  check(rooms.includes(ids.open) && rooms.includes(ids.secret), 'the backfill landed the open channel and the private one alice is in', rooms)
  check(await sys.channelMember.findUnique({ where: { externalId: `${ids.secret}:${ids.alice}` } }), 'and alice\'s membership of the private one')

  await as(bo).service('chat').call('connect', null, { token: sink.tokens.bob })
  check(await until(async () => (await sys.member.findUnique({ where: { id: bo.id }, select: { chatSyncedAt: true } }))?.chatSyncedAt), 'a second member links and backfills')

  // ── a socket frame ────────────────────────────────────────────────────
  const said = `from the server ${Date.now()}`
  const posted = await sinkCall('/posts', sink.tokens.bob, { method: 'POST', body: { channel_id: ids.open, message: said } })
  check(posted.status === 201, 'bob posts on the server, outside Workbench', posted)
  const arrived = await until(() => sys.post.findUnique({ where: { externalId: posted.json?.id } }))
  check(arrived?.message === said && arrived?.profileExternalId === ids.bob, 'the post arrives through a member\'s socket and lands', arrived)

  // ── a forward ─────────────────────────────────────────────────────────
  const mine = await as(ada).service('posts').create({ channelExternalId: ids.secret, message: 'from Workbench' }).catch((e: any) => e)
  check(mine?.externalId && mine.profileExternalId === ids.alice, 'posts.create forwards to the server as its author and lands the answer', mine?.message ?? mine)
  const page = await sinkCall(`/channels/${ids.secret}/posts`, sink.tokens.alice)
  const there = page.json?.posts?.[mine?.externalId]
  check(there?.message === 'from Workbench' && there?.user_id === ids.alice, 'the server holds the post, authored by alice', page)

  // ── privacy ───────────────────────────────────────────────────────────
  const boRooms = (await as(bo).service('channels').find({}) as any).data.map((c: any) => c.externalId)
  check(boRooms.includes(ids.open) && !boRooms.includes(ids.secret), 'bo lists the open channel and not alice\'s private one', boRooms)
  const boPosts = (await as(bo).service('posts').find({ channelExternalId: ids.secret }) as any).data
  check(boPosts.length === 0, 'bo reads no post of alice\'s private channel', boPosts)
  const boMembers = (await as(bo).service('channelMembers').find({ channelExternalId: ids.secret }) as any).data
  check(boMembers.length === 0, 'nor its members', boMembers)
  const boThreads = (await as(bo).service('threads').find({}) as any).data
  check(boThreads.every((t: any) => t.profileExternalId === ids.bob), 'nor anyone\'s threads but his own', boThreads)
  const adaPosts = (await as(ada).service('posts').find({ channelExternalId: ids.secret }) as any).data
  check(adaPosts.some((p: any) => p.externalId === mine?.externalId), 'alice reads her own private channel', adaPosts.length)
  const boWrite = await as(bo).service('posts').create({ channelExternalId: ids.secret, message: 'let me in' }).then(() => null, (e: any) => e)
  check(boWrite && (boWrite.status ?? boWrite.code) >= 400, 'bo cannot post into it either', { ...boWrite, message: boWrite?.message })
  const spoof = await as(bo).service('profiles').find({ externalId: ids.alice }) as any
  check(spoof.data[0] && spoof.data[0].email == null, 'bo reads alice\'s profile without her address', spoof.data[0])


  // ── the verbs past posting ────────────────────────────────────────────
  // A third member on the bot's token: linked, backfilled, and in none of the
  // rooms made below, so what they cannot read is read off a real member.
  const cy = await sys.member.create({ data: { nick: 'cy' } })
  await as(cy).service('chat').call('connect', null, { token: sink.tokens.service })
  check(await until(async () => (await sys.member.findUnique({ where: { id: cy.id }, select: { chatSyncedAt: true } }))?.chatSyncedAt), 'a third member links and backfills')
  // Re-link the first member: the unlink above comes last, so this is still linked.
  const memberOn = async (channel: string, who: string) => (await sinkCall(`/channels/${channel}/members`, sink.tokens.alice)).json?.find((m: any) => m.user_id === who)
  const mirrorMember = (channel: string, who: string) => sys.channelMember.findUnique({ where: { externalId: `${channel}:${who}` } })
  const say = async (as_: string, channel: string, message: string, root_id = '') =>
    (await sinkCall('/posts', as_, { method: 'POST', body: { channel_id: channel, message, ...(root_id ? { root_id } : {}) } })).json
  const call = (m: { id: number }, method: string, data: unknown) => as(m).service('chat').call(method, null, data).then((r: any) => r, (e: any) => e)

  // pin: any member of the room, not the author alone
  const pinTarget = await say(sink.tokens.bob, ids.open, 'pin me')
  await until(() => sys.post.findUnique({ where: { externalId: pinTarget.id } }))
  const pinned = await call(ada, 'pin', { postExternalId: pinTarget.id, pinned: true })
  const pinnedThere = (await sinkCall(`/channels/${ids.open}/pinned`, sink.tokens.alice)).json?.posts?.[pinTarget.id]
  check(pinned?.isPinned === true && pinnedThere, 'chat.pin pins another author\'s post on the server as alice', { pinned, pinnedThere: !!pinnedThere })
  check((await sys.post.findUnique({ where: { externalId: pinTarget.id } }))?.isPinned === true, 'and the mirror\'s Post.isPinned is true')
  const unpinned = await call(ada, 'pin', { postExternalId: pinTarget.id, pinned: false })
  check(unpinned?.isPinned === false && !(await sinkCall(`/channels/${ids.open}/pinned`, sink.tokens.alice)).json?.posts?.[pinTarget.id], 'chat.pin unpins it on the server', unpinned)
  check((await sys.post.findUnique({ where: { externalId: pinTarget.id } }))?.isPinned === false, 'and the mirror\'s Post.isPinned is false')
  await sinkCall(`/posts/${pinTarget.id}/pin`, sink.tokens.bob, { method: 'POST' })
  check(await until(async () => (await sys.post.findUnique({ where: { externalId: pinTarget.id } }))?.isPinned === true), 'a pin by bob on the server reaches the mirror as a post_edited frame')
  await sinkCall(`/posts/${pinTarget.id}/unpin`, sink.tokens.bob, { method: 'POST' })
  check(await until(async () => (await sys.post.findUnique({ where: { externalId: pinTarget.id } }))?.isPinned === false), 'and his unpin does too')
  const pinRefused = await call(cy, 'pin', { postExternalId: await (async () => (await say(sink.tokens.alice, ids.secret, 'private')).id)(), pinned: true })
  check((pinRefused?.status ?? pinRefused?.code) === 403, 'a member outside the room is refused a pin by the server (403)', { ...pinRefused, message: pinRefused?.message })

  // mark unread: the counts move BACK
  const u1 = await say(sink.tokens.bob, ids.open, 'unread one @alice')
  const u2 = await say(sink.tokens.bob, ids.open, 'unread two')
  const u3 = await say(sink.tokens.bob, ids.open, 'unread three')
  await until(() => sys.post.findUnique({ where: { externalId: u3.id } }))
  await as(ada).service('chat').call('view', null, { channelExternalId: ids.open })
  const read = await until(async () => {
    const [m, room] = [await mirrorMember(ids.open, ids.alice), await sys.channel.findUnique({ where: { externalId: ids.open } })]
    return m && m.messageCount === room.totalMessageCount && m.mentionCount === 0 ? { m, room } : null
  })
  check(read, 'alice reads the room: the mirror\'s counts are the room\'s totals and no mention')
  const marked = await call(ada, 'markUnread', { postExternalId: u1.id })
  const serverMark = await memberOn(ids.open, ids.alice)
  const mirrorMark = await mirrorMember(ids.open, ids.alice)
  const roomNow = await sys.channel.findUnique({ where: { externalId: ids.open } })
  check(marked?.channelExternalId === ids.open && serverMark && serverMark.msg_count === roomNow.totalMessageCount - 3 && serverMark.mention_count === 1,
    'chat.markUnread marks the room unread from the post on the server (three posts, one mention)', { marked, serverMark })
  check(mirrorMark.messageCount === serverMark.msg_count && mirrorMark.mentionCount === 1 && mirrorMark.messageCount < roomNow.totalMessageCount
    && new Date(mirrorMark.lastViewedAt).getTime() === serverMark.last_viewed_at, 'and the mirror\'s ChannelMember counts and lastViewedAt are the server\'s', { mirrorMark, serverMark })
  await sinkCall(`/users/${ids.alice}/posts/${u3.id}/set_unread`, sink.tokens.alice, { method: 'POST', body: { collapsed_threads_supported: true } })
  const elsewhere = await until(async () => {
    const m = await mirrorMember(ids.open, ids.alice)
    return m.messageCount === roomNow.totalMessageCount - 1 && m.mentionCount === 0 ? m : null
  })
  check(elsewhere, 'alice marking unread from a phone lands as a post_unread frame (counts move to the later post)', await mirrorMember(ids.open, ids.alice))
  // a reply marks its thread, not the room
  const rep = await say(sink.tokens.bob, ids.open, 'a reply', u1.id)
  await until(() => sys.post.findUnique({ where: { externalId: rep.id } }))
  const replyMark = await call(ada, 'markUnread', { postExternalId: rep.id })
  const threadMirror = await sys.thread.findUnique({ where: { externalId: `${ids.alice}:${u1.id}` } })
  const threadServer = (await sinkCall(`/users/${ids.alice}/teams/${ids.team}/threads/${u1.id}`, sink.tokens.alice)).json
  check(replyMark?.postExternalId === rep.id && threadServer?.unread_replies === 1 && threadMirror?.unreadReplies === 1,
    'marking a REPLY unread marks its thread: the server and the mirror\'s Thread both hold one unread reply', { replyMark, threadServer: threadServer?.unread_replies, threadMirror })

  // mute
  const muted = await call(ada, 'mute', { channelExternalId: ids.open, muted: true })
  check(muted?.muted === true && (await memberOn(ids.open, ids.alice))?.notify_props?.mark_unread === 'mention', 'chat.mute mutes the room on the server (mark_unread: mention)', muted)
  check((await mirrorMember(ids.open, ids.alice)).muted === true, 'and ChannelMember.muted is true')
  await call(ada, 'mute', { channelExternalId: ids.open, muted: false })
  check((await memberOn(ids.open, ids.alice))?.notify_props?.mark_unread === 'all' && (await mirrorMember(ids.open, ids.alice)).muted === false, 'chat.mute unmutes it on both')
  await sinkCall(`/channels/${ids.open}/members/${ids.alice}/notify_props`, sink.tokens.alice, { method: 'PUT', body: { mark_unread: 'mention' } })
  check(await until(async () => (await mirrorMember(ids.open, ids.alice)).muted === true), 'a mute from another client lands as a channel_member_updated frame')
  await sinkCall(`/channels/${ids.open}/members/${ids.alice}/notify_props`, sink.tokens.alice, { method: 'PUT', body: { mark_unread: 'all' } })
  check(await until(async () => (await mirrorMember(ids.open, ids.alice)).muted === false), 'and so does the unmute')

  // follow
  const root = await say(sink.tokens.bob, ids.open, 'a thread to follow')
  await say(sink.tokens.bob, ids.open, 'its reply', root.id)
  await until(() => sys.post.findUnique({ where: { externalId: root.id } }))
  check(await until(async () => (await sys.post.findUnique({ where: { externalId: root.id } }))?.replyCount === 1), 'a reply on the server raises its root\'s replyCount in the mirror, though alice does not follow the thread yet (the server tells only followers)')
  const threadKeyOf = `${ids.alice}:${root.id}`
  const followed = await call(ada, 'follow', { rootExternalId: root.id, following: true })
  const followedThere = (await sinkCall(`/users/${ids.alice}/teams/${ids.team}/threads/${root.id}`, sink.tokens.alice)).json
  check(followed?.following === true && followedThere?.is_following === true, 'chat.follow follows the thread on the server', { followed, followedThere })
  check((await sys.thread.findUnique({ where: { externalId: threadKeyOf } }))?.isFollowing === true, 'and the mirror lands a Thread row with isFollowing true')
  await call(ada, 'follow', { rootExternalId: root.id, following: false })
  check((await sinkCall(`/users/${ids.alice}/teams/${ids.team}/threads/${root.id}`, sink.tokens.alice)).json?.is_following === false
    && (await sys.thread.findUnique({ where: { externalId: threadKeyOf } }))?.isFollowing === false, 'chat.follow unfollows on both')
  await sinkCall(`/users/${ids.alice}/teams/${ids.team}/threads/${root.id}/following`, sink.tokens.alice, { method: 'PUT' })
  check(await until(async () => (await sys.thread.findUnique({ where: { externalId: threadKeyOf } }))?.isFollowing === true), 'a follow from another client lands as a thread_follow_changed frame')
  await sinkCall(`/users/${ids.alice}/teams/${ids.team}/threads/${root.id}/following`, sink.tokens.alice, { method: 'DELETE' })
  check(await until(async () => (await sys.thread.findUnique({ where: { externalId: threadKeyOf } }))?.isFollowing === false), 'and its unfollow too')

  // The answer's own landing, with the member's socket closed: nothing else can
  // have told the mirror, so what it holds is what the call put there.
  const { listen, unlisten } = await import('../src/providers/chat/index.ts')
  await unlisten(env.app, String(ada.id))
  await call(ada, 'pin', { postExternalId: pinTarget.id, pinned: true })
  await call(ada, 'mute', { channelExternalId: ids.open, muted: true })
  await call(ada, 'markUnread', { postExternalId: u2.id })
  await call(ada, 'follow', { rootExternalId: root.id, following: true })
  const direct = (await sinkCall(`/channels/${ids.open}/members`, sink.tokens.alice)).json?.find((m: any) => m.user_id === ids.alice)
  const afterMark = await mirrorMember(ids.open, ids.alice)
  check((await sys.post.findUnique({ where: { externalId: pinTarget.id } }))?.isPinned === true, 'with the socket closed, a pin lands from the call\'s own answer')
  check(afterMark.muted === true && afterMark.messageCount === direct.msg_count && afterMark.mentionCount === direct.mention_count, 'and so do a mute and a mark-unread', { afterMark, direct })
  check((await sys.thread.findUnique({ where: { externalId: threadKeyOf } }))?.isFollowing === true, 'and a follow')
  await call(ada, 'pin', { postExternalId: pinTarget.id, pinned: false })
  await call(ada, 'mute', { channelExternalId: ids.open, muted: false })
  await call(ada, 'follow', { rootExternalId: root.id, following: false })
  const dm0 = await call(ada, 'openDirect', { profileExternalIds: [ids.bob] })
  check(dm0?.channelExternalId && await mirrorMember(dm0.channelExternalId, ids.alice), 'and a direct channel, its memberships read back by the call')
  await listen(env.app, String(ada.id))

  // a direct channel: both people, nobody else
  const dm = await call(ada, 'openDirect', { profileExternalIds: [ids.bob] })
  const dmId = dm?.channelExternalId
  const bobSees = (await sinkCall(`/users/${ids.bob}/teams/${ids.team}/channels`, sink.tokens.bob)).json?.some((c: any) => c.id === dmId)
  check(dmId && dm.type === 'direct' && bobSees, 'chat.openDirect makes the direct channel on the server and bob has it', { dm, bobSees })
  const listed = async (m: { id: number }) => ((await as(m).service('channels').find({}) as any).data as any[]).map(c => c.externalId)
  check((await listed(ada)).includes(dmId) && (await listed(bo)).includes(dmId) && !(await listed(cy)).includes(dmId), 'the mirror shows it to alice and bob and not to the third member', { ada: (await listed(ada)).includes(dmId), bo: (await listed(bo)).includes(dmId), cy: (await listed(cy)).includes(dmId) })
  const dmMembers = (await sys.channelMember.findMany({ where: { channelExternalId: dmId } })).map((m: any) => m.profileExternalId).sort()
  check(dmMembers.join() === [ids.alice, ids.bob].sort().join(), 'with exactly the two memberships', dmMembers)
  const dmPost = await say(sink.tokens.bob, dmId, 'just us')
  const dmRead = async (m: { id: number }) => ((await as(m).service('posts').find({ channelExternalId: dmId }) as any).data as any[]).length
  await until(() => sys.post.findUnique({ where: { externalId: dmPost.id } }))
  check(await dmRead(ada) === 1 && await dmRead(bo) === 1 && await dmRead(cy) === 0, 'and its post is read by both and by no third')
  const again = await call(ada, 'openDirect', { profileExternalIds: [ids.bob] })
  check(again?.channelExternalId === dmId, 'opening it again answers the same channel', again)
  const group = await call(ada, 'openDirect', { profileExternalIds: [ids.bob, ids.bot] })
  const groupMembers = (await sys.channelMember.findMany({ where: { channelExternalId: group?.channelExternalId } })).map((m: any) => m.profileExternalId).sort()
  check(group?.type === 'group' && groupMembers.join() === [ids.alice, ids.bob, ids.bot].sort().join(), 'a group channel of three lands with its three memberships', { group, groupMembers })
  check((await listed(cy)).includes(group?.channelExternalId), 'and the third person in it reads it')
  const dmFromElsewhere = (await sinkCall('/channels/direct', sink.tokens.service, { method: 'POST', body: [ids.bot, ids.alice] })).json
  check(await until(async () => (await listed(ada)).includes(dmFromElsewhere?.id)), 'a direct channel the bot opens with alice lands through direct_added and her backfill', dmFromElsewhere)
  check((await mirrorMember(dmFromElsewhere?.id, ids.alice)) && !(await listed(bo)).includes(dmFromElsewhere?.id), 'with her membership, and bob cannot read it')
  const bad = await call(ada, 'openDirect', { profileExternalIds: [ids.alice] })
  check((bad?.status ?? bad?.code) === 400, 'a direct channel with oneself is a 400', { ...bad, message: bad?.message })

  // join and leave an open room, by the mirrored model's own verbs
  const lounge = (await sinkCall('/channels', sink.tokens.bob, { method: 'POST', body: { team_id: ids.team, name: 'lounge', display_name: 'Lounge', type: 'O' } })).json
  check(await until(() => sys.channel.findUnique({ where: { externalId: lounge?.id } })), 'a room bob opens on the server lands (his channel_created frame and backfill)')
  const joined = await as(ada).service('channelMembers').create({ channelExternalId: lounge.id, profileExternalId: ids.alice }).catch((e: any) => e)
  check(joined?.externalId === `${lounge.id}:${ids.alice}` && await memberOn(lounge.id, ids.alice), 'channelMembers.create joins the open room on the server as alice and lands the answer', joined?.message ?? joined)
  check(await mirrorMember(lounge.id, ids.alice), 'and the mirror holds her membership')
  const left = await as(ada).service('channelMembers').remove(joined?.id).catch((e: any) => e)
  check(!(await memberOn(lounge.id, ids.alice)) && !(await mirrorMember(lounge.id, ids.alice)), 'channelMembers.remove leaves it on both', left?.message ?? left)

  // channels.create: a private room made as alice, who is its first member
  const made = await as(ada).service('channels').create({ teamExternalId: ids.team, name: 'made-by-create', displayName: 'Made by create', purpose: 'a purpose', type: 'private' }).catch((e: any) => e)
  const madeOnSink = (await sinkCall(`/users/${ids.alice}/teams/${ids.team}/channels`, sink.tokens.alice)).json?.find((c: any) => c.name === 'made-by-create')
  // The answer is the row as the caller reads it, and a private room is readable by its members: the creator's own
  // membership arrives by the socket, so the answer is null until it lands and the screen finds the room by name.
  check(!made?.message && (made === null || made?.externalId === madeOnSink?.id) && madeOnSink?.type === 'P' && madeOnSink.purpose === 'a purpose' && madeOnSink.creator_id === ids.alice, 'channels.create makes a private room on the server as alice', { made, madeOnSink })
  check(await until(() => sys.channel.findUnique({ where: { externalId: madeOnSink?.id } })) && await until(() => mirrorMember(madeOnSink?.id, ids.alice)), 'and the room and its creator\'s membership land in the mirror')

  // browse: the team's open rooms she is not in, landed as rows she can open
  const browsed = await call(ada, 'browse', {})
  const browsedIds: string[] = (browsed?.channels ?? []).map((c: any) => c.externalId)
  check(browsedIds.includes(lounge.id) && !browsedIds.includes(ids.open) && !browsedIds.includes(ids.secret), 'chat.browse answers the open rooms alice is not in, and neither her own nor a private one', browsed)
  check(!!(await sys.channel.findUnique({ where: { externalId: lounge.id } })) && (browsed?.channels ?? []).every((c: any) => c.teamExternalId === ids.team && c.name), 'each landed in the mirror, carrying its team')
  await as(ada).service('channelMembers').create({ channelExternalId: lounge.id, profileExternalId: ids.alice })
  check(!((await call(ada, 'browse', {}))?.channels ?? []).some((c: any) => c.externalId === lounge.id), 'and once she joins, browse stops listing it')
  await sinkCall(`/channels/${lounge.id}/members`, sink.tokens.alice, { method: 'POST', body: { user_id: ids.alice } })
  check(await until(() => mirrorMember(lounge.id, ids.alice)), 'a join from another client lands as user_added and her backfill')
  await sinkCall(`/channels/${lounge.id}/members/${ids.alice}`, sink.tokens.alice, { method: 'DELETE' })
  check(await until(async () => !(await mirrorMember(lounge.id, ids.alice))), 'and a leave from another client drops the membership (user_removed)')

  // a private room's post reaches its member as a pushed frame
  const token = await (env.app as any).auth?.mint?.(ada.id)
  if (!token) check(false, 'the drive could not mint a session to hold a /ws connection', Object.keys(env.app))
  else {
    await sinkCall(`/channels/${ids.secret}/members`, sink.tokens.alice, { method: 'POST', body: { user_id: ids.bob } })
    check(await until(() => mirrorMember(ids.secret, ids.bob)), 'alice adds bob to her private room and the mirror holds both memberships')
    const tabs = (token: string) => createJunctionClient({ url: env.url, token, timeout: 8_000 })
    const live = tabs(token.token)
    live.connect()
    await until(() => (live as any)._wsReady)
    const seenPosts: string[] = []
    live.service('posts').on('created', (p: any) => { seenPosts.push(p?.externalId) })
    const secretPost = await say(sink.tokens.bob, ids.secret, `private ${Date.now()}`)
    check(await until(() => seenPosts.includes(secretPost.id)), 'bob\'s post in their private room reaches alice as a pushed /ws frame', { seenPosts, wsReady: (live as any)._wsReady })
    const cyToken = await (env.app as any).auth.mint(cy.id)
    const outsider = tabs(cyToken.token)
    outsider.connect()
    await until(() => (outsider as any)._wsReady)
    const cySaw: string[] = []
    outsider.service('posts').on('created', (p: any) => { cySaw.push(p?.externalId) })
    const secretPost2 = await say(sink.tokens.bob, ids.secret, `private again ${Date.now()}`)
    await until(() => seenPosts.includes(secretPost2.id))
    await new Promise(r => setTimeout(r, 500))
    check(!cySaw.includes(secretPost2.id) && !cySaw.includes(secretPost.id), 'and reaches no member outside it', cySaw)
    live.disconnect(); outsider.disconnect()
  }

  // ── the extras: a person's own, kept on the server ───────────────────
  // drafts
  const draftKeyOf = (channel: string, root = '') => `${ids.alice}:${channel}:${root}`
  const drafted = await call(ada, 'saveDraft', { channelExternalId: ids.open, message: 'half a thought' })
  const draftsThere = async () => (await sinkCall(`/users/${ids.alice}/teams/${ids.team}/drafts`, sink.tokens.alice)).json as any[]
  check(drafted?.message === 'half a thought' && (await draftsThere())?.some(d => d.channel_id === ids.open && d.message === 'half a thought'), 'chat.saveDraft saves the draft on the server and answers the mirror row', drafted?.message ?? drafted)
  check((await sys.draft.findUnique({ where: { externalId: draftKeyOf(ids.open) } }))?.message === 'half a thought', 'and the mirror holds one Draft for the box')
  await call(ada, 'saveDraft', { channelExternalId: ids.open, message: 'a whole thought' })
  check((await sys.draft.findMany({ where: { profileExternalId: ids.alice, channelExternalId: ids.open, rootExternalId: null } })).length === 1, 'a second save replaces it: still one row for the box')
  check(((await as(bo).service('drafts').find({}) as any).data as any[]).every(d => d.profileExternalId === ids.bob), 'bo reads none of alice\'s drafts')
  const undrafted = await call(ada, 'deleteDraft', { channelExternalId: ids.open })
  check(undrafted?.channelExternalId === ids.open && !(await draftsThere())?.some(d => d.channel_id === ids.open && !d.delete_at)
    && !(await sys.draft.findUnique({ where: { externalId: draftKeyOf(ids.open) } })), 'chat.deleteDraft discards it on both', undrafted)
  await sinkCall('/drafts', sink.tokens.alice, { method: 'POST', body: { user_id: ids.alice, channel_id: ids.open, root_id: u1.id, message: 'typed on a phone' } })
  check(await until(async () => (await sys.draft.findUnique({ where: { externalId: draftKeyOf(ids.open, u1.id) } }))?.message === 'typed on a phone'), 'a reply draft saved on another client lands as a draft_created frame')
  await sinkCall(`/users/${ids.alice}/channels/${ids.open}/drafts/${u1.id}`, sink.tokens.alice, { method: 'DELETE' })
  check(await until(async () => !(await sys.draft.findUnique({ where: { externalId: draftKeyOf(ids.open, u1.id) } }))), 'and its discard as draft_deleted')

  // saved posts and favorite rooms
  const prefsThere = async (category: string) => ((await sinkCall(`/users/${ids.alice}/preferences/${category}`, sink.tokens.alice)).json ?? []) as any[]
  const savedRow = (post: string) => sys.savedPost.findUnique({ where: { externalId: `${ids.alice}:${post}` } })
  const saved = await call(ada, 'save', { postExternalId: u2.id, saved: true })
  check(saved?.saved === true && (await prefsThere('flagged_post')).some(p => p.name === u2.id && p.value === 'true') && await savedRow(u2.id), 'chat.save saves the post on the server and the mirror holds a SavedPost', saved)
  const savedList = await call(ada, 'saved', {})
  check(savedList?.postExternalIds?.[0] === u2.id && await sys.post.findUnique({ where: { externalId: u2.id } }), 'chat.saved answers the saved posts newest first, landed as Post rows', savedList)
  check(((await as(bo).service('savedPosts').find({}) as any).data as any[]).length === 0, 'bo reads none of alice\'s saved posts')
  await call(ada, 'save', { postExternalId: u2.id, saved: false })
  check(!(await prefsThere('flagged_post')).some(p => p.name === u2.id && p.value === 'true') && !(await savedRow(u2.id)), 'chat.save unsaves it on both')
  await sinkCall(`/users/${ids.alice}/preferences`, sink.tokens.alice, { method: 'PUT', body: [{ user_id: ids.alice, category: 'flagged_post', name: u3.id, value: 'true' }] })
  check(await until(() => savedRow(u3.id)), 'a save on another client lands as a preferences_changed frame')
  await sinkCall(`/users/${ids.alice}/preferences/delete`, sink.tokens.alice, { method: 'POST', body: [{ user_id: ids.alice, category: 'flagged_post', name: u3.id, value: '' }] })
  check(await until(async () => !(await savedRow(u3.id))), 'and an unsave as preferences_deleted')
  const fav = await call(ada, 'favorite', { channelExternalId: ids.open, favorite: true })
  check(fav?.favorite === true && (await prefsThere('favorite_channel')).some(p => p.name === ids.open && p.value === 'true') && (await mirrorMember(ids.open, ids.alice))?.isFavorite === true,
    'chat.favorite favorites the room on the server and ChannelMember.isFavorite is true', fav)
  await sinkCall(`/users/${ids.alice}/preferences/delete`, sink.tokens.alice, { method: 'POST', body: [{ user_id: ids.alice, category: 'favorite_channel', name: ids.open, value: '' }] })
  check(await until(async () => (await mirrorMember(ids.open, ids.alice))?.isFavorite === false), 'an unfavorite on another client lands as a frame')

  // presence and custom status
  const st = await call(ada, 'setStatus', { status: 'dnd', dndEndAt: new Date(Date.now() + 3_600_000).toISOString() })
  const stThere = (await sinkCall(`/users/${ids.alice}/status`, sink.tokens.alice)).json
  const alice = () => sys.profile.findUnique({ where: { externalId: ids.alice } })
  check(st?.status === 'dnd' && stThere?.status === 'dnd' && (await alice())?.status === 'dnd' && (await alice())?.statusManual === true, 'chat.setStatus sets dnd on the server and on alice\'s Profile', { st, stThere })
  await sinkCall(`/users/${ids.bob}/status`, sink.tokens.bob, { method: 'PUT', body: { user_id: ids.bob, status: 'away' } })
  check(await until(async () => (await sys.profile.findUnique({ where: { externalId: ids.bob } }))?.status === 'away'), 'bob going away on another client lands as a status_change frame')
  await sys.profile.updateMany({ where: { externalId: ids.bob }, data: { status: null } })
  const polled = await call(ada, 'statuses', { profileExternalIds: [ids.bob] })
  check(polled?.statuses?.[0]?.status === 'away' && (await sys.profile.findUnique({ where: { externalId: ids.bob } }))?.status === 'away', 'chat.statuses reads presence for the people on screen and lands it', polled)
  const cs = await call(ada, 'setCustomStatus', { emoji: 'coffee', text: 'back soon' })
  const csThere = (await sinkCall('/users/me', sink.tokens.alice)).json?.props?.customStatus ?? ''
  check(cs?.customText === 'back soon' && csThere.includes('back soon') && (await alice())?.customText === 'back soon' && (await alice())?.customEmoji === 'coffee', 'chat.setCustomStatus sets it on the server and on the Profile', { cs, csThere })
  await call(ada, 'setCustomStatus', {})
  check(!((await sinkCall('/users/me', sink.tokens.alice)).json?.props?.customStatus) && (await alice())?.customText == null, 'and an empty one clears it on both')
  const badStatus = await call(ada, 'setStatus', { status: 'asleep' })
  check((badStatus?.status ?? badStatus?.code) === 400, 'a status the server has no name for is a 400', { ...badStatus, message: badStatus?.message })

  // search and activity
  const found = await call(ada, 'search', { terms: 'unread' })
  check([u1.id, u2.id, u3.id].every(id => found?.postExternalIds?.includes(id)) && await sys.post.findUnique({ where: { externalId: u3.id } }), 'chat.search answers the matching posts, landed', found)
  const act = await call(ada, 'activity', {})
  check(act?.mentions?.includes(u1.id) && !act.mentions.includes(u2.id), 'chat.activity answers the posts naming alice', act)
  const actThreads = await sys.thread.findMany({ where: { profileExternalId: ids.alice, rootExternalId: { in: act?.threads ?? [] } } })
  check(Array.isArray(act?.threads) && actThreads.every((t: any) => t.isFollowing && t.unreadReplies > 0), 'and only followed threads with unread replies', { threads: act?.threads, actThreads })

  // another person's custom status, live
  const bobRow = () => sys.profile.findUnique({ where: { externalId: ids.bob } })
  await sinkCall(`/users/${ids.bob}/status/custom`, sink.tokens.bob, { method: 'PUT', body: { emoji: 'palm_tree', text: 'On a beach' } })
  check((await sinkCall('/users/me', sink.tokens.bob)).json?.props?.customStatus?.includes('On a beach')
    && await until(async () => (await bobRow())?.customText === 'On a beach' && (await bobRow())?.customEmoji === 'palm_tree'), 'bob\'s custom status set on another client lands on his Profile as user_updated', await bobRow())
  await sinkCall(`/users/${ids.bob}/status/custom`, sink.tokens.bob, { method: 'DELETE' })
  check(await until(async () => (await bobRow())?.customText == null && (await bobRow())?.customEmoji == null), 'and his clear lands as null')

  // sidebar sections
  const sectionsThere = async () => (await sinkCall(`/users/${ids.alice}/teams/${ids.team}/channels/categories`, sink.tokens.alice)).json as { order: string[], categories: any[] }
  const sections = () => sys.chatSection.findMany({ where: { profileExternalId: ids.alice, teamExternalId: ids.team }, orderBy: { sortOrder: 'asc' } })
  const kindsHere = (await sections()).map((c: any) => c.kind)
  check(['favorites', 'channels', 'direct'].every(k => kindsHere.includes(k)) && (await sections()).map((c: any) => c.externalId).join() === (await sectionsThere()).order.join(), 'the backfill lands alice\'s sections whole, in the server\'s order', kindsHere)
  const work = await call(ada, 'createSection', { teamExternalId: ids.team, name: 'Work', channelExternalIds: [ids.open] })
  const sectionThere = async (id: string) => (await sectionsThere()).categories.find(c => c.id === id)
  check(work?.kind === 'custom' && work?.name === 'Work' && work?.channelExternalIds?.join() === ids.open && (await sectionThere(work.externalId))?.display_name === 'Work',
    'chat.createSection makes the section on the server and answers its ChatSection row', work)
  check(!(await sections()).some((c: any) => c.kind === 'channels' && c.channelExternalIds.includes(ids.open)), 'and the room leaves the section that held it, here too')
  const renamed = await call(ada, 'renameSection', { sectionExternalId: work?.externalId, name: 'Projects' })
  check(renamed?.name === 'Projects' && (await sectionThere(work?.externalId))?.display_name === 'Projects', 'chat.renameSection renames it on both', renamed)
  const moved = await call(ada, 'moveToSection', { channelExternalId: ids.secret, sectionExternalId: work?.externalId, index: 0 })
  check(moved?.channelExternalIds?.join() === [ids.secret, ids.open].join() && (await sectionThere(work?.externalId))?.channel_ids?.join() === [ids.secret, ids.open].join(), 'chat.moveToSection puts a room at the place asked, on both', moved)
  const channelsSection = (await sections()).find((c: any) => c.kind === 'channels')
  const movedBack = await call(ada, 'moveToSection', { channelExternalId: ids.secret, sectionExternalId: channelsSection?.externalId })
  check(movedBack?.kind === 'channels' && movedBack.channelExternalIds?.includes(ids.secret) && (await sectionThere(channelsSection?.externalId))?.channel_ids?.includes(ids.secret)
    && !(await sectionThere(work?.externalId))?.channel_ids?.includes(ids.secret) && !(await sys.chatSection.findUnique({ where: { externalId: work?.externalId } }))?.channelExternalIds?.includes(ids.secret),
    'chat.moveToSection moves a room back into Channels, a system section, on both', { ...movedBack, message: movedBack?.message })
  const reversed = [...(await sectionsThere()).order].reverse()
  const reordered = await call(ada, 'reorderSections', { teamExternalId: ids.team, sectionExternalIds: reversed })
  check(reordered?.sectionExternalIds?.join() === reversed.join() && (await sectionsThere()).order.join() === reversed.join() && (await sections()).map((c: any) => c.externalId).join() === reversed.join(), 'chat.reorderSections orders them on both', reordered)
  check(((await as(bo).service('chatSections').find({}) as any).data as any[]).every(c => c.profileExternalId === ids.bob), 'bo reads none of alice\'s sections')
  const phone = (await sinkCall(`/users/${ids.alice}/teams/${ids.team}/channels/categories`, sink.tokens.alice, { method: 'POST', body: { user_id: ids.alice, team_id: ids.team, type: 'custom', display_name: 'Phone', channel_ids: [] } })).json
  check(await until(async () => (await sys.chatSection.findUnique({ where: { externalId: phone?.id } }))?.name === 'Phone'), 'a section work on another client lands as sidebar_category_created', phone)
  const phoneOrder = [phone.id, ...(await sectionsThere()).order.filter(id => id !== phone.id)]
  await sinkCall(`/users/${ids.alice}/teams/${ids.team}/channels/categories/order`, sink.tokens.alice, { method: 'PUT', body: phoneOrder })
  check(await until(async () => (await sections())[0]?.externalId === phone.id), 'its move to the top lands as sidebar_category_order_updated')
  await sinkCall(`/users/${ids.alice}/teams/${ids.team}/channels/categories/${work?.externalId}`, sink.tokens.alice, { method: 'PUT', body: { ...(await sectionThere(work?.externalId)), display_name: 'Elsewhere' } })
  check(await until(async () => (await sys.chatSection.findUnique({ where: { externalId: work?.externalId } }))?.name === 'Elsewhere'), 'a rename on another client lands as sidebar_category_updated')
  await sinkCall(`/users/${ids.alice}/teams/${ids.team}/channels/categories/${phone.id}`, sink.tokens.alice, { method: 'DELETE' })
  check(await until(async () => !(await sys.chatSection.findUnique({ where: { externalId: phone.id } }))), 'and a delete there as sidebar_category_deleted')
  const unmade = await call(ada, 'deleteSection', { sectionExternalId: work?.externalId })
  check(unmade?.sectionExternalId === work?.externalId && !(await sectionThere(work?.externalId)) && !(await sys.chatSection.findUnique({ where: { externalId: work?.externalId } }))
    && (await sections()).some((c: any) => c.kind === 'channels' && c.channelExternalIds.includes(ids.open)), 'chat.deleteSection deletes it on both and its rooms go back', unmade)
  const sysSection = (await sections()).find((c: any) => c.kind === 'favorites')
  const sysDelete = await call(ada, 'deleteSection', { sectionExternalId: sysSection?.externalId })
  check((sysDelete?.status ?? sysDelete?.code) === 400 && await sys.chatSection.findUnique({ where: { externalId: sysSection?.externalId } }), 'a system section\'s delete is the server\'s 400, and it stays', { ...sysDelete, message: sysDelete?.message })

  // edit history
  const edited = await say(sink.tokens.alice, ids.open, 'version one')
  await sinkCall(`/posts/${edited.id}/patch`, sink.tokens.alice, { method: 'PUT', body: { message: 'version two' } })
  await sinkCall(`/posts/${edited.id}/patch`, sink.tokens.alice, { method: 'PUT', body: { message: 'version three' } })
  const hist = await call(ada, 'editHistory', { postExternalId: edited.id })
  check(hist?.versions?.map((v: any) => v.message).join() === 'version two,version one' && hist.versions.every((v: any) => v.editedAt), 'chat.editHistory answers the earlier versions newest first, each stamped', hist)
  const notHers = await call(ada, 'editHistory', { postExternalId: u1.id })
  check((notHers?.status ?? notHers?.code) === 404, 'another person\'s post is the server\'s 404, not a 500', { ...notHers, message: notHers?.message })

  // link previews
  const linkPost = await say(sink.tokens.bob, ids.open, 'look at https://example.com/launch today')
  const embedded = await until(async () => { const p = await sys.post.findUnique({ where: { externalId: linkPost.id } }); return p?.embeds?.length ? p : null })
  check(embedded?.embeds?.[0]?.title === 'example.com page' && embedded.embeds[0].siteName === 'example.com' && embedded.embeds[0].image === 'https://example.com/og.png'
    && (await sinkCall(`/channels/${ids.open}/posts?per_page=5`, sink.tokens.alice)).json?.posts?.[linkPost.id]?.metadata?.embeds?.length === 1, 'a post with a link lands its preview on Post.embeds', embedded?.embeds)
  check(Array.isArray((await sys.post.findUnique({ where: { externalId: u2.id } }))?.embeds) && (await sys.post.findUnique({ where: { externalId: u2.id } }))?.embeds.length === 0, 'and one with none holds []')

  // reminders
  const remindAt = new Date(Date.now() + 3_600_000)
  const reminded = await call(ada, 'remind', { postExternalId: u1.id, at: remindAt.toISOString() })
  const remindWire = ((await (await fetch(`${sink.url}/_sink/seen`)).json()) as any).reminders.at(-1)
  check(reminded?.postExternalId === u1.id && remindWire?.post_id === u1.id && remindWire?.user_id === ids.alice && remindWire?.target_time === Math.floor(remindAt.getTime() / 1000), 'chat.remind sets the reminder on the server in whole seconds', { reminded, remindWire })
  const pastRemind = await call(ada, 'remind', { postExternalId: u1.id, at: new Date(Date.now() - 1000).toISOString() })
  check((pastRemind?.status ?? pastRemind?.code) === 400, 'a reminder in the past is a 400', { ...pastRemind, message: pastRemind?.message })

  // typing reaches the room's members' tabs, and no one else's
  const typingToken = await (env.app as any).auth.mint(ada.id), cyTyping = await (env.app as any).auth.mint(cy.id)
  const tab = (t: string) => createJunctionClient({ url: env.url, token: t, timeout: 8_000 })
  const adaTab = tab(typingToken.token), cyTab = tab(cyTyping.token)
  adaTab.connect(); cyTab.connect()
  await until(() => (adaTab as any)._wsReady && (cyTab as any)._wsReady)
  const adaHeard: any[] = [], cyHeard: any[] = []
  ;(adaTab as any).on('event', (name: string, data: any) => { if (name === 'chat typing') adaHeard.push(data) })
  ;(cyTab as any).on('event', (name: string, data: any) => { if (name === 'chat typing') cyHeard.push(data) })
  const bobWs = new WebSocket(`${sink.url.replace(/^http/, 'ws')}/api/v4/websocket`, { headers: { authorization: `Bearer ${sink.tokens.bob}` } } as any)
  await new Promise(r => { bobWs.onopen = r; setTimeout(r, 3000) })
  bobWs.send(JSON.stringify({ action: 'user_typing', seq: 1, data: { channel_id: ids.secret, parent_id: '' } }))
  check(await until(() => adaHeard.length > 0) && adaHeard[0]?.channelExternalId === ids.secret && adaHeard[0]?.profileExternalId === ids.bob && adaHeard[0]?.rootExternalId == null,
    'bob typing in their private room reaches alice\'s tab as a chat typing frame', adaHeard)
  await new Promise(r => setTimeout(r, 500))
  check(cyHeard.length === 0, 'and reaches no one outside the room', cyHeard)
  bobWs.close(); adaTab.disconnect(); cyTab.disconnect()

  // ── scheduled posts (local) ───────────────────────────────────────────
  const { sendDue } = await import('../src/domain/chat/scheduled.ts')
  const errOf = (p: Promise<unknown>) => p.then(() => null, (e: any) => e)
  const codeOf = (e: any) => e?.status ?? e?.code
  const shown_ = (e: any) => e && { ...e, message: e.message }
  const sched = (m: { id: number }) => as(m).service('scheduledPosts')
  const later = () => new Date(Date.now() + 3_600_000).toISOString()
  const schedRow = (id: number) => sys.scheduledPost.findUnique({ where: { id } })
  const s1 = await sched(ada).create({ channelExternalId: ids.open, message: 'later, from Workbench', sendAt: later() }).catch((e: any) => e)
  check(s1?.status === 'scheduled' && s1.profileExternalId === ids.alice && s1.memberId === ada.id, 'scheduledPosts.create keeps a scheduled row stamped with its member', shown_(s1))
  const pastSend = await errOf(sched(ada).create({ channelExternalId: ids.open, message: 'too late', sendAt: new Date(Date.now() - 60_000).toISOString() }))
  check(codeOf(pastSend) === 400, 'a send time in the past is a 400', shown_(pastSend))
  const emptySend = await errOf(sched(ada).create({ channelExternalId: ids.open, message: '  ', sendAt: later() }))
  check(codeOf(emptySend) === 400, 'and so is a post with no message and no file', shown_(emptySend))
  check(((await sched(bo).find({}) as any).data as any[]).length === 0, 'another member reads none of them')
  const boCancel = await errOf(sched(bo).patch(s1?.id, { status: 'cancelled' }))
  check(codeOf(boCancel) >= 400 && (await schedRow(s1?.id))?.status === 'scheduled', 'nor cancels one', shown_(boCancel))
  const dueRow = await sched(ada).create({ channelExternalId: ids.secret, message: 'scheduled for now', sendAt: later() })
  const badRow = await sched(ada).create({ channelExternalId: 'z'.repeat(26), message: 'into nowhere', sendAt: later() })
  const stopRow = await sched(ada).create({ channelExternalId: ids.open, message: 'never sent', sendAt: later() })
  const cyRow = await sched(cy).create({ channelExternalId: ids.open, message: 'from an old link', sendAt: later() })
  const cancelled = await sched(ada).patch(stopRow.id, { status: 'cancelled' })
  check(cancelled?.status === 'cancelled', 'a patch to cancelled cancels it', cancelled)
  await call(cy, 'disconnect', {})
  const dueNow = new Date(Date.now() - 1000).toISOString()
  for (const r of [dueRow, badRow, stopRow, cyRow]) await sys.scheduledPost.update({ where: { id: r.id }, data: { sendAt: dueNow } })
  const ran = await sendDue(env.app)
  const sentRow = await schedRow(dueRow.id)
  check(ran.sent === 1 && sentRow?.status === 'sent' && sentRow.sentPostExternalId && sentRow.sentAt, 'the job sends a due row as its member and marks it sent with the post', { ran, sentRow })
  const sentThere = (await sinkCall(`/channels/${ids.secret}/posts`, sink.tokens.alice)).json?.posts?.[sentRow?.sentPostExternalId]
  check(sentThere?.message === 'scheduled for now' && sentThere.user_id === ids.alice, 'the post is on the server, authored by alice', sentThere)
  check((await sys.post.findUnique({ where: { externalId: sentRow?.sentPostExternalId } }))?.message === 'scheduled for now', 'and in the mirror')
  const failedRow = await schedRow(badRow.id)
  check(failedRow?.status === 'failed' && !!failedRow.error, 'a refused send is kept failed with its error', failedRow)
  const cyFailed = await schedRow(cyRow.id)
  check(cyFailed?.status === 'failed' && /link/.test(cyFailed.error ?? ''), 'a member whose link is gone is failed with a plain reason', cyFailed)
  const openPosts = Object.values((await sinkCall(`/channels/${ids.open}/posts?per_page=200`, sink.tokens.alice)).json?.posts ?? {}) as any[]
  check((await schedRow(stopRow.id))?.status === 'cancelled' && !openPosts.some(p => p.message === 'never sent' || p.message === 'from an old link'), 'a cancelled row is not sent, nor an unlinked member\'s')
  const schedAgain = await sendDue(env.app)
  check(schedAgain.sent === 0 && schedAgain.failed === 0 && (await schedRow(badRow.id))?.status === 'failed' && (await schedRow(s1?.id))?.status === 'scheduled', 'a failed row is not retried, and a future one waits', schedAgain)
  const editSent = await errOf(sched(ada).patch(dueRow.id, { message: 'too late to edit' }))
  check(codeOf(editSent) === 409, 'a sent row cannot be changed', shown_(editSent))

  // ── groups (local) ────────────────────────────────────────────────────
  const grp = (m: { id: number }) => as(m).service('chatGroups')
  const chatGroup = await grp(ada).create({ handle: 'Design-Team', name: 'Design', profileExternalIds: [ids.alice, ids.bob] }).catch((e: any) => e)
  check(chatGroup?.handle === 'design-team' && chatGroup.createdByProfileExternalId === ids.alice && chatGroup.profileExternalIds?.join() === [ids.alice, ids.bob].join(), 'chatGroups.create keeps the chatGroup, its handle lowercased, stamped with its creator', shown_(chatGroup))
  check(((await grp(bo).find({}) as any).data as any[]).some(g => g.id === chatGroup?.id), 'every member reads it')
  const boRename = await errOf(grp(bo).patch(chatGroup?.id, { name: 'Mine now' }))
  const boUnmake = await errOf(grp(bo).remove(chatGroup?.id))
  check(codeOf(boRename) >= 400 && codeOf(boUnmake) >= 400 && (await sys.chatGroup.findUnique({ where: { id: chatGroup?.id } }))?.name === 'Design', 'a member who did not make it can neither change nor remove it', { rename: shown_(boRename), remove: shown_(boUnmake) })
  const dupGroup = await errOf(grp(bo).create({ handle: 'design-team', name: 'Other' }))
  check(codeOf(dupGroup) >= 400 && codeOf(dupGroup) < 500, 'a handle already taken is refused', shown_(dupGroup))
  const badHandle = await errOf(grp(ada).create({ handle: 'no spaces!', name: 'Bad' }))
  check(codeOf(badHandle) >= 400 && codeOf(badHandle) < 500, 'a handle outside [a-z0-9-] is refused', shown_(badHandle))
  const regrouped = await grp(ada).patch(chatGroup?.id, { name: 'Designers', profileExternalIds: [ids.bob] }).catch((e: any) => e)
  check(regrouped?.name === 'Designers' && regrouped.profileExternalIds?.join() === ids.bob, 'its creator changes it', shown_(regrouped))
  await grp(ada).remove(chatGroup?.id)
  check(!(await sys.chatGroup.findUnique({ where: { id: chatGroup?.id } })), 'and removes it')

  // ── quiet hours (local) ───────────────────────────────────────────────
  const quiet = (m: { id: number }) => as(m).service('quietSchedules')
  const qh = await quiet(ada).create({ days: [5, 1, 2, 3, 4], fromMinute: 1320, toMinute: 420, timezone: 'America/Chicago' }).catch((e: any) => e)
  check(qh?.profileExternalId === ids.alice && qh.days?.join() === '1,2,3,4,5' && qh.enabled === true, 'quietSchedules.create keeps the caller\'s own row', shown_(qh))
  const qh2 = await quiet(ada).patch(qh?.id, { enabled: false, toMinute: 480 }).catch((e: any) => e)
  const qhMine = (await quiet(ada).find({}) as any).data
  check(qh2?.enabled === false && qh2.toMinute === 480 && qhMine.length === 1 && qhMine[0].enabled === false, 'a patch round-trips', { qh2: shown_(qh2), qhMine })
  check(((await quiet(bo).find({}) as any).data as any[]).length === 0, 'another member reads none of it')
  const qhSecond = await errOf(quiet(ada).create({ fromMinute: 0, toMinute: 60, timezone: 'UTC' }))
  check(codeOf(qhSecond) >= 400 && codeOf(qhSecond) < 500, 'a second row for the same member is refused', shown_(qhSecond))
  const qhZone = await errOf(quiet(bo).create({ fromMinute: 0, toMinute: 60, timezone: 'Mars/Olympus' }))
  check(codeOf(qhZone) === 400, 'a timezone that is not one is a 400', shown_(qhZone))

  // ── chat notifications (4.1) ──────────────────────────────────────────
  const noteSettle = () => new Promise(r => setTimeout(r, 600))
  const noteBellOf = (post: string) => sys.notification.findMany({ where: { userId: ada.id, deliveryKey: `chat:${post}` } })
  const notePushesOf = (text: string) => pushes.filter(p => p.body.includes(text))
  const noteSetMute = async (on: boolean) => {
    await sinkCall(`/channels/${ids.open}/members/${ids.alice}/notify_props`, sink.tokens.alice, { method: 'PUT', body: { mark_unread: on ? 'mention' : 'all' } })
    return until(async () => (await mirrorMember(ids.open, ids.alice))?.muted === on)
  }
  check(await noteSetMute(false), 'the open room starts unmuted for alice')
  const noteStamp = Date.now()
  const noteOpenRoom = await sys.channel.findUnique({ where: { externalId: ids.open }, select: { name: true } })
  const noteNamed = await say(sink.tokens.bob, ids.open, `look here @alice n${noteStamp}`)
  const noteNamedRows = await until(async () => { const r = await noteBellOf(noteNamed.id); return r.length ? r : null })
  check(noteNamedRows?.length === 1 && noteNamedRows[0].type === 'ChatMention' && noteNamedRows[0].data?.title === `bob in #${noteOpenRoom?.name}` && noteNamedRows[0].data?.action?.url === `/messages/${ids.open}/`, 'a sink post naming alice raises one ChatMention bell row for her, titled with the author and room, linked to the room', noteNamedRows)
  check(await until(() => notePushesOf(`n${noteStamp}`).length === 1) && notePushesOf(`n${noteStamp}`)[0].title === `bob in #${noteOpenRoom?.name}`, 'and one push, caught here and never sent', notePushesOf(`n${noteStamp}`))

  const noteDm = (await sinkCall('/channels/direct', sink.tokens.bob, { method: 'POST', body: [ids.bob, ids.alice] })).json
  check(await until(() => mirrorMember(noteDm?.id, ids.alice)), 'a direct room bob opens lands alice\'s membership', noteDm)
  const noteDmPushesBefore = pushes.length
  const noteDirect = await say(sink.tokens.bob, noteDm?.id, `just us d${noteStamp}`)
  const noteDmRows = await until(async () => { const r = await noteBellOf(noteDirect.id); return r.length ? r : null })
  check(noteDmRows?.length === 1 && noteDmRows[0].type === 'ChatDm' && noteDmRows[0].data?.title === 'bob' && noteDmRows[0].data?.body === 'Sent you a message' && !JSON.stringify(noteDmRows[0]).includes(`d${noteStamp}`), 'a DM from bob raises one ChatDm row, holding none of the post\'s text', noteDmRows)
  const noteDmPushes = () => pushes.slice(noteDmPushesBefore).filter(p => p.title === 'bob' && p.body === 'Sent you a message')
  check(await until(() => noteDmPushes().length === 1) && notePushesOf(`d${noteStamp}`).length === 0, 'and one push, saying only that bob wrote', noteDmPushes())

  const noteOwn = await say(sink.tokens.alice, ids.open, `@channel @alice mine o${noteStamp}`)
  await until(() => sys.post.findUnique({ where: { externalId: noteOwn.id } })); await noteSettle()
  check((await noteBellOf(noteOwn.id)).length === 0, 'alice\'s own post raises nothing for her', await noteBellOf(noteOwn.id))

  check(await noteSetMute(true), 'alice mutes the open room')
  const noteWide = await say(sink.tokens.bob, ids.open, `@channel heads up w${noteStamp}`)
  await until(() => sys.post.findUnique({ where: { externalId: noteWide.id } })); await noteSettle()
  check((await noteBellOf(noteWide.id)).length === 0, 'an @channel in a muted room raises nothing for her', await noteBellOf(noteWide.id))
  const notePointed = await say(sink.tokens.bob, ids.open, `@alice still you m${noteStamp}`)
  check(await until(async () => (await noteBellOf(notePointed.id)).length === 1), 'a direct @mention there still raises one')
  check(await noteSetMute(false), 'and the room is unmuted again')

  const noteLanded = await sys.post.findUnique({ where: { externalId: noteNamed.id } })
  const noteAgain = { externalId: noteLanded.externalId, channelExternalId: noteLanded.channelExternalId, profileExternalId: noteLanded.profileExternalId, rootExternalId: noteLanded.rootExternalId, message: noteLanded.message, createdAt: noteLanded.createdAt }
  await applyFrame(env.app, String(ada.id), ids.alice, { id: `again-${noteStamp}`, type: 'posted', payload: { post: noteAgain, files: [], mentions: [ids.alice], channelType: 'O', senderName: '@bob' } } as any)
  await noteSettle()
  check((await noteBellOf(noteNamed.id)).length === 1 && notePushesOf(`n${noteStamp}`).length === 1, 'the same frame twice raises one', { rows: (await noteBellOf(noteNamed.id)).length, pushes: notePushesOf(`n${noteStamp}`).length })

  await quiet(ada).patch(qh?.id, { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], fromMinute: 0, toMinute: 0, timezone: 'UTC' })
  const noteHushed = await say(sink.tokens.bob, ids.open, `@alice at night q${noteStamp}`)
  const noteHushedRows = await until(async () => { const r = await noteBellOf(noteHushed.id); return r.length ? r : null })
  await noteSettle()
  check(noteHushedRows?.length === 1 && noteHushedRows[0].data?.held === true && notePushesOf(`q${noteStamp}`).length === 0, 'inside quiet hours the bell row is written and no push is sent', { noteHushedRows, pushes: notePushesOf(`q${noteStamp}`) })
  await quiet(ada).patch(qh?.id, { enabled: false })

  const noteBoPost = await say(sink.tokens.alice, ids.open, `@bob not the owner b${noteStamp}`)
  const noteBoRows = await until(async () => { const r = await sys.notification.findMany({ where: { userId: bo.id, deliveryKey: `chat:${noteBoPost.id}` } }); return r.length ? r : null })
  await noteSettle()
  check(noteBoRows?.length === 1 && noteBoRows[0].type === 'ChatMention' && notePushesOf(`b${noteStamp}`).length === 0, 'a mention of bo, who is not the owner, writes his bell row and sends no push', { noteBoRows, pushes: notePushesOf(`b${noteStamp}`) })

  // ── unlink ────────────────────────────────────────────────────────────
  await as(ada).service('chat').call('disconnect', null, {})
  const gone = await sys.member.findUnique({ where: { id: ada.id }, select: { profileExternalId: true, chatSyncedAt: true } })
  check(gone?.profileExternalId == null && gone?.chatSyncedAt == null, 'chat.disconnect forgets the link', gone)
} catch (err) {
  failed++
  console.log('✗ the drive threw:', (err as Error)?.stack ?? err)
} finally {
  await env?.close().catch(() => {})
  sink.stop()
  rmSync(WORK, { recursive: true, force: true })
}
console.log(failed ? `\n${failed} failed` : '\nall green')
process.exit(failed ? 1 : 0)
