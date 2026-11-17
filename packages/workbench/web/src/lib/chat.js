// web/src/lib/chat.js -- what the Messages screens share
// (`IDEAS/workbench-messages.md` 2.2): the channel on screen, the people, and
// where the reader stands in each channel.
//
// Ported from serpgrid's lib/chat.js onto the mirror's nouns. The counts are
// not a second copy: the sync keeps `Channel.totalMessageCountRoot` and the
// reader's `ChannelMember.messageCountRoot`, both arrive as pushes into their
// tethers, so a pill is a difference read from rows rather than a number this
// file moves by hand.
//
// Nothing here is a permission boundary: the schema's policies grade every read.

import { watchProxy } from '@frontierjs/mesa/runtime'
import { session } from './session.js'
import { channels } from '../resources/Channel.mesa'
import { channelMembers } from '../resources/ChannelMember.mesa'
import { profiles } from '../resources/Profile.mesa'
import { threads } from '../resources/Thread.mesa'
import { chat as link } from '../resources/Chat.mesa'
import { reactions } from '../resources/Reaction.mesa'
import { drafts } from '../resources/Draft.mesa'
import { posts } from '../resources/Post.mesa'
import { savedPosts } from '../resources/SavedPost.mesa'
import { chatSections } from '../resources/ChatSection.mesa'
import { scheduledPosts } from '../resources/ScheduledPost.mesa'
import { chatGroups } from '../resources/ChatGroup.mesa'
import { glyphOf } from './emoji.js'

/** The channel on screen, so the sidebar marks it and a post arriving in it is read at once. */
export const chat = watchProxy({ activeChannelId: null, held: {}, badge: null })

/** The reader's own `profileExternalId`, or null when the member has not linked. */
export const me = () => session.user?.profileExternalId ?? null

// ── The lists ──
// One set per Messages visit, made by the frame (routes/messages/_module.mesa)
// before any child reads it: a template that reads `lists.channels.rows` tracks
// the rows, so a pushed channel or membership redraws the pill with no code here.
let lists = null

export function openLists() {
  if (!me()) { lists = null; return null }
  lists = {
    channels: channels.tethered({ state: 'local', all: true }),
    // Everyone's memberships of a readable channel are readable; the reader's own are what count.
    mine:     channelMembers.tethered({ state: 'local', all: true, where: { profileExternalId: me() } }),
    people:   profiles.tethered({ state: 'local', all: true }),
    // Thread rows are one person's view of a thread, and only the reader's own are readable.
    threads:  threads.tethered({ state: 'local', all: true, where: { profileExternalId: me() } }),
    // Own rows only: the schema's policy refuses another person's, so no filter is needed to keep them out.
    drafts:   drafts.tethered({ state: 'local', all: true }),
    saved:    savedPosts.tethered({ state: 'local', all: true }),
    sections: chatSections.tethered({ state: 'local', all: true }),
    // Local to this laptop: own scheduled rows, and every member's groups.
    scheduled: scheduledPosts.tethered({ state: 'local', all: true }),
    groups:   chatGroups.tethered({ state: 'local', all: true }),
    destroy() {
      this.channels.destroy(); this.mine.destroy(); this.people.destroy(); this.threads.destroy()
      this.drafts.destroy(); this.saved.destroy(); this.sections.destroy()
      this.scheduled.destroy(); this.groups.destroy()
      stopTyping()
    },
  }
  startTyping()
  return lists
}

/** The frame's lists; a component reads their `rows` itself, so the read is its own subscription. */
export const getLists = () => lists

// ── People ──
export const nameOf = (p) => p.nickname || [p.firstName, p.lastName].filter(Boolean).join(' ') || p.username

/** What a post is signed with; an id the sync has not landed yet reads as an ellipsis. */
export function personName(externalId, people) {
  const p = people.find((x) => x.externalId === externalId)
  return p ? nameOf(p) : '…'
}

// ── Labels ──
/**
 * `@ Ana` for a direct channel, `@ ana, bo` for a group, `# town-square` for the rest.
 * The server leaves a direct channel's `displayName` empty and names it `<id>__<id>`,
 * so it is named for the other member (a group's displayName is the server's own).
 */
export function channelLabel(c, people, self) {
  if (!c) return ''
  if (c.type === 'direct') {
    const other = (c.name ?? '').split('__').find((id) => id && id !== self)
    const who = people.find((p) => p.externalId === other)
    return '@ ' + (who ? nameOf(who) : other ? '…' : 'Just you')
  }
  return (c.type === 'group' ? '@ ' : '# ') + (c.displayName || c.name)
}

// ── Where the reader stands ──
/**
 * `{ [channelExternalId]: { unread, mentions, lastReadAt, muted } }` for each channel the
 * reader is in; a channel they are not in has no entry, and that is what makes it a preview.
 *
 * Root posts are what a channel counts, as the server's own client does: a reply is counted
 * once, in Threads. A server without root counts answers 0 for them while the channel has
 * posts, and then every post counts. A muted channel has nothing unread but its mentions,
 * which a mute never hides.
 */
export function countsOf(channelList, memberships) {
  const byId = new Map(channelList.map((c) => [c.externalId, c]))
  const out = {}
  for (const m of memberships) {
    const c = byId.get(m.channelExternalId)
    if (!c) continue
    const roots = (c.totalMessageCountRoot ?? 0) > 0 || (c.totalMessageCount ?? 0) === 0
    const unread = roots
      ? (c.totalMessageCountRoot ?? 0) - (m.messageCountRoot ?? 0)
      : (c.totalMessageCount ?? 0) - (m.messageCount ?? 0)
    out[c.externalId] = {
      unread: m.muted ? 0 : Math.max(0, unread),
      mentions: Math.max(0, (roots ? m.mentionCountRoot : m.mentionCount) ?? 0),
      lastReadAt: m.lastViewedAt ?? null,
      muted: !!m.muted,
    }
  }
  return out
}

/**
 * What the nav's Messages entry shows, from the reader's rooms: a number (mentions, plus every
 * unread message of a direct or group room, unmuted or not for a mention), else 'dot' when any
 * unmuted room has unread, else null. A direct room counts the larger of its two numbers: the
 * server may count a DM as a mention too, and one message is one.
 */
export function navBadgeOf(channelList, memberships) {
  const counts = countsOf(channelList, memberships)
  let count = 0
  let dot = false
  for (const c of channelList) {
    const n = counts[c.externalId]
    if (!n || c.deletedAt) continue
    const direct = c.type === 'direct' || c.type === 'group'
    count += direct ? Math.max(n.mentions, n.unread) : n.mentions
    if (n.unread > 0) dot = true
  }
  return count > 0 ? count : dot ? 'dot' : null
}

// ── Opening a channel ──
const LAST = 'workbench_messages_channel'
export const lastChannel = () => { try { return localStorage.getItem(LAST) } catch { return null } }

/**
 * Open a channel: the server stamps the reader's watermark and the sync pushes the new counts
 * back, which is what zeroes the pill.
 */
export async function openChannel(externalId) {
  const prev = chat.activeChannelId
  chat.activeChannelId = externalId
  try { localStorage.setItem(LAST, externalId) } catch {}
  await markRead(externalId, prev)
}

/** Everything in the channel up to now is read: `chat.view` is the one door. */
export async function markRead(externalId, prevChannelExternalId = null) {
  if (!externalId) return
  await link.service.invoke('view', null, {
    channelExternalId: externalId,
    ...(prevChannelExternalId && prevChannelExternalId !== externalId ? { prevChannelExternalId } : {}),
  })
}

// ── Mentions ──
// A known @username is drawn bold; an unknown one stays text. Workbench has no
// profile page to link to yet, and Markdown keeps only same-site links.
// `@channel`, `@all` and `@here` call the room: drawn bold too, never as a person.
const BROADCAST = ['channel', 'all', 'here']
const CALLS = [
  { id: '@channel', handle: 'channel', name: 'Notify everyone in this channel', call: true },
  { id: '@here',    handle: 'here',    name: 'Notify everyone in this channel who is online', call: true },
  { id: '@all',     handle: 'all',     name: 'Notify everyone in this channel', call: true },
]
export function linkMentions(message, people) {
  if (!message || !message.includes('@')) return message
  const byName = new Map(people.map((p) => [p.username.toLowerCase(), p]))
  return message.replace(/(^|[^\w@`])@([a-z0-9][\w.-]*)/gi, (m, pre, name) => {
    const key = name.toLowerCase().replace(/[.-]+$/, '')
    if (BROADCAST.includes(key)) return `${pre}**@${key}**`
    const p = byName.get(key)
    return p ? `${pre}**@${p.username}**` : m
  })
}

/** Whether a post names the reader, by their username or by a call on the room: it is drawn marked. */
export function mentionsMe(post, people, self = me()) {
  if (!post?.message || !post.message.includes('@') || post.profileExternalId === self) return false
  const mine = people.find((p) => p.externalId === self)?.username?.toLowerCase()
  for (const m of post.message.matchAll(/(?:^|[^\w@`])@([a-z0-9][\w.-]*)/gi)) {
    const key = m[1].toLowerCase().replace(/[.-]+$/, '')
    if (BROADCAST.includes(key) || key === mine) return true
  }
  return false
}

// ── The @ picker ──
// Shared by the composer and the post editor. The people of the channel come first, then
// everyone else the mirror holds, then the calls on the room; each by the prefix typed
// after the `@`, matching a username, a first name or a display name.
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
export const handleFor = (p) => p.username

/** A Json column's list: the array, or the text of one. */
export const idsOf = (v) => {
  if (Array.isArray(v)) return v
  try { const a = JSON.parse(v ?? '[]'); return Array.isArray(a) ? a : [] } catch { return [] }
}

export function mentionMatches(prefix, people, memberIds = [], inChannel = false, groups = []) {
  const q = norm(prefix)
  const here = new Set(memberIds)
  const hit = (p) => !p.deletedAt && (!q || [p.username, p.firstName, p.lastName, nameOf(p)].some(x => norm(x).startsWith(q)))
  const found = people.filter(hit)
  const byName = (a, b) => nameOf(a).localeCompare(nameOf(b))
  const first = found.filter(p => here.has(p.externalId)).sort(byName)
  const rest = found.filter(p => !here.has(p.externalId)).sort(byName)
  const calls = inChannel ? CALLS.filter(c => !q || c.handle.startsWith(q)) : []
  const named = groups.filter(g => !q || [g.handle, g.name].some(x => norm(x).startsWith(q))).sort((a, b) => a.handle.localeCompare(b.handle)).slice(0, 4)
    .map(g => ({ id: `group:${g.handle}`, handle: g.handle, name: g.name, group: true, count: idsOf(g.profileExternalIds).length }))
  return [...first, ...rest].slice(0, 8).map(x => ({ id: x.externalId, handle: x.username, name: nameOf(x), inChannel: here.has(x.externalId) })).concat(named, calls)
}

/** The picker for the `@` behind the caret, or null: `{ at, prefix, items, index }`. */
export function mentionAt(text, caret, people, memberIds = [], inChannel = false, groups = []) {
  const at = text.lastIndexOf('@', caret - 1)
  if (at < 0 || (at > 0 && /[\w@]/.test(text[at - 1]))) return null
  const prefix = text.slice(at + 1, caret)
  if (/\s/.test(prefix)) return null
  const items = mentionMatches(prefix, people, memberIds, inChannel, groups)
  return items.length ? { at, prefix, items, index: 0 } : null
}

/**
 * Each `@handle` that names a group becomes `@handle (@ana @bo)`: the group exists only in
 * Workbench, so a reader on another client sees who was called. A username of the same
 * spelling wins, and so does a call on the room.
 */
export function expandGroups(message, groups, people) {
  if (!message || !message.includes('@') || !groups.length) return message
  const byHandle = new Map(groups.map(g => [g.handle.toLowerCase(), g]))
  const names = new Set(people.map(p => p.username.toLowerCase()))
  return message.replace(/(^|[^\w@`])@([a-z0-9][\w.-]*)/gi, (m, pre, name) => {
    const whole = name.toLowerCase()
    const key = byHandle.has(whole) ? whole : whole.replace(/[.-]+$/, '')
    const g = byHandle.get(key)
    if (!g || names.has(key) || BROADCAST.includes(key)) return m
    const who = idsOf(g.profileExternalIds).map(id => people.find(p => p.externalId === id)).filter(p => p && !p.deletedAt).map(p => '@' + p.username)
    return who.length ? `${pre}@${key} (${who.join(' ')})${name.slice(key.length)}` : m
  })
}

/** The text with the picked name in place of the typed `@prefix`, and where the caret goes. */
export function applyMention(text, picker, item) {
  const put = '@' + item.handle + ' '
  return { text: text.slice(0, picker.at) + put + text.slice(picker.at + 1 + picker.prefix.length), caret: picker.at + put.length }
}

/**
 * A key while the picker is open: the picker after it (null closes it), 'pick' for the
 * highlighted one, or undefined when the key is not the picker's.
 */
export function pickerKey(picker, e) {
  const n = picker.items.length
  if (e.key === 'ArrowDown') return { ...picker, index: (picker.index + 1) % n }
  if (e.key === 'ArrowUp')   return { ...picker, index: (picker.index - 1 + n) % n }
  if (e.key === 'Tab' || e.key === 'Enter') return 'pick'
  if (e.key === 'Escape') return null
  return undefined
}

/** A channel's memberships, as a tether of their own: the people the picker offers first. */
export const watchMembers = (channelExternalId) => channelMembers.tethered({ state: 'local', all: true, where: { channelExternalId } })

// ── Verbs on the chat service ──
// Each is the server's own answer: a refusal (403, 404, 502) reaches the caller as an
// error with the server's words, and nothing here guesses at a time window.
const say = (method, data) => link.service.invoke(method, null, data)

export const readThread = (rootExternalId) => say('readThread', { rootExternalId })
export const setPinned = (post, pinned) => say('pin', { postExternalId: post.externalId, pinned })
export const setFollowing = (rootExternalId, following) => say('follow', { rootExternalId, following })
export const setMuted = (channelExternalId, muted) => say('mute', { channelExternalId, muted })

/**
 * The channel reads as unread from this post. The channel on screen would be read again the
 * moment the count moved, so it is held: the reader leaving the channel, or sending, ends it.
 */
export async function markUnread(post) {
  chat.held = { ...chat.held, [post.channelExternalId]: true }
  try { await say('markUnread', { postExternalId: post.externalId }) }
  catch (e) { release(post.channelExternalId); throw e }
}
export function release(channelExternalId) {
  if (!(channelExternalId in chat.held)) return
  const { [channelExternalId]: _, ...rest } = chat.held
  chat.held = rest
}

/** A post's thread, from its own or its root's id: the root is the thread's key. */
export const rootOf = (post) => post.rootExternalId ?? post.externalId
export const threadHref = (post) => `/messages/${post.channelExternalId}/?thread=${rootOf(post)}`

// ── Reactions ──
/**
 * `[{ name, count, mine, who }]` in the order each name was first used, from a post's
 * Reaction rows: one chip per name, `mine` when the reader gave it.
 */
export function reactionChips(rows, self, people) {
  const by = new Map()
  for (const r of rows) {
    const c = by.get(r.emojiName) ?? { name: r.emojiName, count: 0, mine: false, names: [] }
    c.count++
    if (r.profileExternalId === self) c.mine = true
    c.names.push(r.profileExternalId === self ? 'You' : personName(r.profileExternalId, people))
    by.set(r.emojiName, c)
  }
  return [...by.values()].map(c => ({ ...c, who: c.names.join(', ') }))
}

/**
 * React, or take it back when the reader already did; the row lands back by its push. The
 * create names its profile because the schema's policy compares it to the caller's before
 * the server is asked.
 */
export async function toggleReaction(post, name, rows, self) {
  const mine = rows.find(r => r.emojiName === name && r.profileExternalId === self)
  if (mine) await reactions.service.remove(mine.id)
  else await reactions.service.create({ postExternalId: post.externalId, profileExternalId: self, emojiName: name })
}

// ── Making and leaving channels ──
const joinedBy = (rows, channelExternalId) => rows.find(m => m.channelExternalId === channelExternalId)

/** The team a new channel is made in: the one any channel the reader is in belongs to (a direct channel has none). */
export const teamOf = (channelList) => channelList.find(c => c.teamExternalId && !c.deletedAt)?.teamExternalId ?? null

/** Open the direct channel with one person, or a group with two to seven; answers its id. */
export async function openDirect(profileExternalIds) {
  const r = await say('openDirect', { profileExternalIds })
  return r.channelExternalId
}

/** Make a channel on the server as the reader; answers its id. `name` is the slug, `displayName` what is typed. */
export async function createChannel({ teamExternalId, displayName, purpose, isPrivate }) {
  const name = slugOf(displayName)
  const made = await channels.service.create({ teamExternalId, name, displayName: displayName.trim(), purpose: purpose?.trim() || '', type: isPrivate ? 'private' : 'open' })
  if (made?.externalId) return made.externalId
  // A private channel is readable by its members, and the creator's own membership arrives by the
  // socket after the answer, so the answer is empty: the channel is found when its row lands.
  const end = Date.now() + 8000
  while (Date.now() < end) {
    const row = lists?.channels.rows.find(c => c.name === name && c.teamExternalId === teamExternalId)
    if (row) return row.externalId
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('The channel was made, but has not reached this screen yet. Reload to see it.')
}

/** The server's channel name: lower case, hyphens for spaces. */
export const slugOf = (s) => String(s ?? '').trim().toLowerCase().replace(/^#+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)

/** The open channels of the reader's team they are not in; the server lands each as a row. */
export const browseChannels = async () => (await link.service.invoke('browse', null, {})).channels

export const joinChannel = (channelExternalId) => channelMembers.service.create({ channelExternalId, profileExternalId: me() })

/** Leave: take the reader's own membership row away. */
export async function leaveChannel(channelExternalId, memberships) {
  const mine = joinedBy(memberships, channelExternalId)
  if (!mine) throw new Error('You are not in that channel.')
  await channelMembers.service.remove(mine.id)
}

/**
 * Where the screen goes with no channel named: the last one this browser had open, else
 * Town Square, else the first by name, never `except` (a channel just left). Null when the reader is in none.
 */
export function landingChannel(channelList, memberships, except = null) {
  const byId = new Map(channelList.map(c => [c.externalId, c]))
  const mine = memberships.map(m => m.channelExternalId).filter(id => id !== except && byId.has(id) && !byId.get(id).deletedAt)
  const want = lastChannel()
  if (want && mine.includes(want)) return want
  const name = (id) => String(byId.get(id).name)
  return mine.slice().sort((a, b) => (name(a) === 'town-square' ? -1 : name(b) === 'town-square' ? 1 : name(a).localeCompare(name(b))))[0] ?? null
}

/** Wait for a channel the reader just made or opened to reach the lists, so the screen opening it does not find it missing. */
export async function whenListed(channelExternalId, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (lists?.channels.rows.some(c => c.externalId === channelExternalId) && lists.mine.rows.some(m => m.channelExternalId === channelExternalId)) return
    await new Promise(r => setTimeout(r, 100))
  }
}

// ── Drafts ──
export const saveDraft = ({ channelExternalId, rootExternalId, message, fileExternalIds }) =>
  say('saveDraft', { channelExternalId, ...(rootExternalId ? { rootExternalId } : {}), message, ...(fileExternalIds?.length ? { fileExternalIds } : {}) })
export const deleteDraft = ({ channelExternalId, rootExternalId }) =>
  say('deleteDraft', { channelExternalId, ...(rootExternalId ? { rootExternalId } : {}) })

/** The draft for one box, a room's (no root) or a thread's. */
export const draftFor = (rows, channelExternalId, rootExternalId = null) =>
  rows.find(d => d.channelExternalId === channelExternalId && (d.rootExternalId || null) === (rootExternalId || null)) ?? null

/** A draft is a row with something typed; the server keeps no empty one. */
export const liveDrafts = (rows) => rows.filter(d => String(d.message ?? '').trim())

// ── Scheduled posts ──
// Local to this laptop: a job on the API sends each row as the reader at its time.
// A row that is not `scheduled` is history; the API refuses to change it (409).
export const localInput = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16) }

/** The times the Send later menu offers, from `now`. */
export function laterChoices(now = new Date()) {
  const at = (days) => { const t = new Date(now); t.setDate(t.getDate() + days); t.setHours(9, 0, 0, 0); return t }
  const toMonday = ((8 - now.getDay()) % 7) || 7
  return [
    { key: '1h',       label: 'In 1 hour',        at: new Date(now.getTime() + 3_600_000) },
    { key: 'tomorrow', label: 'Tomorrow, 9:00',   at: at(1) },
    { key: 'monday',   label: 'Monday, 9:00',     at: at(toMonday) },
  ]
}

export const scheduleSend = ({ channelExternalId, rootExternalId, message, fileExternalIds, at }) =>
  scheduledPosts.service.create({
    channelExternalId, ...(rootExternalId ? { rootExternalId } : {}), message,
    ...(fileExternalIds?.length ? { fileExternalIds } : {}), sendAt: at.toISOString(),
  })
export const editScheduled = (row, message) => scheduledPosts.service.patch(row.id, { message })
export const cancelScheduled = (row) => scheduledPosts.service.patch(row.id, { status: 'cancelled' })
export const dropScheduled = (row) => scheduledPosts.service.remove(row.id)

/** A waiting row moves its time; a failed or cancelled one is closed to the API, so it is written again and the old row goes. */
export async function rescheduleScheduled(row, at) {
  if (row.status === 'scheduled') return scheduledPosts.service.patch(row.id, { sendAt: at.toISOString() })
  await scheduleSend({ channelExternalId: row.channelExternalId, rootExternalId: row.rootExternalId, message: row.message, fileExternalIds: idsOf(row.fileExternalIds), at })
  await scheduledPosts.service.remove(row.id)
}

// ── Groups ──
export const makeGroup = ({ handle, name, profileExternalIds }) => chatGroups.service.create({ handle, name, profileExternalIds })
export const changeGroup = (group, fields) => chatGroups.service.patch(group.id, fields)
export const dropGroup = (group) => chatGroups.service.remove(group.id)

// ── Saved ──
export const setSaved = (post, saved) => say('save', { postExternalId: post.externalId, saved })
/** The saved list newest first; the call also lands the posts, so they are readable by externalId. */
export const listSaved = async () => (await say('saved', {})).postExternalIds ?? []

// ── Search, activity, history, reminders ──
// Each answer names posts by externalId and has landed them in the mirror, so a screen reads
// them back through `postsById` and an edit or a reaction on one is a push.
export const searchPosts = async (terms) => (await say('search', { terms })).postExternalIds ?? []
/** `{ mentions, threads }`: the posts naming the reader, and the roots of followed threads with unread replies. */
export const loadActivity = async () => { const a = await say('activity', {}); return { mentions: a.mentions ?? [], threads: a.threads ?? [] } }
/** The earlier versions of one of the reader's own posts, newest first; another person's post is the server's 404. */
export const editHistory = async (post) => (await say('editHistory', { postExternalId: post.externalId })).versions ?? []
export const remindAt = (post, at) => say('remind', { postExternalId: post.externalId, at: at.toISOString() })

/** A tether over posts landed by id; null for none, which is not a read of everything. */
export const postsById = (ids) => ids.length ? posts.tethered({ state: 'local', all: true, where: { externalId: { in: ids } }, directives: { limit: 200 } }) : null

const IN_MINUTES = (n) => () => new Date(Date.now() + n * 60_000)
const TOMORROW = () => { const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(9, 0, 0, 0); return t }
export const REMINDERS = [
  { key: '30m',      label: 'In 30 minutes', when: IN_MINUTES(30) },
  { key: '1h',       label: 'In 1 hour',     when: IN_MINUTES(60) },
  { key: '3h',       label: 'In 3 hours',    when: IN_MINUTES(180) },
  { key: 'tomorrow', label: 'Tomorrow, 9:00', when: TOMORROW },
]

// ── Link previews ──
/** An http(s) URL as the browser parses it, or null: nothing else becomes a link or an image source. */
export function safeUrl(u) {
  try { const x = new URL(String(u)); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null } catch { return null }
}

/** A post's previews as `[{ type, url, title, description, image, siteName }]`, each URL already checked. */
export function embedsOf(post) {
  let raw = post?.embeds
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { raw = [] } }
  if (!Array.isArray(raw)) return []
  return raw.map(e => ({ ...e, url: safeUrl(e?.url), image: safeUrl(e?.image) }))
    .filter(e => e.url && (e.type === 'image' || e.type === 'opengraph'))
    .slice(0, 3)
}

// ── Favorites and sections ──
export const setFavorite = (channelExternalId, favorite) => say('favorite', { channelExternalId, favorite })
export const createSection = (teamExternalId, name, channelExternalIds) => say('createSection', { teamExternalId, name, ...(channelExternalIds?.length ? { channelExternalIds } : {}) })
export const renameSection = (sectionExternalId, name) => say('renameSection', { sectionExternalId, name })
export const deleteSection = (sectionExternalId) => say('deleteSection', { sectionExternalId })
export const moveToSection = (channelExternalId, sectionExternalId) => say('moveToSection', { channelExternalId, sectionExternalId })
export const SECTION_NAME_MAX = 22

// ── Status ──
export const STATUS = {
  online:  { tone: 'success', label: 'Online' },
  away:    { tone: 'warning', label: 'Away' },
  dnd:     { tone: 'danger',  label: 'Do not disturb' },
  offline: { tone: '',        label: 'Offline' },
}
/** A profile's presence; null is never read, and reads as offline. */
export const statusOf = (p) => STATUS[p?.status] ? p.status : 'offline'

/** The custom status that has not run out, as `{ emoji, text }`, or null. */
export function customOf(p) {
  if (!p || !(p.customEmoji || p.customText)) return null
  if (p.customExpiresAt && new Date(p.customExpiresAt) <= new Date()) return null
  return { emoji: p.customEmoji ? glyphOf(p.customEmoji) : '', text: p.customText ?? '' }
}
export const statusLine = (p) => { const c = customOf(p); return c ? [c.emoji, c.text].filter(Boolean).join(' ') : '' }

export const setStatus = (status, dndEndAt) => say('setStatus', { status, ...(dndEndAt ? { dndEndAt: dndEndAt.toISOString() } : {}) })
export const setCustomStatus = ({ emoji, text, expiresAt }) => say('setCustomStatus', { ...(emoji ? { emoji } : {}), ...(text ? { text } : {}), ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}) })

/** The other person of a direct channel, by the `<id>__<id>` name; a group has none. */
export const peerOf = (c, self) => c?.type === 'direct' ? ((c.name ?? '').split('__').find(id => id && id !== self) ?? null) : null

/** Ask the server for these people's presence now; it lands on their Profile rows. */
export const refreshStatuses = (profileExternalIds) => {
  const ids = [...new Set(profileExternalIds.filter(Boolean))].slice(0, 200)
  return ids.length ? say('statuses', { profileExternalIds: ids }) : Promise.resolve()
}

// ── Typing (receive only) ──
// A `chat typing` frame is nothing stored: who, where, and when this screen heard it.
// The line stays up for TYPING_FOR after the last one; a one-second clock is what takes it down.
export const TYPING_FOR = 5_000
export const typing = watchProxy({ seen: {}, now: Date.now() })
const boxKey = (channelExternalId, rootExternalId) => `${channelExternalId}|${rootExternalId || ''}`
let offTyping = null
let tick = null

function startTyping() {
  stopTyping()
  const heard = (e) => {
    if (!e?.channelExternalId || !e.profileExternalId) return
    const now = Date.now()
    typing.now = now
    typing.seen = { ...typing.seen, [`${boxKey(e.channelExternalId, e.rootExternalId)}|${e.profileExternalId}`]: now }
  }
  offTyping = link.service.on('typing', heard)
  tick = setInterval(() => {
    const now = Date.now()
    typing.now = now
    const live = Object.entries(typing.seen).filter(([, t]) => now - t < TYPING_FOR)
    if (live.length !== Object.keys(typing.seen).length) typing.seen = Object.fromEntries(live)
  }, 1000)
}
function stopTyping() {
  if (typeof offTyping === 'function') offTyping()
  offTyping = null
  if (tick) clearInterval(tick)
  tick = null
}

/** The names typing in one box right now, never the reader. */
export function typingNames(channelExternalId, rootExternalId, people, self = me()) {
  const prefix = boxKey(channelExternalId, rootExternalId) + '|'
  const out = []
  for (const [k, t] of Object.entries(typing.seen)) {
    if (!k.startsWith(prefix) || typing.now - t >= TYPING_FOR) continue
    const id = k.slice(prefix.length)
    if (id !== self) out.push(personName(id, people))
  }
  return out
}

/** The line under a box: one name, two, or "Several people". */
export function typingLine(names) {
  if (!names.length) return ''
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  return 'Several people are typing…'
}
