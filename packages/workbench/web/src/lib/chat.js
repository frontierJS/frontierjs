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
import { chat as link } from '../resources/Chat.mesa'

/** The channel on screen, so the sidebar marks it and a post arriving in it is read at once. */
export const chat = watchProxy({ activeChannelId: null })

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
    destroy() { this.channels.destroy(); this.mine.destroy(); this.people.destroy() },
  }
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
export function linkMentions(message, people) {
  if (!message || !message.includes('@')) return message
  const byName = new Map(people.map((p) => [p.username.toLowerCase(), p]))
  return message.replace(/(^|[^\w@`])@([a-z0-9][\w.-]*)/gi, (m, pre, name) => {
    const p = byName.get(name.toLowerCase().replace(/[.-]+$/, ''))
    return p ? `${pre}**@${p.username}**` : m
  })
}
