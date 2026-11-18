// The quiet-hours window and the notice rule a live chat post is judged by
// (`domain/chat/notice.ts`). Pure: no app, no socket, no ntfy.

import { describe, expect, test } from 'bun:test'
import { excerpt, inQuietHours, noticeExcerpt, noticeKind } from '../src/domain/chat/notice.ts'

const UTC = 'UTC'
const at = (iso: string) => new Date(iso)
// 2026-11-20 is a Friday (5); 2026-11-21 a Saturday (6); 2026-11-22 a Sunday (0).

describe('inQuietHours', () => {
  const night = { isEnabled: true, days: [5], fromMinute: 22 * 60, toMinute: 7 * 60, timezone: UTC }

  test('a window crossing midnight holds both halves of its start day', () => {
    expect(inQuietHours(night, at('2026-11-20T23:00:00Z'))).toBe(true)
    expect(inQuietHours(night, at('2026-11-21T03:00:00Z'))).toBe(true)
  })

  test('its morning half belongs to the day before, not the day it falls on', () => {
    expect(inQuietHours(night, at('2026-11-22T03:00:00Z'))).toBe(false)
    expect(inQuietHours(night, at('2026-11-20T03:00:00Z'))).toBe(false)
  })

  test('the end minute is outside and the start minute inside', () => {
    expect(inQuietHours(night, at('2026-11-21T07:00:00Z'))).toBe(false)
    expect(inQuietHours(night, at('2026-11-20T22:00:00Z'))).toBe(true)
    expect(inQuietHours(night, at('2026-11-20T21:59:00Z'))).toBe(false)
  })

  test('a same-day window holds only its own minutes', () => {
    const lunch = { isEnabled: true, days: [5], fromMinute: 12 * 60, toMinute: 13 * 60, timezone: UTC }
    expect(inQuietHours(lunch, at('2026-11-20T12:30:00Z'))).toBe(true)
    expect(inQuietHours(lunch, at('2026-11-20T13:30:00Z'))).toBe(false)
    expect(inQuietHours(lunch, at('2026-11-21T12:30:00Z'))).toBe(false)
  })

  test('the minute is read in the schedule zone', () => {
    const chicago = { isEnabled: true, days: [5], fromMinute: 22 * 60, toMinute: 23 * 60, timezone: 'America/Chicago' }
    expect(inQuietHours(chicago, at('2026-11-21T04:30:00Z'))).toBe(true)
    expect(inQuietHours(chicago, at('2026-11-20T22:30:00Z'))).toBe(false)
  })

  test('disabled, absent, no days or an unknown zone hold nothing', () => {
    expect(inQuietHours({ ...night, isEnabled: false }, at('2026-11-20T23:00:00Z'))).toBe(false)
    expect(inQuietHours(null, at('2026-11-20T23:00:00Z'))).toBe(false)
    expect(inQuietHours({ ...night, days: [] }, at('2026-11-20T23:00:00Z'))).toBe(false)
    expect(inQuietHours({ ...night, timezone: 'Nowhere/Else' }, at('2026-11-20T23:00:00Z'))).toBe(false)
  })

  test('equal ends are the whole day', () => {
    expect(inQuietHours({ isEnabled: true, days: [5], fromMinute: 0, toMinute: 0, timezone: UTC }, at('2026-11-20T15:00:00Z'))).toBe(true)
  })
})

describe('noticeKind', () => {
  const base = { author: 'bob', member: 'alice', username: 'alice', roomType: 'open', muted: false, message: 'hi' }

  test('a direct or group room owes a DM; their own post owes nothing', () => {
    expect(noticeKind({ ...base, roomType: 'direct' })).toBe('dm')
    expect(noticeKind({ ...base, roomType: 'group' })).toBe('dm')
    expect(noticeKind({ ...base, roomType: 'direct', author: 'alice' })).toBeNull()
  })

  test('@username owes a mention even muted; @channel only unmuted', () => {
    expect(noticeKind({ ...base, message: 'ping @alice' })).toBe('mention')
    expect(noticeKind({ ...base, message: 'ping @alice', muted: true })).toBe('mention')
    expect(noticeKind({ ...base, message: '@channel standup' })).toBe('mention')
    expect(noticeKind({ ...base, message: '@here standup', muted: true })).toBeNull()
    expect(noticeKind({ ...base, message: 'hi', muted: false })).toBeNull()
  })

  test('a longer name or an email address is not the member', () => {
    expect(noticeKind({ ...base, message: '@alicex there' })).toBeNull()
    expect(noticeKind({ ...base, message: 'mail bob@alice.com' })).toBeNull()
  })
})

test('excerpt is one plain line of at most 140 characters', () => {
  expect(excerpt('**bold** and [a link](http://x)\n\nnext')).toBe('bold and a link next')
  const long = excerpt('x'.repeat(300))
  expect(long.length).toBe(140)
  expect(long.endsWith('…')).toBe(true)
})

test('a notice carries post text from an open room only', () => {
  expect(noticeExcerpt('open', 'ship it')).toBe('ship it')
  for (const type of ['private', 'direct', 'group']) expect(noticeExcerpt(type, 'ship it')).toBe('')
})
