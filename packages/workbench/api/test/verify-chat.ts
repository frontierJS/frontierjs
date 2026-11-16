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

const { startMattermostSink } = await import('@frontierjs/conduit-mattermost/sink')
const { createTestEnv, session } = await import('@frontierjs/testing')
const { createJunctionClient } = await import('@frontierjs/junction/client')
const { buildWorkbenchApp } = await import('../src/app.ts')

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

let env: any
try {
  env = await createTestEnv({
    schema: join(DB, 'schema.lite'), migrations: join(DB, 'migrations'), encryptionKey: '0'.repeat(64),
    api: ({ db }: any) => buildWorkbenchApp({ db, key: 'test-key', chatUrl: sink.url, deliver: (async () => new Response('', { status: 200 })) as unknown as typeof fetch }),
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
