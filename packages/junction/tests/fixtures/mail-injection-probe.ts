// tests/fixtures/mail-injection-probe.ts
//
// The wire half of FJS-677, run OUT OF PROCESS by tests/mail-injection.test.ts.
//
// It is a separate process for the reason tests/smtp-starttls.test.ts is:
// `tests/email.test.ts` calls `mock.module()` on the smtp shim, which
// `export *`s this client, and the replacement is process-wide and never
// undone — so an in-process version of this passed alone and graded a MOCK
// inside the suite, reaching the real client not once.
//
// Prints `ok <name>` per assertion and exits 1 on the first failure.

import { sendMail, assertAddress, assertHeaderValue } from '../../src/mail/smtp.ts'
import { createMessage, createSmtpMailer }            from '../../src/mail/index.ts'

interface Queued { rcpts: string[]; data: string }

const queued: Queued[] = []
const seen:   string[] = []
let rcpts: string[] = []

const server = Bun.listen<{ inData: boolean; buf: string }>({
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

const cfg   = () => ({ host: '127.0.0.1', port: server.port, user: 'u', pass: 'p', tls: false })
const reset = () => { queued.length = 0; seen.length = 0; rcpts = [] }

let failed = false
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`ok ${name}`); return }
  failed = true
  console.log(`not ok ${name}${detail ? ` — ${detail}` : ''}`)
}

async function refuses(name: string, fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  reset()
  let msg = ''
  try { await fn(); msg = '<resolved>' } catch (e) { msg = (e as Error).message }
  await Bun.sleep(50)
  check(name, pattern.test(msg) && queued.length === 0, `message=${JSON.stringify(msg)} queued=${queued.length}`)
}

// The exact payload the audit measured: not a bad address, a second
// transaction. The fake MTA queued TWO messages from one sendMail.
const INJECTED_TO =
  'victim@y.test>\r\nRCPT TO:<target1@evil.test>\r\nDATA\r\nFrom: ceo@x.test\r\n' +
  'To: target1@evil.test\r\nSubject: Urgent wire transfer\r\n\r\nPlease pay\r\n.\r\nNOOP'

await refuses('injected to is refused before any socket write',
  () => sendMail(cfg(), { from: 'noreply@x.test', to: INJECTED_TO, subject: 'Thanks', text: 'ok' }),
  /line break/)
// Not "one message instead of two" — nothing reached the wire at all.
check('no RCPT was sent', seen.filter(l => l.toUpperCase().startsWith('RCPT')).length === 0)

await refuses('replyTo carrying a Bcc is refused',
  () => sendMail(cfg(), { from: 'noreply@x.test', to: 'a@b.test', subject: 'Hi', text: 'ok', replyTo: 'r@b.test\r\nBcc: exfil@evil.test' }),
  /replyTo/)

await refuses('a subject break is refused rather than base64 encoded',
  () => sendMail(cfg(), { from: 'noreply@x.test', to: 'a@b.test', subject: 'Hi\r\nBcc: e@evil.test', text: 'ok' }),
  /line break/)

await refuses('a from break is refused',
  () => sendMail(cfg(), { from: 'noreply@x.test\r\nBcc: e@evil.test', to: 'a@b.test', subject: 'Hi', text: 'ok' }),
  /from/)

await refuses('createSmtpMailer grades the resolved default from',
  () => createSmtpMailer({ ...cfg(), from: 'bad@x.test\r\nBcc: e@evil.test' }).send({ to: 'a@b.test', subject: 'Hi', text: 'ok' }),
  /from/)

// The control. A validator that refuses everything looks identical from the
// refused side, so a valid message has to be shown reaching the MTA.
reset()
await sendMail(cfg(), { from: 'noreply@x.test', to: 'a@b.test', subject: 'Hi', text: 'ok' })
await Bun.sleep(50)
check('a valid address still sends', queued.length === 1 && queued[0].rcpts[0] === 'RCPT TO:<a@b.test>',
  JSON.stringify(queued.map(q => q.rcpts)))

// ── The same rule at the builder, where a mistake is cheapest to attribute ──
const throws = (name: string, fn: () => unknown, pattern: RegExp) => {
  let msg = ''
  try { fn(); msg = '<returned>' } catch (e) { msg = (e as Error).message }
  check(name, pattern.test(msg), msg)
}
throws('build() refuses the injected recipient', () => createMessage('Hi', 'x').to(INJECTED_TO).build(), /line break/)
throws('build() refuses a cc break',   () => createMessage('Hi', 'x').to('a@b.test').cc('c@b.test\r\nX: 1').build(), /cc/)
throws('build() refuses a bcc break',  () => createMessage('Hi', 'x').to('a@b.test').bcc('c@b.test\r\nX: 1').build(), /bcc/)
throws('build() refuses a header value that would become a header',
  () => createMessage('Hi', 'x').to('a@b.test').header('X-Tag', 'a\r\nBcc: e@evil.test').build(), /headers\.X-Tag/)
check('a valid message builds',
  createMessage('Hi', 'x').to('a@b.test').cc('c@b.test').replyTo('r@b.test').build().to === 'a@b.test')

// ── The grammar, both directions ──
for (const a of ['a@b.test', 'a.b+c@sub.domain.co.uk', 'x@[127.0.0.1]'])
  check(`accepts ${a}`, assertAddress(a, 'to') === a)
for (const a of ['', 'nodomain', '@b.test', 'a@', 'a b@c.test', '<a@b.test>', 'a@b.test, c@d.test', 'a@b_c'])
  throws(`refuses ${JSON.stringify(a)}`, () => assertAddress(a, 'to'), /Mail:/)
check('a header value keeps an em dash', assertHeaderValue('Ordinary — dash', 'subject') === 'Ordinary — dash')
throws('a header value refuses a bare LF', () => assertHeaderValue('a\nb', 'subject'), /line break/)

server.stop(true)
process.exit(failed ? 1 : 0)
