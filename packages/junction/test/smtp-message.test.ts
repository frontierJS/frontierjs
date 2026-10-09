// test/smtp-message.test.ts
//
// What a `MailMessage` actually becomes on the wire.
//
// Measured on the wire against a capturing server before the fix: a `cc`
// address was validated on the way in, reached no `RCPT TO`, appeared in no
// header, and the copied recipient never received the mail (`FJS-895`).
//
// Every assertion reads the CONVERSATION rather than the return value. The
// return value was `sent` the whole time it was wrong.

import { describe, expect, it } from 'bun:test'
import net                      from 'node:net'
import { createMessage, createResendMailer, createSmtpMailer } from '../src/mail/index.ts'
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

describe('an inline image (FJS-1666)', () => {

  // A report's chart reaches a mail client only as a PNG the HTML names by
  // cid:. Sent as an attachment, as every attachment was, the cid resolved to
  // nothing: a broken image, and a stray chart.png beside the mail.
  const CHART = { filename: 'chart.png', content: new Uint8Array([137, 80, 78, 71]), type: 'image/png', cid: 'chart' }
  const INLINE = { to: 'buyer@test', subject: 'Revenue', html: '<img src="cid:chart">', text: 'Revenue', attachments: [CHART] }

  /** The part headers that follow a boundary line naming `cid`. */
  const partOf = (w: string, header: string) => {
    const lines = w.split('\n'); const at = lines.indexOf(header)
    return at < 0 ? [] : lines.slice(Math.max(0, at - 3), at + 2)
  }

  it('is multipart/related around the body, named by Content-ID and disposed inline', async () => {
    const w = await wire(INLINE)
    expect(w).toMatch(/Content-Type: multipart\/related; boundary="[^"]+"; type="multipart\/alternative"/)
    expect(w).not.toContain('multipart/mixed')
    const part = partOf(w, 'Content-ID: <chart>')
    expect(part).toContain('Content-Type: image/png; name="chart.png"')
    expect(part).toContain('Content-Disposition: inline; filename="chart.png"')
    expect(w).not.toContain('Content-Disposition: attachment')
    // The body it belongs to is inside the related part, both alternatives.
    expect(w).toContain('Content-Type: multipart/alternative; boundary="')
    expect(w).toContain('cid:chart')
  })

  it('beside a file, the file is mixed and the image stays related to the body', async () => {
    const w = await wire({ ...INLINE, attachments: [CHART, { filename: 'revenue.pdf', content: 'pdf', type: 'application/pdf' }] })
    const mixed   = w.indexOf('Content-Type: multipart/mixed')
    const related = w.indexOf('Content-Type: multipart/related')
    expect(mixed).toBeGreaterThan(-1)
    expect(related).toBeGreaterThan(mixed)
    expect(w).toContain('Content-Disposition: attachment; filename="revenue.pdf"')
    expect(w).toContain('Content-Disposition: inline; filename="chart.png"')
    // The PDF is the mixed part's, after the related part closes.
    expect(w.indexOf('Content-Disposition: attachment; filename="revenue.pdf"')).toBeGreaterThan(w.indexOf('Content-ID: <chart>'))
  })

  it('an html-only body is related to text/html', async () => {
    const w = await wire({ to: 'buyer@test', subject: 's', html: '<img src="cid:chart">', attachments: [CHART] })
    expect(w).toMatch(/multipart\/related; boundary="[^"]+"; type="text\/html"/)
  })

  it('is refused with no html to draw it, and with a cid that would break the header or the URL', async () => {
    const s = await sink()
    try {
      await expect(mailer(s.port).send({ to: 'a@test', subject: 's', text: 't', attachments: [CHART] } as never)).rejects.toThrow(/needs an html body/)
      for (const cid of ['a>b', 'a b', 'a\r\nX-Evil: 1', ''])
        await expect(mailer(s.port).send({ ...INLINE, attachments: [{ ...CHART, cid }] } as never)).rejects.toThrow(/content id/)
    } finally { s.close() }
  })

  it('the builder adds one, and refuses a bad cid where it is written', () => {
    const msg = createMessage('s', '<img src="cid:chart">').to('a@test').inline('chart', 'chart.png', 'x', 'image/png').build()
    expect(msg.attachments).toEqual([{ filename: 'chart.png', content: 'x', type: 'image/png', cid: 'chart' }])
    expect(() => createMessage('s', 'h').inline('a b', 'x.png', 'x')).toThrow(/content id/)
  })

  it('reaches Resend as content_id, beside its type', async () => {
    const real = globalThis.fetch
    let body: any
    globalThis.fetch = (async (_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return Response.json({ id: 'r1' }) }) as never
    try { await createResendMailer({ apiKey: 'k', from: 'shop@test' }).send(INLINE as never) }
    finally { globalThis.fetch = real }
    expect(body.attachments).toEqual([{ filename: 'chart.png', content: Buffer.from(CHART.content).toString('base64'), content_type: 'image/png', content_id: 'chart' }])
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
    expect(new SmtpError('graylisted', 450).retryable).toBe(true)
    expect(new SmtpError('no mailbox', 550).retryable).toBe(false)
    expect(new SmtpError('socket closed').retryable).toBe(true)
  })
})

// FJS-1996: what a help desk's reply looks like on the wire. Each was measured
// replaying a composed reply into a sink: the named From threw at send, a long
// References went out as one illegal line, and the id send() answered was on
// no header, so a reply's In-Reply-To named nothing.
describe('a help-desk reply on the wire', () => {

  /** Sends one message; answers the conversation and what send() returned. */
  async function sent(msg: unknown): Promise<{ w: string, lines: string[], id: string }> {
    const s = await sink()
    try {
      const r = await mailer(s.port).send(msg as never)
      return { w: s.log.join('\n'), lines: s.log, id: r.id }
    } finally { s.close() }
  }

  /** A header's value with its folds undone (RFC 5322 § 2.2.3). */
  function unfolded(lines: string[], name: string): string | undefined {
    const i = lines.findIndex(l => l.toLowerCase().startsWith(name.toLowerCase() + ':'))
    if (i < 0) return undefined
    let v = lines[i].slice(name.length + 1)
    for (let j = i + 1; j < lines.length && /^[ \t]/.test(lines[j]); j++) v += lines[j]
    return v.trim()
  }

  it('a From with a display name sends, the envelope carrying the address alone', async () => {
    const { w } = await sent({ from: 'Support <support@acme.test>', to: 'Ana Lima <ana@cust.test>', subject: 'Re: help', text: 'hi' })
    expect(w).toContain('MAIL FROM:<support@acme.test>')
    expect(w).toContain('RCPT TO:<ana@cust.test>')
    expect(w).toContain('From: Support <support@acme.test>')
    expect(w).toContain('To: Ana Lima <ana@cust.test>')
  })

  it('a name holding a comma is quoted, and a non-ASCII one is encoded', async () => {
    const { w } = await sent({ from: '"Acme, Inc." <support@acme.test>', to: 'José <jose@cust.test>', subject: 's', text: 't' })
    expect(w).toContain('From: "Acme, Inc." <support@acme.test>')
    expect(w).toContain(`To: =?UTF-8?B?${Buffer.from('José').toString('base64')}?= <jose@cust.test>`)
  })

  it('two addresses in one string are still refused', async () => {
    const s = await sink()
    try {
      await expect(mailer(s.port).send({ to: 'a@b.test, c@d.test', subject: 's', text: 't' } as never)).rejects.toThrow(/Mail: to/)
    } finally { s.close() }
  })

  it('a References past 998 octets is folded, and unfolds to what was stated', async () => {
    const refs = Array.from({ length: 30 }, (_, i) => `<${crypto.randomUUID()}.${i}@acme.test>`).join(' ')
    const { lines } = await sent({ to: 'a@b.test', subject: 's', text: 't', headers: { References: refs } })
    for (const l of lines) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(998)
    expect(unfolded(lines, 'References')).toBe(refs)
  })

  it('a long non-ASCII subject is split into encoded-words no line overruns', async () => {
    const subject = 'Ação '.repeat(300)
    const { lines } = await sent({ to: 'a@b.test', subject, text: 't' })
    for (const l of lines) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(998)
    expect(unfolded(lines, 'Subject')).toMatch(/^=\?UTF-8\?B\?/)
  })

  it('with no Message-ID stated one is written, and send() answers it', async () => {
    const { lines, id } = await sent({ from: 'Support <support@acme.test>', to: 'a@b.test', subject: 's', text: 't' })
    expect(id).toMatch(/^<[^<>@\s]+@acme\.test>$/)
    expect(unfolded(lines, 'Message-ID')).toBe(id)
  })

  it('a stated Message-ID is the one written, once, and the one answered', async () => {
    const { lines, id } = await sent({ to: 'a@b.test', subject: 's', text: 't', headers: { 'Message-Id': '<m1@acme.test>' } })
    expect(id).toBe('<m1@acme.test>')
    expect(lines.filter(l => /^message-id:/i.test(l))).toEqual(['Message-Id: <m1@acme.test>'])
  })
})
