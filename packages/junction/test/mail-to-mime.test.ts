// test/mail-to-mime.test.ts
//
// `toMime` is the message SMTP would send after DATA, for a transport that
// takes a whole message (Graph's sendMail, SES's SendRawEmail). Graded as the
// text a receiver would parse: both alternatives, Reply-To, the caller's own
// header, a Message-ID, no Bcc line — and the same refusals as the SMTP path.

import { describe, expect, it } from 'bun:test'
import { toMime } from '../src/mail/index.ts'

const base = { from: 'Office <office@ela.test>', to: 'casey@example.test', subject: 'How did we do?' }

describe('toMime', () => {
  it('writes text and HTML as alternatives, with Reply-To and the caller\'s header', () => {
    const { raw, messageId } = toMime({ ...base, html: '<p>Hi</p>', text: 'Hi', replyTo: 'surveys@ela.test', headers: { 'x-ela-message-id': '42' } })
    const head = raw.slice(0, raw.indexOf('\r\n\r\n'))
    expect(head).toContain('From: Office <office@ela.test>')
    expect(head).toContain('To: casey@example.test')
    expect(head).toContain('Reply-To: surveys@ela.test')
    expect(head).toContain('x-ela-message-id: 42')
    expect(head).toMatch(/Content-Type: multipart\/alternative; boundary="[^"]+"/)
    expect(head).toContain(`Message-ID: ${messageId}`)
    expect(messageId).toMatch(/^<[0-9a-f-]+@ela\.test>$/)
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8')
    expect(raw).toContain('Content-Type: text/html; charset=UTF-8')
  })

  it('keeps a stated Message-ID, and writes no Bcc line', () => {
    const { raw, messageId } = toMime({ ...base, text: 'Hi', bcc: 'hidden@example.test', headers: { 'Message-ID': '<mine@ela.test>' } })
    expect(messageId).toBe('<mine@ela.test>')
    expect(raw.match(/Message-ID:/gi)).toHaveLength(1)
    expect(raw).not.toContain('hidden@example.test')
  })

  it('refuses a line break in an address, as the SMTP path does', () => {
    expect(() => toMime({ ...base, text: 'Hi', replyTo: 'a@b.test\r\nBcc: victim@c.test' })).toThrow()
    expect(() => toMime({ ...base, text: 'Hi', headers: { 'Bad Name': 'x' } })).toThrow()
  })
})
