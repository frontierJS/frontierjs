// test/mail-received.test.ts
//
// The receiving half of the mail battery (`FJS-D1091`, `FJS-D1092`): the
// reply tag that threads a reply onto the record it answers, and the shape a
// vendor's dialect parses to. The round trip over two real dialects is the
// chatwoot stressor's `api/test/mail.test.ts` (`FJS-D1093`); this file holds
// what every app would otherwise hand-roll — the address arithmetic, the
// case folding, and the three ways a tag fails to read.

import { describe, expect, it } from 'bun:test'
import { generateUlid } from '@frontierjs/toolbelt/ids'
import {
  headerOf, replyAddress, splitAddress, readReplyTag, LOCAL_PART_MAX, type ReceivedMail,
} from '../src/mail/index.ts'

const SECRET = 'a-secret-the-app-holds'
const TTL    = 14 * 86_400
const now    = () => Math.floor(Date.now() / 1000)

describe('replyAddress', () => {
  it('mints base+<token>@domain, lower-case, within a 64-octet local part', async () => {
    const id   = generateUlid()
    const addr = await replyAddress('support@acme.test', id, SECRET)
    const [local, domain] = addr.split('@')
    expect(domain).toBe('acme.test')
    expect(local.startsWith(`support+${id.toLowerCase()}`)).toBe(true)
    expect(local).toBe(local.toLowerCase())
    expect(local.length).toBeLessThanOrEqual(LOCAL_PART_MAX)
  })

  it('fits exactly at a 21-character mailbox and refuses a 22-character one before anything is sent', async () => {
    const id = generateUlid()
    const ok = await replyAddress(`${'x'.repeat(21)}@acme.test`, id, SECRET)
    expect(ok.split('@')[0]).toHaveLength(LOCAL_PART_MAX)
    await expect(replyAddress(`${'x'.repeat(22)}@acme.test`, id, SECRET)).rejects.toThrow(/at most 64/)
  })

  it('refuses a base that is not a bare address, or already carries a tag', async () => {
    const id = generateUlid()
    await expect(replyAddress('Support <support@acme.test>', id, SECRET)).rejects.toThrow(/bare address/)
    await expect(replyAddress('support+vip@acme.test', id, SECRET)).rejects.toThrow(/already carries a plus-tag/)
    await expect(replyAddress('support@acme.test', 'not-a-ulid!', SECRET)).rejects.toThrow(/Crockford/)
  })
})

describe('splitAddress', () => {
  it('folds case and splits the tag off the local part', () => {
    expect(splitAddress('Support+ABC@Acme.Test')).toEqual({ base: 'support@acme.test', tag: 'abc' })
    expect(splitAddress('support@acme.test')).toEqual({ base: 'support@acme.test', tag: null })
  })

  it('reduces a display-name form to its address, and an empty tag to none', () => {
    expect(splitAddress('Acme Support <support+t1@acme.test>')).toEqual({ base: 'support@acme.test', tag: 't1' })
    expect(splitAddress('support+@acme.test')).toEqual({ base: 'support@acme.test', tag: null })
  })

  it('answers rather than throws for a string that is not an address', () => {
    expect(splitAddress('')).toEqual({ base: '', tag: null })
    expect(splitAddress('nonsense')).toEqual({ base: 'nonsense', tag: null })
  })
})

describe('readReplyTag', () => {
  it('reads the id back upper-case, whatever case the tag came back in', async () => {
    const id  = generateUlid()
    const tag = splitAddress(await replyAddress('support@acme.test', id, SECRET)).tag!
    expect(await readReplyTag(tag, { secret: SECRET, now: now(), ttlSeconds: TTL })).toEqual({ ok: true, id })
    expect(await readReplyTag(tag.toUpperCase(), { secret: SECRET, now: now(), ttlSeconds: TTL })).toEqual({ ok: true, id })
  })

  it('a changed character, another secret, or a plain id with no MAC is forged or malformed — never threaded', async () => {
    const id  = generateUlid()
    const tag = splitAddress(await replyAddress('support@acme.test', id, SECRET)).tag!
    const flipped = tag.slice(0, -1) + (tag.endsWith('0') ? '1' : '0')
    expect(await readReplyTag(flipped, { secret: SECRET, now: now(), ttlSeconds: TTL })).toEqual({ ok: false, reason: 'forged' })
    expect(await readReplyTag(tag, { secret: 'another', now: now(), ttlSeconds: TTL })).toEqual({ ok: false, reason: 'forged' })
    expect(await readReplyTag('vip', { secret: SECRET, now: now(), ttlSeconds: TTL })).toEqual({ ok: false, reason: 'malformed' })
    expect(await readReplyTag(id.toLowerCase(), { secret: SECRET, now: now(), ttlSeconds: TTL })).toEqual({ ok: false, reason: 'malformed' })
  })

  it('expires from the instant in the ULID, with no bits of its own, and forged is graded first', async () => {
    const id  = generateUlid()
    const tag = splitAddress(await replyAddress('support@acme.test', id, SECRET)).tag!
    const later = now() + TTL + 60
    expect(await readReplyTag(tag, { secret: SECRET, now: later, ttlSeconds: TTL })).toEqual({ ok: false, reason: 'expired' })
    const flipped = tag.slice(0, -1) + (tag.endsWith('0') ? '1' : '0')
    expect(await readReplyTag(flipped, { secret: SECRET, now: later, ttlSeconds: TTL })).toEqual({ ok: false, reason: 'forged' })
  })

  it('requires a TTL, and seconds rather than milliseconds for now', async () => {
    const tag = splitAddress(await replyAddress('support@acme.test', generateUlid(), SECRET)).tag!
    await expect(readReplyTag(tag, { secret: SECRET, now: now() } as never)).rejects.toThrow(/ttlSeconds is required/)
    await expect(readReplyTag(tag, { secret: SECRET, now: Date.now(), ttlSeconds: TTL })).rejects.toThrow(/seconds/)
  })
})

describe('ReceivedMail', () => {
  it('is MailMessage read the other way, with Message-ID and In-Reply-To in headers', () => {
    const mail: ReceivedMail = {
      recipient: 'support+t1@acme.test',
      to:        'Acme Support <support+t1@acme.test>',
      from:      'Ada Customer <ada@example.test>',
      subject:   'Re: Your order',
      text:      'Where is it?',
      headers:   { 'message-id': '<abc@example.test>', 'In-Reply-To': ' <xyz@acme.test> ' },
      attachments: [{ filename: 'receipt.pdf', content: new Uint8Array([1]), type: 'application/pdf' }],
    }
    expect(headerOf(mail, 'Message-ID')).toBe('<abc@example.test>')
    expect(headerOf(mail, 'in-reply-to')).toBe('<xyz@acme.test>')
    expect(headerOf(mail, 'References')).toBeNull()
    expect(splitAddress(mail.recipient).base).toBe('support@acme.test')
  })
})
