// ============================================================
// Junction Email — Bun-native SMTP client
// packages/junction/src/email/system/smtp.ts
//
// Implements ESMTP over:
//   - Plain TCP + STARTTLS upgrade  (port 587, default)
//   - Implicit TLS                  (port 465, auto-detected)
//
// No external dependencies. Uses Bun.connect() throughout.
// AUTH PLAIN preferred; falls back to AUTH LOGIN.
// ============================================================

// ─── Public types ────────────────────────────────────────────

export interface SmtpConfig {
  host: string
  port: number            // 25 | 465 | 587 — 465 auto-enables implicit TLS
  user: string
  pass: string
  tls?:  boolean          // explicit override; auto-true when port === 465
}

export interface SmtpMessage {
  from:     string
  to:       string | string[]
  subject:  string
  html?:    string
  text?:    string
  replyTo?: string
}

// ─── Address and header safety ───────────────────────────────
//
// **SMTP is line-oriented and every field here reaches a line.** A `to` of
// `a@b.test>\r\nRCPT TO:<victim@c.test` is not a bad address, it is a second
// command: the transaction sends what it is given, so one injected CRLF adds a
// recipient nobody asked for, and the same character in a `replyTo` adds a
// header (`Bcc:`) to a message somebody else composed. The subject survived only
// by accident — `encodeMimeHeader` base64-encodes anything non-printable, so a
// CRLF there was hidden by an encoding rule that exists for emoji.
//
// Refused at BOTH ends: `MailBuilder.build()`/`createSmtpMailer`, where a
// mistake is cheapest to attribute, and `sendMessage()`, which is the last
// thing before a socket write and is reachable directly through `sendMail`.
// One of the two alone is a validator somebody routes around.

const ADDR_MAX = 254   // RFC 5321 §4.5.3.1.3 — path length

/** RFC 5321 addr-spec, conservatively: local@domain, no framing, no controls. */
export function assertAddress(addr: unknown, field: string): string {
  if (typeof addr !== 'string' || !addr)
    throw new SmtpError(`Mail: ${field} must be a non-empty address string`)
  if (addr.length > ADDR_MAX)
    throw new SmtpError(`Mail: ${field} is longer than ${ADDR_MAX} characters`)
  // Named first, because "does not match the pattern" about a CRLF is the least
  // useful sentence at the moment somebody is looking at an injection.
  if (/[\r\n]/.test(addr))
    throw new SmtpError(`Mail: ${field} contains a line break — SMTP is line-oriented and this would inject a command`)
  if (/[\x00-\x1f\x7f]/.test(addr))
    throw new SmtpError(`Mail: ${field} contains a control character`)
  if (/[<>\s,;]/.test(addr))
    throw new SmtpError(`Mail: ${field} must be a bare address — no display name, angle brackets, whitespace or separators`)
  const at = addr.lastIndexOf('@')
  if (at <= 0 || at === addr.length - 1)
    throw new SmtpError(`Mail: ${field} is not an address (expected local@domain, got '${addr}')`)
  const domain = addr.slice(at + 1)
  if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(domain)
      && !/^\[[0-9A-Fa-f:.]+\]$/.test(domain))
    throw new SmtpError(`Mail: ${field} has an invalid domain ('${domain}')`)
  return addr
}

/** A header VALUE that cannot become a second header. */
export function assertHeaderValue(value: unknown, field: string): string {
  const v = String(value ?? '')
  if (/[\r\n]/.test(v))
    throw new SmtpError(`Mail: ${field} contains a line break — a header value cannot span lines`)
  if (/[\x00\x0b\x0c]/.test(v))
    throw new SmtpError(`Mail: ${field} contains a control character`)
  return v
}

/** Every address on a message, at whichever end is asking. */
export function assertMessageAddresses(msg: {
  from?: unknown; to?: unknown; cc?: unknown; bcc?: unknown; replyTo?: unknown; subject?: unknown
}): void {
  if (msg.from !== undefined) assertAddress(msg.from, 'from')
  const list = (v: unknown): unknown[] => v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]
  for (const a of list(msg.to))  assertAddress(a, 'to')
  for (const a of list(msg.cc))  assertAddress(a, 'cc')
  for (const a of list(msg.bcc)) assertAddress(a, 'bcc')
  if (msg.replyTo !== undefined && msg.replyTo !== null) assertAddress(msg.replyTo, 'replyTo')
  if (msg.subject !== undefined) assertHeaderValue(msg.subject, 'subject')
}

// ─── Errors ──────────────────────────────────────────────────

export class SmtpError extends Error {
  constructor(
    message:                   string,
    public readonly code:      number | null = null,
    public readonly response:  string | null = null,
  ) {
    super(message)
    this.name = 'SmtpError'
  }
}

// ─── Internal ────────────────────────────────────────────────

interface SmtpResponse {
  code:  number
  lines: string[]   // text portions, one entry per response line
}

// SMTP responses are one or more lines:
//   "250-First line\r\n"   ← continuation (dash)
//   "250 Last line\r\n"    ← terminal (space)
//
// Returns null if the buffer doesn't yet contain a complete response.
// On success, also returns how many bytes were consumed so the caller
// can trim the buffer correctly (partial next-response may already be buffered).
function parseResponse(raw: string): { response: SmtpResponse; consumed: number } | null {
  const lines: string[] = []
  let   pos = 0

  while (pos < raw.length) {
    const eol = raw.indexOf('\r\n', pos)
    if (eol === -1) return null                // incomplete line — wait for more data

    const line = raw.slice(pos, eol)
    pos = eol + 2

    if (line.length < 4) return null           // malformed

    const code      = parseInt(line.slice(0, 3), 10)
    const separator = line[3]                  // '-' = more lines, ' ' = terminal
    const text      = line.slice(4)

    if (isNaN(code)) return null

    lines.push(text)

    if (separator === ' ') {
      return { response: { code, lines }, consumed: pos }
    }
    // separator === '-': continue reading
  }

  return null   // no terminal line yet
}

// ─── Session ─────────────────────────────────────────────────

async function openSession(config: SmtpConfig): Promise<{
  sendMessage: (msg: SmtpMessage) => Promise<void>
  quit:        () => Promise<void>
  // RSET, so a batch can reuse the session after one message fails.
  // `sendMailBatch` has always called it; the annotation had not named it, so
  // the only thing keeping the batch path working was that types are erased.
  reset:       () => Promise<void>
}> {
  const useTls = config.tls ?? (config.port === 465)

  // ── Async read state ──
  // Bun sockets are event-driven. We bridge to async/await by
  // parking a resolver here that the data handler resolves when
  // a complete SMTP response has been buffered.
  let incomingBuffer = ''
  let waitResolve: ((r: SmtpResponse) => void) | null = null
  let waitReject:  ((e: Error)        => void) | null = null

  function handleChunk(chunk: string) {
    incomingBuffer += chunk
    if (!waitResolve) return          // nobody waiting yet — keep buffering

    const parsed = parseResponse(incomingBuffer)
    if (!parsed) return               // incomplete response — keep buffering

    incomingBuffer = incomingBuffer.slice(parsed.consumed)
    const resolve  = waitResolve
    waitResolve    = null
    waitReject     = null
    resolve(parsed.response)
  }

  function handleError(err: Error) {
    if (waitReject) {
      const reject = waitReject
      waitResolve  = null
      waitReject   = null
      reject(err)
    }
  }

  // ── Connect ──
  // eslint-disable-next-line prefer-const
  let socket: ReturnType<typeof Bun.connect> extends Promise<infer S> ? S : never

  const connectPromise = Bun.connect({
    hostname: config.host,
    port:     config.port,
    tls:      useTls ? true : undefined,
    socket: {
      data(_sock, data: Buffer) {
        handleChunk(data.toString('utf8'))
      },
      error(_sock, err: Error) {
        handleError(err)
      },
      close() {
        handleError(new SmtpError('Connection closed unexpectedly'))
      },
      // open() fires when the connection is established.
      // The server sends a 220 greeting immediately after — we read it via readResponse().
      open() {},
    },
  })

  socket = await connectPromise

  // ── Helpers ──

  function readResponse(): Promise<SmtpResponse> {
    // Check if a full response is already in the buffer
    // (can happen when the server sends multiple responses back-to-back)
    const already = parseResponse(incomingBuffer)
    if (already) {
      incomingBuffer = incomingBuffer.slice(already.consumed)
      return Promise.resolve(already.response)
    }

    return new Promise((resolve, reject) => {
      waitResolve = resolve
      waitReject  = reject
    })
  }

  function write(line: string): void {
    socket.write(line + '\r\n')
  }

  async function command(cmd: string): Promise<SmtpResponse> {
    write(cmd)
    return readResponse()
  }

  function assertCode(res: SmtpResponse, expected: number, context: string): void {
    if (res.code !== expected) {
      throw new SmtpError(
        `${context}: expected ${expected}, got ${res.code} — ${res.lines[0] ?? '(no message)'}`,
        res.code,
        res.lines.join('\n'),
      )
    }
  }

  // ── Greeting ──

  const greeting = await readResponse()
  assertCode(greeting, 220, 'SMTP greeting')

  // ── EHLO ──

  let ehlo = await command(`EHLO ${config.host}`)

  if (ehlo.code !== 250) {
    // Old server — fall back to HELO (no extensions, no STARTTLS)
    const helo = await command(`HELO ${config.host}`)
    assertCode(helo, 250, 'HELO')
    // No capabilities to parse — proceed directly to AUTH
  }

  // Capabilities are the text portions of the EHLO 250 response lines, uppercased.
  // e.g. "SIZE 35882577", "AUTH PLAIN LOGIN", "STARTTLS"
  let capabilities = ehlo.lines.map(l => l.toUpperCase())

  // ── STARTTLS ──
  // Only attempt if we're not already on TLS and server advertises it

  if (!useTls && capabilities.some(c => c === 'STARTTLS' || c.startsWith('STARTTLS '))) {
    const starttls = await command('STARTTLS')
    assertCode(starttls, 220, 'STARTTLS')

    // Upgrade the existing TCP socket to TLS in place.
    //
    // `socket.startTls()` does not exist and never did on any Bun this repo has
    // run — probed on 1.3.11, the property is `undefined` — so this threw
    // `socket.startTls is not a function` against every server that advertises
    // STARTTLS, which is every mainstream submission host on port 587. It went
    // unseen because the only mail server the drives talk to is the dev sink,
    // and a sink advertises no capabilities.
    //
    // The real API takes the handlers again (they are not carried over) and
    // returns a PAIR: `raw` is the original socket, `tls` is the encrypted one,
    // and everything after this must write to the second.
    const [, tlsSocket] = socket.upgradeTLS({
      tls: { serverName: config.host },
      socket: {
        data(_sock, data: Buffer) { handleChunk(data.toString('utf8')) },
        error(_sock, err: Error)  { handleError(err) },
        close()                   { handleError(new SmtpError('Connection closed unexpectedly')) },
        open()                    {},
      },
    })
    socket = tlsSocket

    // Re-EHLO over TLS — required by RFC 3207
    ehlo         = await command(`EHLO ${config.host}`)
    assertCode(ehlo, 250, 'EHLO after STARTTLS')
    capabilities = ehlo.lines.map(l => l.toUpperCase())
  }

  // ── AUTH ──

  const authLine = capabilities.find(c => c.startsWith('AUTH ') || c.startsWith('AUTH='))

  if (!authLine) {
    throw new SmtpError(
      'Server did not advertise AUTH capability. ' +
      'Ensure STARTTLS / TLS is configured correctly — servers typically ' +
      'only advertise AUTH after the connection is encrypted.'
    )
  }

  const mechanisms = authLine.replace(/^AUTH[= ]/, '').split(' ')

  if (mechanisms.includes('PLAIN')) {
    await authPlain(config.user, config.pass)
  } else if (mechanisms.includes('LOGIN')) {
    await authLogin(config.user, config.pass)
  } else {
    throw new SmtpError(
      `Server requires unsupported AUTH mechanism(s): ${mechanisms.join(', ')}. ` +
      'Junction supports PLAIN and LOGIN.'
    )
  }

  async function authPlain(user: string, pass: string): Promise<void> {
    // AUTH PLAIN credential format: "\0username\0password" base64-encoded
    const credentials = Buffer.from(`\0${user}\0${pass}`).toString('base64')
    const res = await command(`AUTH PLAIN ${credentials}`)
    assertCode(res, 235, 'AUTH PLAIN')
  }

  async function authLogin(user: string, pass: string): Promise<void> {
    // AUTH LOGIN: server challenges for username then password separately
    const challenge1 = await command('AUTH LOGIN')
    assertCode(challenge1, 334, 'AUTH LOGIN init')

    const challenge2 = await command(Buffer.from(user).toString('base64'))
    assertCode(challenge2, 334, 'AUTH LOGIN username')

    const authenticated = await command(Buffer.from(pass).toString('base64'))
    assertCode(authenticated, 235, 'AUTH LOGIN password')
  }

  // ── Public session methods ────────────────────────────────

  async function sendMessage(msg: SmtpMessage): Promise<void> {
    // Before ANY socket write. The last gate before the wire, and the only one
    // `sendMail` alone reaches.
    assertMessageAddresses(msg)
    const recipients = Array.isArray(msg.to) ? msg.to : [msg.to]

    // A refusal mid-transaction abandons a half-open one — the session is
    // reusable and the next message would otherwise inherit this one's envelope
    // (RFC 5321 §4.1.1.5). Every 4xx and 5xx below is fatal for this message.
    const fatal = async (err: unknown): Promise<never> => {
      try { await reset() } catch { /* the session is going away regardless */ }
      throw err
    }

    // MAIL FROM
    const mailFrom = await command(`MAIL FROM:<${msg.from}>`)
    try { assertCode(mailFrom, 250, 'MAIL FROM') } catch (e) { return fatal(e) }

    // RCPT TO — one command per recipient
    for (const addr of recipients) {
      const rcpt = await command(`RCPT TO:<${addr}>`)
      try { assertCode(rcpt, 250, `RCPT TO <${addr}>`) } catch (e) { return fatal(e) }
    }

    // DATA
    const dataReady = await command('DATA')
    try { assertCode(dataReady, 354, 'DATA') } catch (e) { return fatal(e) }

    // Construct and send the message body.
    // Dot-stuffing (RFC 5321 §4.5.2): any line beginning with "." must
    // have an extra "." prepended. The terminating sequence is "\r\n.\r\n".
    const raw     = buildMimeMessage(msg)
    const stuffed = raw.replace(/^\.(.*)$/gm, '..$1')
    socket.write(stuffed + '\r\n.\r\n')

    const dataEnd = await readResponse()
    assertCode(dataEnd, 250, 'DATA end')
  }

  async function quit(): Promise<void> {
    try {
      await command('QUIT')
    } catch {
      // Best-effort — server may close before we read the 221
    } finally {
      socket.end()
    }
  }

  // RSET — abort any half-finished mail transaction so the session can be
  // reused for the next message after a failure (RFC 5321 §4.1.1.5).
  async function reset(): Promise<void> {
    const r = await command('RSET')
    assertCode(r, 250, 'RSET')
  }

  return { sendMessage, quit, reset }
}

// ─── MIME builder ─────────────────────────────────────────────
//
// Produces a minimal but correct MIME message.
// html + text → multipart/alternative
// html only   → text/html
// text only   → text/plain
//
// Body encoding: quoted-printable (safe for 8-bit content over SMTP).
// Subject encoding: RFC 2047 encoded-word for non-ASCII.

function buildMimeMessage(msg: SmtpMessage): string {
  const to       = Array.isArray(msg.to) ? msg.to.join(', ') : msg.to
  const date     = new Date().toUTCString()
  const boundary = `----=_Part_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`

  // Every value goes through the encoder, which REFUSES a line break rather
  // than encoding it. `From`/`To`/`Reply-To` used to be interpolated raw, so a
  // CRLF in any of them wrote a header of the caller's choosing into a message
  // the app composed.
  const baseHeaders = [
    `From: ${encodeMimeHeader(msg.from)}`,
    `To: ${encodeMimeHeader(to)}`,
    `Subject: ${encodeMimeHeader(msg.subject)}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    ...(msg.replyTo ? [`Reply-To: ${encodeMimeHeader(msg.replyTo)}`] : []),
  ]

  // Multipart/alternative (HTML + plain text)
  if (msg.html && msg.text) {
    return [
      ...baseHeaders,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      quotedPrintable(msg.text),
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      quotedPrintable(msg.html),
      '',
      `--${boundary}--`,
    ].join('\r\n')
  }

  // HTML only
  if (msg.html) {
    return [
      ...baseHeaders,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      quotedPrintable(msg.html),
    ].join('\r\n')
  }

  // Plain text only (fallback)
  return [
    ...baseHeaders,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(msg.text ?? ''),
  ].join('\r\n')
}

// ─── Encoding helpers ─────────────────────────────────────────

// RFC 2047 encoded-word for non-ASCII header values (e.g. subjects with emoji).
// Passes ASCII-only values through unchanged — no unnecessary encoding.
function encodeMimeHeader(value: string): string {
  // A CRLF is REFUSED and never encoded. Base64ing it looks like it closes the
  // hole and does not: an encoded-word is decoded by the receiving agent, and
  // an encoder is the wrong owner of a rule about what may be sent at all.
  assertHeaderValue(value, 'header')
  if (/^[\x20-\x7E]*$/.test(value)) return value
  const encoded = Buffer.from(value).toString('base64')
  return `=?UTF-8?B?${encoded}?=`
}

// Quoted-printable encoding per RFC 2045.
// Encodes non-ASCII bytes, trailing whitespace, and lone dots.
// Lines are wrapped at 76 characters as required by the spec.
function quotedPrintable(input: string): string {
  const encoder = new TextEncoder()

  // Encode character-by-character:
  //   - \t and printable ASCII (0x20–0x7E) except '=' → literal
  //   - everything else → =XX hex escape
  const encodedLines = input
    .split('\n')
    .map(line => {
      // Normalise \r\n to \n first (we'll re-add \r\n at the join step)
      const stripped = line.replace(/\r$/, '')
      let result = ''

      for (const char of stripped) {
        const cp = char.codePointAt(0)!
        if (char === '\t' || (cp >= 0x20 && cp <= 0x7E && char !== '=')) {
          result += char
        } else {
          result += encoder
            .encode(char)
            .reduce((acc, byte) => acc + `=${byte.toString(16).toUpperCase().padStart(2, '0')}`, '')
        }
      }

      // Encode trailing whitespace — required by RFC 2045
      result = result.replace(/[ \t]+$/, m =>
        [...m].map(c => `=${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`).join('')
      )

      return wrapQpLine(result)
    })

  return encodedLines.join('\r\n')
}

// Wrap a QP-encoded line at 76 characters.
// Insertions must not split a =XX sequence.
function wrapQpLine(line: string): string {
  if (line.length <= 76) return line

  const chunks: string[] = []
  let   remaining = line

  while (remaining.length > 76) {
    // Find the last safe split point at or before column 75 (1 char for soft line break '=')
    let split = 75

    // Don't split in the middle of a =XX escape
    while (split > 0) {
      // A split is unsafe if it would put '=' or '=X' at the end of the chunk
      const tail = remaining.slice(split - 1, split + 1)
      if (tail.includes('=') && remaining[split - 1] === '=') {
        split--
        continue
      }
      if (remaining[split - 2] === '=') {
        split -= 2
        continue
      }
      break
    }

    chunks.push(remaining.slice(0, split) + '=')  // soft line break
    remaining = remaining.slice(split)
  }

  chunks.push(remaining)
  return chunks.join('\r\n')
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Send a single email via SMTP.
 * Opens a connection, authenticates, sends, and quits.
 *
 * For high-volume use, connection pooling should be layered on top —
 * this function is intentionally stateless and connection-per-send.
 *
 * @throws SmtpError on connection failure, auth failure, or rejected message
 */
export async function sendMail(config: SmtpConfig, message: SmtpMessage): Promise<void> {
  const session = await openSession(config)
  try {
    await session.sendMessage(message)
  } finally {
    await session.quit()
  }
}

/**
 * Send many messages over ONE SMTP session.
 *
 * Connection-per-send costs a full TCP + TLS + EHLO + AUTH handshake per
 * message; a batch of N previously opened N parallel sessions (which some
 * providers rate-limit as abuse). This opens one session, pipelines the
 * messages sequentially (MAIL FROM → RCPT → DATA per message, RSET after a
 * failure so the next message starts clean), and QUITs once.
 *
 * Per-message failures don't abort the batch — each result carries ok/error.
 */
export async function sendMailBatch(
  config:   SmtpConfig,
  messages: SmtpMessage[]
): Promise<Array<{ ok: boolean; error?: string }>> {
  if (!messages.length) return []

  const session = await openSession(config)
  const results: Array<{ ok: boolean; error?: string }> = []
  try {
    for (const msg of messages) {
      try {
        await session.sendMessage(msg)
        results.push({ ok: true })
      } catch (err) {
        results.push({ ok: false, error: err instanceof Error ? err.message : String(err) })
        // Clear any half-finished transaction; if RSET itself fails the
        // session is unusable — fail the remaining messages and stop.
        try {
          await session.reset()
        } catch (resetErr) {
          const reason = `session lost after failure: ${resetErr instanceof Error ? resetErr.message : resetErr}`
          for (let i = results.length; i < messages.length; i++) {
            results.push({ ok: false, error: reason })
          }
          break
        }
      }
    }
  } finally {
    await session.quit()
  }
  return results
}
