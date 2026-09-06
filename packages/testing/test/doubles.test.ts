// doubles.test.ts — the mail double, and the two that are deliberately absent.

import { describe, it, expect } from 'bun:test'
import { createTestMailer } from '../src/doubles.ts'

describe('createTestMailer keeps what it was given', () => {

  it('records every message in order and answers the last', async () => {
    const mail = createTestMailer()
    await mail.send({ to: 'a@example.com', subject: 'one', text: 'x' })
    await mail.send({ to: 'b@example.com', subject: 'two', text: 'y' })
    expect(mail.sent.map(m => m.subject)).toEqual(['one', 'two'])
    expect(mail.last?.subject).toBe('two')
  })

  it('finds a message by any recipient, cc and bcc included', async () => {
    const mail = createTestMailer()
    await mail.send({ to: 'a@example.com', cc: 'b@example.com', bcc: ['c@example.com'], subject: 's', text: 'x' })
    for (const who of ['a@example.com', 'b@example.com', 'c@example.com'])
      expect(mail.to(who)).toHaveLength(1)
    expect(mail.to('nobody@example.com')).toHaveLength(0)
  })

  it('answers a SendResult, so a caller that reads one still works', async () => {
    const res = await createTestMailer().send({ to: 'a@example.com', subject: 's', text: 'x' })
    expect(typeof res.id).toBe('string')
    expect(res.id.length).toBeGreaterThan(0)
  })

  it('batch accepts each message on its own', async () => {
    const mail = createTestMailer()
    const out  = await mail.batch([
      { to: 'a@example.com', subject: '1', text: 'x' },
      { to: 'b@example.com', subject: '2', text: 'y' },
    ])
    expect(out).toHaveLength(2)
    expect(mail.sent).toHaveLength(2)
  })
})

describe('it refuses exactly what the real mailer refuses', () => {

  // The point of the double is that a test which passes here would have sent.
  // One that accepted a message SMTP rejects is worse than no double: the test
  // is green and the send fails in production.

  it('refuses an address carrying a line break, and keeps the legitimate one', async () => {
    const mail = createTestMailer()
    await expect(mail.send({ to: 'a@example.com\r\nRCPT TO:<victim@example.com>', subject: 's', text: 'x' }))
      .rejects.toThrow()
    // Paired: the refusal must not be *everything is refused*.
    await mail.send({ to: 'a@example.com', subject: 's', text: 'x' })
    expect(mail.sent).toHaveLength(1)
  })

  it('refuses a header value with a line break and a header name that is not one', async () => {
    const mail = createTestMailer()
    await expect(mail.send({ to: 'a@example.com', subject: 's', text: 'x', headers: { 'X-Ok': 'a\r\nBcc: v@e.com' } }))
      .rejects.toThrow()
    await expect(mail.send({ to: 'a@example.com', subject: 's', text: 'x', headers: { 'X Bad Name': 'v' } }))
      .rejects.toThrow()
    await mail.send({ to: 'a@example.com', subject: 's', text: 'x', headers: { 'X-Ok': 'fine' } })
    expect(mail.sent).toHaveLength(1)
  })

  it('a refused message is not recorded as sent', async () => {
    const mail = createTestMailer()
    await expect(mail.send({ to: 'bad\r\naddress', subject: 's', text: 'x' })).rejects.toThrow()
    expect(mail.sent).toHaveLength(0)
  })
})

describe('failures are available, because the retry paths need them', () => {

  it('failNext throws once and then sending works again', async () => {
    const mail = createTestMailer()
    mail.failNext(new Error('smtp down'))
    await expect(mail.send({ to: 'a@example.com', subject: 's', text: 'x' })).rejects.toThrow('smtp down')
    await mail.send({ to: 'a@example.com', subject: 's', text: 'x' })
    expect(mail.sent).toHaveLength(1)
  })

  it('failNext(n) throws n times', async () => {
    const mail = createTestMailer()
    mail.failNext(new Error('nope'), 2)
    for (let i = 0; i < 2; i++)
      await expect(mail.send({ to: 'a@example.com', subject: 's', text: 'x' })).rejects.toThrow('nope')
    await mail.send({ to: 'a@example.com', subject: 's', text: 'x' })
    expect(mail.sent).toHaveLength(1)
  })

  it('reset forgets what was sent', async () => {
    const mail = createTestMailer()
    await mail.send({ to: 'a@example.com', subject: 's', text: 'x' })
    mail.reset()
    expect(mail.sent).toHaveLength(0)
    expect(mail.last).toBeUndefined()
  })
})
