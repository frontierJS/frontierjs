// api/mail-sink.ts — the mail provider, standing in for a real one.
//
// A dev mail catcher: it speaks the shape a provider REST API speaks (Resend's
// `POST /emails`), checks the bearer token, and keeps what it was sent so a
// human or a drive can read it back. Mailpit and Mailhog are the same idea for
// SMTP; this is the HTTP-API version, because that is what `@frontierjs/conduit`
// talks to.
//
// It is a SEPARATE LISTENER on purpose. An in-process fake would prove that the
// mailer builds a payload and nothing else — the request would never leave the
// process, no credential would be resolved, no timeout or 5xx could be
// exercised, and `error.kind` would be untestable. Sending it over a real socket
// to a real server means the only thing pretended-at is the delivery to a human
// mailbox.
//
// Started by api/app.ts unless MAIL_SINK_URL points somewhere else. Nothing in
// the app imports it except that one line.

const PORT = Number(process.env.MAIL_SINK_PORT ?? 8111)

/** What the provider is willing to accept as its API key. */
const KEY = process.env.SHOP_MAIL_KEY ?? 'dev-mail-key'

export interface CapturedMail {
  id:      string
  at:      number
  from:    string
  to:      string[]
  subject: string
  html:    string | null
  text:    string | null
}

const outbox: CapturedMail[] = []

/**
 * Start the sink. Returns a stop function.
 *
 * Routes, deliberately provider-shaped rather than convenient:
 *   POST   /emails    the provider API. 401 without the bearer token.
 *   GET    /outbox    what it has been sent, newest last  (the catcher part)
 *   DELETE /outbox    empty it
 *   POST   /fail-next make the next POST /emails answer 500 once
 */
export function startMailSink(): { stop(): void; port: number } {
  let failNext = false

  // A stale sink from a previous run answers on this port and Bun's own error
  // is `EADDRINUSE` with a stack pointing at Bun.serve — which reads as "the
  // example is broken". Two API processes sharing one sink would also mean a
  // drive asserting on mail somebody else sent.
  const inUse = (): never => {
    throw new Error(
      `mail sink: port ${PORT} is already answering.\n` +
      `Another \`bun run api\` is probably still running. Stop it, or point this ` +
      `one elsewhere with MAIL_SINK_PORT=… , or at an existing sink with MAIL_SINK_URL=…`
    )
  }

  let server
  try {
    server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === '/outbox' && req.method === 'GET')
        return Response.json(outbox)

      // Clearing the catcher also DISARMS a staged failure. A `fail-next` that
      // outlives the run that armed it is a landmine: it is consumed by the next
      // POST from anywhere, so one drive's fault-injection becomes another
      // drive's mysteriously missing email — which is exactly what happened,
      // alternating pass/fail, until this line existed. Reset is one call.
      if (url.pathname === '/outbox' && req.method === 'DELETE') {
        outbox.length = 0
        failNext = false
        return Response.json({ ok: true })
      }

      // A provider that is having a bad minute. `send()` reports this as
      // `server_error`, retryable — which is the branch nothing else exercises.
      if (url.pathname === '/fail-next' && req.method === 'POST') {
        failNext = true
        return Response.json({ ok: true })
      }

      if (url.pathname === '/emails' && req.method === 'POST') {
        if (req.headers.get('authorization') !== `Bearer ${KEY}`)
          return Response.json({ message: 'invalid api key' }, { status: 401 })

        if (failNext) {
          failNext = false
          return Response.json({ message: 'temporarily unavailable' }, { status: 500 })
        }

        const body = await req.json() as {
          from?: string; to?: string | string[]
          subject?: string; html?: string; text?: string
        }
        const mail: CapturedMail = {
          id:      crypto.randomUUID(),
          at:      Date.now(),
          from:    body.from ?? '(none)',
          to:      Array.isArray(body.to) ? body.to : [body.to ?? '(none)'],
          subject: body.subject ?? '(none)',
          html:    body.html ?? null,
          text:    body.text ?? null,
        }
        outbox.push(mail)
        return Response.json({ id: mail.id })
      }

      return new Response('not found', { status: 404 })
    },
    })
  } catch (err) {
    if ((err as { code?: string }).code === 'EADDRINUSE') inUse()
    throw err
  }

  return { stop: () => server.stop(true), port: PORT }
}
