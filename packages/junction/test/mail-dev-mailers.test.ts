// createCaptureMailer / createLogMailer — the `IMail`s that send nothing. They
// must refuse what a real mailer refuses, or a test passes on a message SMTP
// would have rejected (`FJS-904`).

import { describe, expect, it } from 'bun:test'
import { createCaptureMailer, createLogMailer, mail, createMessage } from '../src/mail/index.ts'

const msg = { to: 'sam@example.com', subject: 'Hello', text: 'Body line' }

describe('createCaptureMailer', () => {
  it('keeps the message as sent, with the resolved sender, Message-ID and time', async () => {
    const m = createCaptureMailer({ from: 'Acme <noreply@acme.test>' })
    const r = await m.send({ ...msg, html: '<p>Body</p>' })
    expect(m.sent.length).toBe(1)
    expect(m.sent[0]).toMatchObject({ ...msg, html: '<p>Body</p>', from: 'Acme <noreply@acme.test>', messageId: r.messageId })
    expect(typeof m.sent[0].sentAt).toBe('string')
    expect(r.messageId).toMatch(/^<[^@]+@acme\.test>$/)
    expect(r.message).toBe('captured')
  })

  it('a stated from wins over the default, and a stated Message-ID wins over a minted one', async () => {
    const m = createCaptureMailer()
    const r = await m.send({ ...msg, from: 'x@y.test', headers: { 'Message-ID': '<mine@y.test>' } })
    expect(m.sent[0].from).toBe('x@y.test')
    expect(r.messageId).toBe('<mine@y.test>')
  })

  it('answers `to(address)` and `clear()` over the live list', async () => {
    const m = createCaptureMailer()
    const list = m.sent
    await m.send(msg)
    await m.send({ ...msg, to: ['a@b.test', 'sam@example.com'] })
    await m.send({ ...msg, to: 'other@b.test' })
    expect(list.length).toBe(3)
    expect(m.to('sam@example.com').length).toBe(2)
    expect(m.to('nobody@b.test')).toEqual([])
    m.clear()
    expect(list.length).toBe(0)
    expect(m.sent).toBe(list)
  })

  it('refuses what SMTP refuses, and keeps nothing of a refused send', async () => {
    const m = createCaptureMailer()
    await expect(m.send({ ...msg, to: 'victim@y.test>\r\nRCPT TO:<x@y.test>' })).rejects.toThrow()
    await expect(m.send({ ...msg, cc: 'a@b.test\r\nBcc: z@y.test' })).rejects.toThrow()
    await expect(m.send({ ...msg, headers: { 'X Bad:': 'v' } })).rejects.toThrow()
    await expect(m.send({ ...msg, headers: { 'X-A': 'a\r\nBcc: x@y.test' } })).rejects.toThrow()
    await expect(m.send({ ...msg, from: 'not a mailbox' })).rejects.toThrow()
    await expect(m.send({ ...msg, attachments: [{ filename: 'a.png', content: 'AA==', cid: 'a' }] })).rejects.toThrow(/html/)
    expect(m.sent.length).toBe(0)
  })

  it('a batch is kept whole or not at all', async () => {
    const m = createCaptureMailer()
    await expect(m.batch([msg, { ...msg, to: 'bad' }])).rejects.toThrow()
    expect(m.sent.length).toBe(0)
    const results = await m.batch([msg, { ...msg, to: 'b@c.test' }])
    expect(results.length).toBe(2)
    expect(m.sent.length).toBe(2)
    expect(results[0].messageId).not.toBe(results[1].messageId)
  })

  it('`log` prints what the log mailer prints', async () => {
    const lines: string[] = []
    const m = createCaptureMailer({ log: t => lines.push(t) })
    await m.send(msg)
    expect(lines).toEqual(['[mail] -> sam@example.com . Hello\nBody line'])
  })

  it('works under `mail()`, which grades first and reaches `app.mail`', async () => {
    const m = createCaptureMailer()
    const app: any = {}
    mail({ mailer: m }).register!(app)
    await app.mail.send(createMessage('Hi', '<p>x</p>').to('a@b.test').build())
    await expect(app.mail.send({ ...msg, to: 'a@b.test\r\nBcc: x@y.test' })).rejects.toThrow()
    expect(m.sent.length).toBe(1)
  })
})

describe('createLogMailer', () => {
  it('prints one line then the text body, and answers a SendResult', async () => {
    const lines: string[] = []
    const m = createLogMailer({ write: t => lines.push(t), from: 'g@grouppi.test' })
    const r = await m.send({ ...msg, to: ['a@b.test', 'c@d.test'] })
    expect(lines).toEqual(['[mail] -> a@b.test, c@d.test . Hello\nBody line'])
    expect(r.message).toBe('logged')
    expect(r.id).toBe('log-1')
    expect(r.messageId).toMatch(/^<[^@]+@grouppi\.test>$/)
  })

  it('names attachments after the body', async () => {
    const lines: string[] = []
    const m = createLogMailer({ write: t => lines.push(t) })
    await m.send({ ...msg, attachments: [{ filename: 'invite.ics', content: 'x', type: 'text/calendar' }, { filename: 'b.txt', content: 'y' }] })
    expect(lines[0]).toBe('[mail] -> sam@example.com . Hello\nBody line\n[attached] invite.ics (text/calendar), b.txt')
  })

  it('prints through console.log by default', async () => {
    const orig = console.log
    const seen: string[] = []
    console.log = (t: string) => { seen.push(t) }
    try { await createLogMailer().send(msg) } finally { console.log = orig }
    expect(seen.length).toBe(1)
  })

  it('refuses a bad message and prints nothing, and a bad batch prints none of it', async () => {
    const lines: string[] = []
    const m = createLogMailer({ write: t => lines.push(t) })
    await expect(m.send({ ...msg, to: 'bad' })).rejects.toThrow()
    await expect(m.batch([msg, { ...msg, to: 'bad' }])).rejects.toThrow()
    expect(lines).toEqual([])
    await m.batch([msg, msg])
    expect(lines.length).toBe(2)
  })
})
