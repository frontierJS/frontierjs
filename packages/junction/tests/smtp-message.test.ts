// tests/smtp-message.test.ts
//
// What a `MailMessage` actually becomes on the wire.
//
// Measured on the wire against a capturing server before the fix: a `cc`
// address was validated on the way in, reached no `RCPT TO`, appeared in no
// header, and the copied recipient never received the mail (`FJS-895`).
//
// It ran in a SUBPROCESS for most of its life, because `tests/email.test.ts`
// called `mock.module()` on the smtp shim, process-wide and never undone — the
// in-process first cut of this file passed alone and fourteen of its rows
// failed in the full suite, grading a mock. The system sender takes an injected
// transport now and nothing here mocks a module (`FJS-908`), so it is back in
// process, with real `expect`s instead of the parent matching the child's
// stdout — a probe line that was never reached used to pass silently
// (`FJS-909`).
//
// Every assertion reads the CONVERSATION rather than the return value. The
// return value was `sent` the whole time it was wrong.

import { describe, expect, it } from 'bun:test'
import net                      from 'node:net'
import { createSmtpMailer }     from '../src/mail/index.ts'
import { SmtpError, assertHeaderName, envelopeRecipients } from '../src/mail/smtp.ts'

/** A capturing SMTP server on an ephemeral port, read back so nothing collides. */
async function sink(opts: { rcptCode?: string, mute?: boolean } = {}) {
  const log: string[] = []
  const server = net.createServer(sock => {
    if (opts.mute) return                       // accept, then never speak
    let inData = false
    sock.write('220 sink ESMTP\r\n')
    sock.on('data', buf => {
      for (const line of buf.toString().split('\r\n')) {
        if (line === '') continue
        log.push(line)
        if (inData) { if (line === '.') { inData = false; sock.write('250 OK queued\r\n') }; continue }
        const u = line.toUpperCase()
        if (u.startsWith('EHLO'))      sock.write('250-sink\r\n250-SIZE 10240000\r\n250 AUTH PLAIN LOGIN\r\n')
        else if (u.startsWith('AUTH')) sock.write('235 authenticated\r\n')
        else if (u.startsWith('RCPT') && opts.rcptCode) sock.write(`${opts.rcptCode} refused\r\n`)
        else if (u.startsWith('DATA')) { inData = true; sock.write('354 send it\r\n') }
        else if (u.startsWith('QUIT')) { sock.write('221 bye\r\n'); sock.end() }
        else sock.write('250 OK\r\n')
      }
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  return { port: (server.address() as net.AddressInfo).port, log, close: () => server.close() }
}

const mailer = (port: number, timeoutMs = 4000) =>
  createSmtpMailer({ host: '127.0.0.1', port, from: 'shop@test', user: 'u', pass: 'p', timeoutMs } as never)

const FULL = {
  to: 'buyer@test', cc: 'accounts@test', bcc: 'archive@test',
  subject: 'Your receipt', text: 'thanks',
  headers: { 'X-Order-Id': 'ORD-1' },
  attachments: [{ filename: 'receipt.pdf', content: 'hello', type: 'application/pdf' }],
}

/** Sends one message and answers the whole conversation. */
async function wire(msg: unknown = FULL): Promise<string> {
  const s = await sink()
  try { await mailer(s.port).send(msg as never) } finally { s.close() }
  return s.log.join('\n')
}

describe('the envelope carries every recipient', () => {

  it('to, cc and bcc all reach RCPT TO', async () => {
    const w = await wire()
    for (const who of ['buyer@test', 'accounts@test', 'archive@test'])
      expect(w).toContain(`RCPT TO:<${who}>`)
  })

  it('envelopeRecipients is where that list comes from', () => {
    expect(envelopeRecipients(FULL as never)).toEqual(['buyer@test', 'accounts@test', 'archive@test'])
  })
})

describe('a copy is visible and a blind copy is not', () => {

  it('Cc IS a header and Bcc is NOT', async () => {
    const w = await wire()
    expect(w).toContain('Cc: accounts@test')
    expect(/^Bcc:/im.test(w)).toBe(false)
  })

  it('the blind address appears nowhere in the message body', async () => {
    // The obvious symmetry with Cc is the bug: writing Bcc is how a blind copy
    // stops being blind.
    const w = await wire()
    expect(w.slice(w.indexOf('DATA'))).not.toContain('archive@test')
  })

  it('a caller header reaches the wire', async () => {
    expect(await wire()).toContain('X-Order-Id: ORD-1')
  })

  it('the message keeps its own headers', async () => {
    const w = await wire()
    for (const h of ['From: shop@test', 'To: buyer@test', 'Subject: Your receipt']) expect(w).toContain(h)
  })
})

describe('attachments', () => {

  it('an attachment makes the message multipart/mixed', async () => {
    expect(await wire()).toMatch(/Content-Type: multipart\/mixed; boundary="/)
  })

  it('is disposed by name, carries its declared type, and its content in base64', async () => {
    const w = await wire()
    expect(w).toContain('Content-Disposition: attachment; filename="receipt.pdf"')
    expect(w).toContain('Content-Type: application/pdf; name="receipt.pdf"')
    expect(w).toContain(Buffer.from('hello').toString('base64'))
    expect(w).toContain('thanks')                       // the body survives beside it
  })

  it('a message with NO attachment is not multipart', async () => {
    // The control: a wrapper applied unconditionally would satisfy every row
    // above.
    const w = await wire({ to: 'buyer@test', subject: 's', text: 't' })
    expect(w).not.toContain('multipart/mixed')
    expect(w).toContain('Content-Type: text/plain; charset=UTF-8')
  })
})

describe('the injection surface the pass-through opens', () => {

  // Forwarding caller headers is what makes header injection reachable at all,
  // so the guard lands in the same change as the feature.
  const cases: Array<[string, unknown]> = [
    ['a CRLF in a header value',            { to: 'a@b.test', subject: 's', text: 't', headers: { 'X-A': 'ok\r\nBcc: victim@c.test' } }],
    ['a header NAME that is not one',       { to: 'a@b.test', subject: 's', text: 't', headers: { 'X-Evil: injected': 'v' } }],
    ['a CRLF in an attachment filename',    { to: 'a@b.test', subject: 's', text: 't', attachments: [{ filename: 'a\r\nContent-Type: evil', content: 'x' }] }],
  ]

  it.each(cases)('refuses %s', async (_what, msg) => {
    const s = await sink()
    try { await expect(mailer(s.port).send(msg as never)).rejects.toThrow() }
    finally { s.close() }
  })

  it('and still accepts a legitimate header beside them', async () => {
    // Paired, or a guard that refused every header would pass all three rows.
    expect(await wire({ to: 'a@b.test', subject: 's', text: 't', headers: { 'X-Ok': 'fine' } }))
      .toContain('X-Ok: fine')
  })

  it('assertHeaderName accepts a real name and refuses a forged one', () => {
    expect(assertHeaderName('X-Order-Id')).toBe('X-Order-Id')
    expect(() => assertHeaderName('X-Evil: injected')).toThrow(/header name/)
  })
})

describe('time', () => {

  it('a server that never speaks times out rather than hanging', async () => {
    const s  = await sink({ mute: true })
    const t0 = Date.now()
    try {
      await expect(mailer(s.port, 600).send({ to: 'a@b.test', subject: 's', text: 't' } as never))
        .rejects.toThrow(/Timed out after 600ms/)
      expect(Date.now() - t0).toBeLessThan(4000)
    } finally { s.close() }
  })
})

describe('retryable comes from the reply code', () => {

  it.each([[450, true], [550, false]] as const)('a %i reply is retryable=%s on the wire', async (code, want) => {
    const s = await sink({ rcptCode: String(code) })
    try {
      await mailer(s.port).send({ to: 'a@b.test', subject: 's', text: 't' } as never)
      throw new Error('the send was accepted')
    } catch (e) {
      const err = e as SmtpError
      expect(err.code).toBe(code)
      expect(err.retryable).toBe(want)
    } finally { s.close() }
  })

  it('is derived from the first digit rather than a hand list', () => {
    // In process this used to grade a MOCK: `email.test.ts` replaced the smtp
    // shim, and there is only one `SmtpError` class, so `.retryable` came back
    // undefined inside the suite and true alone.
    expect(new SmtpError('greylisted', 450).retryable).toBe(true)
    expect(new SmtpError('no mailbox', 550).retryable).toBe(false)
    expect(new SmtpError('socket closed').retryable).toBe(true)
  })
})
