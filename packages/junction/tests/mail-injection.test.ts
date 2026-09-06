// tests/mail-injection.test.ts
//
// FJS-677 — SMTP is line-oriented and every field on a message reaches a line.
// A `to` of `victim@y.test>\r\nRCPT TO:<...>\r\nDATA\r\n...` is not a bad
// address, it is a second transaction: the client sent what it was given, and a
// fake MTA queued TWO messages from one `sendMail` — the second one composed by
// whoever typed the address into a form. The subject survived only by accident,
// because `encodeMimeHeader` base64-encodes anything non-printable and a CRLF
// was hidden by a rule that exists for emoji.
//
// Driven against a REAL fake MTA on a local TCP port, because the assertion
// that matters is what reached the WIRE: a unit test over the builder alone
// passes with `sendMail` unguarded, and `sendMail` is exported and reachable
// directly.
//
// It ran in a SUBPROCESS for most of its life, because `tests/email.test.ts`
// called `mock.module()` on the smtp shim that `export *`s this client — the
// replacement is process-wide and never undone, so an in-process version passed
// ALONE and graded a mock inside the suite (measured: five of these went green
// in isolation and failed in the full run). The system sender takes an injected
// transport now and nothing here mocks a module (`FJS-908`), so it is back in
// process — and the assertions are real `expect`s rather than the parent
// matching the child's stdout, which is most of what that fork cost
// (`FJS-909`): a probe line that was never reached passed silently.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { sendMail, assertAddress, assertHeaderValue } from '../src/mail/smtp.ts'
import { createMessage, createSmtpMailer }            from '../src/mail/index.ts'

interface Queued { rcpts: string[]; data: string }

const queued: Queued[] = []
const seen:   string[] = []
let rcpts: string[] = []
// Typed off the TCP overload: `ReturnType<typeof Bun.listen>` resolves to the
// UNIX one, which has no `port`.
let server: Bun.TCPSocketListener<{ inData: boolean; buf: string }>

beforeAll(() => {
  server = Bun.listen<{ inData: boolean; buf: string }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(s) { s.data = { inData: false, buf: '' }; s.write('220 fake\r\n') },
      data(s, chunk) {
        s.data.buf += chunk.toString()
        for (;;) {
          if (s.data.inData) {
            const end = s.data.buf.indexOf('\r\n.\r\n')
            if (end === -1) return
            queued.push({ rcpts, data: s.data.buf.slice(0, end) })
            rcpts = []
            s.data.buf = s.data.buf.slice(end + 5)
            s.data.inData = false
            s.write('250 queued\r\n')
            continue
          }
          const eol = s.data.buf.indexOf('\r\n')
          if (eol === -1) return
          const line = s.data.buf.slice(0, eol)
          s.data.buf = s.data.buf.slice(eol + 2)
          seen.push(line)
          const u = line.toUpperCase()
          if (u.startsWith('EHLO'))      s.write('250-fake\r\n250 AUTH PLAIN\r\n')
          else if (u.startsWith('AUTH')) s.write('235 ok\r\n')
          else if (u.startsWith('RCPT')) { rcpts.push(line); s.write('250 ok\r\n') }
          else if (u.startsWith('DATA')) { s.data.inData = true; s.write('354 go\r\n') }
          else if (u.startsWith('QUIT')) { s.write('221\r\n'); s.end() }
          else s.write('250 ok\r\n')
        }
      },
    },
  })
})

afterAll(() => { server?.stop(true) })

const cfg   = () => ({ host: '127.0.0.1', port: server.port, user: 'u', pass: 'p', tls: false })
const reset = () => { queued.length = 0; seen.length = 0; rcpts = [] }

/** Refused, AND nothing reached the MTA — the second half is the whole point. */
async function refuses(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  reset()
  await expect(fn()).rejects.toThrow(pattern)
  await Bun.sleep(50)
  expect(queued).toHaveLength(0)
}

// The exact payload the audit measured: not a bad address, a second
// transaction. The fake MTA queued TWO messages from one sendMail.
const INJECTED_TO =
  'victim@y.test>\r\nRCPT TO:<target1@evil.test>\r\nDATA\r\nFrom: ceo@x.test\r\n' +
  'To: target1@evil.test\r\nSubject: Urgent wire transfer\r\n\r\nPlease pay\r\n.\r\nNOOP'

describe('an address cannot become a command (FJS-677)', () => {

  it('refuses an injected `to` before any socket write', async () => {
    await refuses(
      () => sendMail(cfg(), { from: 'noreply@x.test', to: INJECTED_TO, subject: 'Thanks', text: 'ok' }),
      /line break/)
    // Not "one message instead of two" — nothing reached the wire at all.
    expect(seen.filter(l => l.toUpperCase().startsWith('RCPT'))).toHaveLength(0)
  })

  it('refuses a replyTo carrying a Bcc', async () => {
    await refuses(
      () => sendMail(cfg(), { from: 'noreply@x.test', to: 'a@b.test', subject: 'Hi', text: 'ok', replyTo: 'r@b.test\r\nBcc: exfil@evil.test' }),
      /replyTo/)
  })

  it('refuses a subject break rather than base64-encoding it', async () => {
    await refuses(
      () => sendMail(cfg(), { from: 'noreply@x.test', to: 'a@b.test', subject: 'Hi\r\nBcc: e@evil.test', text: 'ok' }),
      /line break/)
  })

  it('refuses a from break', async () => {
    await refuses(
      () => sendMail(cfg(), { from: 'noreply@x.test\r\nBcc: e@evil.test', to: 'a@b.test', subject: 'Hi', text: 'ok' }),
      /from/)
  })

  it('grades the default `from` createSmtpMailer resolves', async () => {
    await refuses(
      () => createSmtpMailer({ ...cfg(), from: 'bad@x.test\r\nBcc: e@evil.test' }).send({ to: 'a@b.test', subject: 'Hi', text: 'ok' }),
      /from/)
  })

  it('a valid address still reaches the MTA', async () => {
    // The control. A validator that refuses everything looks identical from the
    // refused side, so a valid message has to be shown getting through.
    reset()
    await sendMail(cfg(), { from: 'noreply@x.test', to: 'a@b.test', subject: 'Hi', text: 'ok' })
    await Bun.sleep(50)
    expect(queued).toHaveLength(1)
    expect(queued[0]!.rcpts[0]).toBe('RCPT TO:<a@b.test>')
  })
})

describe('the same rule at the builder, where a mistake is cheapest to attribute', () => {

  it('refuses the injected recipient', () => {
    expect(() => createMessage('Hi', 'x').to(INJECTED_TO).build()).toThrow(/line break/)
  })

  it('refuses a cc break', () => {
    expect(() => createMessage('Hi', 'x').to('a@b.test').cc('c@b.test\r\nX: 1').build()).toThrow(/cc/)
  })

  it('refuses a bcc break', () => {
    expect(() => createMessage('Hi', 'x').to('a@b.test').bcc('c@b.test\r\nX: 1').build()).toThrow(/bcc/)
  })

  it('refuses a header value that would become a header', () => {
    expect(() => createMessage('Hi', 'x').to('a@b.test').header('X-Tag', 'a\r\nBcc: e@evil.test').build())
      .toThrow(/headers\.X-Tag/)
  })

  it('a valid message still builds', () => {
    expect(createMessage('Hi', 'x').to('a@b.test').cc('c@b.test').replyTo('r@b.test').build().to).toBe('a@b.test')
  })
})

describe('the address grammar, both directions', () => {

  it.each(['a@b.test', 'a.b+c@sub.domain.co.uk', 'x@[127.0.0.1]'])('accepts %s', (a) => {
    expect(assertAddress(a, 'to')).toBe(a)
  })

  it.each(['', 'nodomain', '@b.test', 'a@', 'a b@c.test', '<a@b.test>', 'a@b.test, c@d.test', 'a@b_c'])(
    'refuses %j', (a) => {
      expect(() => assertAddress(a, 'to')).toThrow(/Mail:/)
    })

  it('keeps an em dash in a header value', () => {
    expect(assertHeaderValue('Ordinary — dash', 'subject')).toBe('Ordinary — dash')
  })

  it('refuses a bare LF in a header value', () => {
    expect(() => assertHeaderValue('a\nb', 'subject')).toThrow(/line break/)
  })
})
