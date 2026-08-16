// Driven by tests/smtp-starttls.test.ts, out of process on purpose — the suite
// mocks the smtp shim process-wide, so an in-process probe grades the mock.
//
// Stands up a minimal SMTP server that advertises STARTTLS, points the real
// client at it, and prints one JSON line: which commands the server saw, and
// what the client failed with. There is no certificate, so the handshake cannot
// complete; the caller asserts on the KIND of failure.

import { sendMail } from '../../src/mail/smtp.ts'

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
}

console.log(JSON.stringify({ seen, message }))
server.stop(true)
process.exit(0)
