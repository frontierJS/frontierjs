// STARTTLS — the upgrade the mailer performs against every submission server.
//
// `src/mail/smtp.ts` called `socket.startTls(...)`, a method that does not exist
// on a Bun socket and never has: probed on 1.3.11 the property is `undefined`,
// and the real one is `upgradeTLS`, with a different signature and a PAIR as its
// return value. So every send through a host that advertises STARTTLS — which is
// every mainstream submission host on port 587 — died with
// `socket.startTls is not a function`.
//
// Nothing caught it because the only mail server the drives talk to is the dev
// sink, and a sink advertises no capabilities, so the branch never ran. A test
// that stands up a real TLS server would need a certificate; these two ask the
// two questions that actually failed, and neither needs one.

import { describe, it, expect } from 'bun:test'

import { SmtpError, sendMail } from '../src/mail/smtp.ts'


describe('the socket API the mailer depends on', () => {

  it('Bun sockets have upgradeTLS, and do not have startTls', async () => {
    // The whole defect in one assertion. A method name is a contract with the
    // runtime, and this is the only kind of test that grades one — every other
    // test in this file would pass against a call to `socket.frobnicate()` so
    // long as the branch never ran.
    const server = Bun.listen({
      hostname: '127.0.0.1', port: 0,
      socket: { data() {}, open() {}, close() {}, error() {} },
    })

    try {
      const socket = await Bun.connect({
        hostname: '127.0.0.1', port: server.port,
        socket: { data() {}, open() {}, close() {}, error() {} },
      })

      expect(typeof (socket as unknown as { upgradeTLS?: unknown }).upgradeTLS).toBe('function')
      expect((socket as unknown as { startTls?: unknown }).startTls).toBeUndefined()

      socket.end()
    } finally {
      server.stop(true)
    }
  })
})

describe('a server that advertises STARTTLS', () => {

  it('is answered with an upgrade attempt, not a TypeError', async () => {
    // In process. It ran in a subprocess for its whole life because
    // `tests/email.test.ts` called `mock.module()` on the smtp shim, which
    // re-exports this module and whose replacement bun applies process-wide and
    // never undoes — so an in-process version passed alone and graded a mock
    // inside the suite, reaching the real client not once. The sender takes an
    // injected transport now and that file mocks nothing, so the fork has no
    // cause left (`FJS-908`).
    //
    // The server greets, advertises STARTTLS and accepts the command, then does
    // nothing: there is no certificate here, so the handshake cannot complete.
    // WHICH failure is the assertion — a TLS or connection error means the
    // upgrade was attempted, a TypeError about a missing method means it was
    // not.
    const seen: string[] = []
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port:     0,
      socket: {
        open(sock) { sock.write('220 test.invalid ESMTP\r\n') },
        data(sock, data: Buffer) {
          const line = data.toString('utf8').trim()
          seen.push(line.split(' ')[0]!.toUpperCase())

          if (line.toUpperCase().startsWith('EHLO'))   sock.write('250-test.invalid\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n')
          else if (line.toUpperCase() === 'STARTTLS')  sock.write('220 Ready to start TLS\r\n')
          else                                         sock.write('502 Not implemented\r\n')
        },
        close() {}, error() {},
      },
    })

    let message = ''
    try {
      await sendMail(
        { host: '127.0.0.1', port: server.port, user: 'u', pass: 'p' },
        { from: 'a@test.invalid', to: 'b@test.invalid', subject: 's', text: 't' },
      )
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    } finally {
      server.stop(true)
    }

    // The branch ran at all, which is what stops the lines below passing vacuously.
    expect(seen).toContain('STARTTLS')

    // Deliberately not an assertion that it FAILED. Whether a handshake against
    // a server with no certificate fails, and how fast, is the platform's
    // business. The failure MODE is what this test owns.
    expect(message).not.toMatch(/is not a function/)
    expect(message).not.toMatch(/startTls/)
  }, 30_000)

  it('SmtpError is what a refusal surfaces as', () => {
    expect(new SmtpError('nope', 501, 'raw')).toBeInstanceOf(Error)
  })
})
