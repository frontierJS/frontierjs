// The mail() plugin grades every message before ANY mailer sees it, so a mailer an
// app wrote (a stub, a capture double, a connector's adapter) cannot be handed a
// CRLF in a cc or a bad content id.

import { describe, expect, it } from 'bun:test'
import { mail, type IMail, type MailMessage } from '../src/mail/index.ts'

function appWith() {
  const sent: MailMessage[] = []
  const mailer: IMail = {
    async send(m)   { sent.push(m); return { id: '1', messageId: '<1@test>', message: 'sent' } },
    async batch(ms) { sent.push(...ms); return ms.map(() => ({ id: '1', messageId: '<1@test>', message: 'sent' })) },
  }
  const app: any = {}
  mail({ mailer }).register!(app)
  return { app, sent }
}

const OK = { to: 'a@example.test', subject: 's', text: 't' }

describe('app.mail grades a message for any mailer', () => {
  it('passes a clean message, with or without a from', async () => {
    const { app, sent } = appWith()
    await app.mail.send(OK)
    await app.mail.send({ ...OK, from: 'Shop <no-reply@example.test>', cc: ['b@example.test'], replyTo: 'r@example.test' })
    expect(sent.length).toBe(2)
  })

  it('refuses a line break in a cc, a bcc, a to, a replyTo and a subject', async () => {
    const { app, sent } = appWith()
    for (const bad of [
      { cc: 'x@example.test\r\nBcc: y@evil.test' },
      { bcc: ['ok@example.test', 'x@example.test\nBcc: y@evil.test'] },
      { to: 'x@example.test\r\nBcc: y@evil.test' },
      { replyTo: 'x@example.test\r\nBcc: y@evil.test' },
      { subject: 'hi\r\nBcc: y@evil.test' },
    ]) await expect(app.mail.send({ ...OK, ...bad })).rejects.toThrow()
    expect(sent.length).toBe(0)
  })

  it('refuses a cc that is not an address', async () => {
    const { app, sent } = appWith()
    await expect(app.mail.send({ ...OK, cc: 'not-an-address' })).rejects.toThrow()
    expect(sent.length).toBe(0)
  })

  it('refuses one bad message in a batch before any is handed over', async () => {
    const { app, sent } = appWith()
    await expect(app.mail.batch([OK, { ...OK, cc: 'x@example.test\r\nBcc: y@evil.test' }])).rejects.toThrow()
    expect(sent.length).toBe(0)
  })

  it('grades inline attachments: a bad content id, and a cid with no html', async () => {
    const { app, sent } = appWith()
    const png = new Uint8Array([1])
    await expect(app.mail.send({ ...OK, html: '<p>x</p>', attachments: [{ filename: 'c.png', content: png, cid: 'a>b' }] })).rejects.toThrow(/content id/)
    await expect(app.mail.send({ ...OK, attachments: [{ filename: 'c.png', content: png, cid: 'chart' }] })).rejects.toThrow(/needs an html body/)
    await app.mail.send({ ...OK, html: '<img src="cid:chart">', attachments: [{ filename: 'c.png', content: png, cid: 'chart' }] })
    expect(sent.length).toBe(1)
  })
})
