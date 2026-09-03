// api/src/providers/mail/sink.ts — the mail provider, standing in for a real one.
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

// 8111 is dev/be/project 1/service 1 by `packages/cli/core/ports.js`'s formula.
// The number is derived rather than chosen: a sibling app growing a mail sink
// takes its own project's service slot, not this one.
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
 *
 * And two that are not the provider's, for the half a JSON array cannot do —
 * LOOKING at what was sent:
 *   GET    /          the inbox, self-contained HTML
 *   GET    /outbox/:id/(html|text)   one message as a real document
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

      // The inbox. A dev tool rather than part of the provider shape, so it sits
      // at the root and the provider routes are untouched.
      if (url.pathname === '/' && req.method === 'GET')
        return new Response(INBOX, { headers: { 'content-type': 'text/html; charset=utf-8' } })

      if (url.pathname === '/outbox' && req.method === 'GET')
        return Response.json(outbox)

      // One message as a real document, for a browser's own opinion of it — and
      // for forwarding it somewhere with a mail client's.
      const one = url.pathname.match(/^\/outbox\/([^/]+)\/(html|text)$/)
      if (one && req.method === 'GET') {
        const mail = outbox.find((m) => m.id === one[1])
        if (!mail) return new Response('no such message', { status: 404 })
        const body = one[2] === 'html' ? mail.html : mail.text
        if (body == null) return new Response(`message has no ${one[2]} part`, { status: 404 })
        return new Response(body, {
          headers: { 'content-type': one[2] === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' },
        })
      }

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

// ─── the inbox ────────────────────────────────────────────────────────────────
//
// `GET /` — the half `GET /outbox` is not. An email is the one thing in an app
// nobody looks at: rendered on a server, delivered to somebody else, read in a
// client you do not control. The JSON proves one was SENT; it says nothing about
// whether the thing a person opens is right, and `curl | python -c` to read a
// subject line is how an app ends up shipping mail nobody has ever seen.
//
// Self-contained on purpose — one string, no asset pipeline, no dependency on
// the app being built. The sink is a standalone listener that starts before the
// app does and outlives a failed boot, so an inbox that needed Vite would be
// unavailable in exactly the situation you want it.
//
// The message body renders in an `<iframe srcdoc>`, which is the load-bearing
// detail: an email carries its own <style> and table layout, written for a mail
// client and scoped to nothing. Rendered inline it restyles the inbox around it;
// in an iframe it gets the isolated document it was written for, which is also
// closer to what a mail client actually gives it.
const INBOX = /* html */ `<!doctype html>
<meta charset="utf-8">
<title>mail sink</title>
<style>
  :root { color-scheme: light dark }
  * { box-sizing: border-box }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; height: 100vh; display: grid;
         grid-template-rows: auto 1fr; background: Canvas; color: CanvasText }
  header { display: flex; gap: .75rem; align-items: center; padding: .6rem 1rem;
           border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent) }
  header h1 { font-size: 14px; margin: 0; font-weight: 600 }
  header .grow { flex: 1 }
  button { font: inherit; padding: .25rem .6rem; border-radius: 6px; cursor: pointer;
           border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
           background: transparent; color: inherit }
  button:hover { background: color-mix(in srgb, CanvasText 8%, transparent) }
  main { display: grid; grid-template-columns: minmax(240px, 22rem) 1fr; min-height: 0 }
  ol { margin: 0; padding: 0; list-style: none; overflow: auto;
       border-right: 1px solid color-mix(in srgb, CanvasText 15%, transparent) }
  li { padding: .6rem .9rem; cursor: pointer;
       border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent) }
  li:hover { background: color-mix(in srgb, CanvasText 6%, transparent) }
  li[aria-current=true] { background: color-mix(in srgb, Highlight 22%, transparent) }
  li b { display: block; font-weight: 600 }
  li span { display: block; opacity: .7; font-size: 12px }
  section { display: grid; grid-template-rows: auto auto 1fr; min-width: 0; min-height: 0 }
  dl { margin: 0; padding: .7rem 1rem; display: grid; grid-template-columns: auto 1fr;
       gap: .15rem .8rem; font-size: 12.5px;
       border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent) }
  dt { opacity: .6 } dd { margin: 0 }
  nav { display: flex; gap: .4rem; padding: .5rem 1rem 0 }
  nav button[aria-pressed=true] { background: color-mix(in srgb, CanvasText 12%, transparent) }
  iframe { border: 0; width: 100%; height: 100%; background: #fff }
  pre { margin: 0; padding: 1rem; overflow: auto; white-space: pre-wrap; font-size: 12.5px }
  .empty { padding: 2rem 1rem; opacity: .6 }
</style>
<header>
  <h1>mail sink</h1>
  <span id="count" class="empty" style="padding:0"></span>
  <span class="grow"></span>
  <label><input type="checkbox" id="auto" checked> auto-refresh</label>
  <button id="refresh">Refresh</button>
  <button id="clear">Clear</button>
</header>
<main>
  <ol id="list"></ol>
  <section id="pane"><p class="empty">No message selected.</p></section>
</main>
<script>
  const $ = (id) => document.getElementById(id)
  let mail = [], picked = null, view = 'html'

  const when = (t) => new Date(t).toLocaleTimeString()

  async function load() {
    const next = await (await fetch('/outbox')).json()
    // Compared by id rather than by length: clearing and resending can leave the
    // same count, and a redraw on every poll would lose the text selection.
    const same = next.length === mail.length && next.every((m, i) => m.id === mail[i].id)
    mail = next
    if (!same) draw()
    $('count').textContent = mail.length + (mail.length === 1 ? ' message' : ' messages')
  }

  function draw() {
    $('list').innerHTML = ''
    if (!mail.length) {
      $('list').innerHTML = '<li class="empty" style="cursor:default">Nothing sent yet.</li>'
      $('pane').innerHTML = '<p class="empty">No message selected.</p>'
      picked = null
      return
    }
    // Newest first here, though the array is append-order — the JSON is a log and
    // this is an inbox, and a drive reading /outbox depends on that order.
    for (const m of [...mail].reverse()) {
      const li = document.createElement('li')
      li.tabIndex = 0
      li.setAttribute('aria-current', String(m.id === picked))
      li.innerHTML = '<b></b><span></span>'
      li.querySelector('b').textContent = m.subject
      li.querySelector('span').textContent = m.to.join(', ') + ' · ' + when(m.at)
      li.onclick = () => { picked = m.id; draw() }
      $('list').append(li)
    }
    if (!mail.some((m) => m.id === picked)) picked = mail[mail.length - 1].id
    show(mail.find((m) => m.id === picked))
  }

  function show(m) {
    const pane = $('pane')
    pane.innerHTML = ''
    const dl = document.createElement('dl')
    for (const [k, v] of [['from', m.from], ['to', m.to.join(', ')],
                          ['subject', m.subject], ['sent', new Date(m.at).toLocaleString()]]) {
      const dt = document.createElement('dt'), dd = document.createElement('dd')
      dt.textContent = k; dd.textContent = v
      dl.append(dt, dd)
    }
    const nav = document.createElement('nav')
    for (const kind of ['html', 'text']) {
      const b = document.createElement('button')
      b.textContent = kind
      b.setAttribute('aria-pressed', String(view === kind))
      b.disabled = !m[kind]
      b.onclick = () => { view = kind; show(m) }
      nav.append(b)
    }
    const open = document.createElement('button')
    open.textContent = 'open raw ↗'
    open.onclick = () => window.open('/outbox/' + m.id + '/html', '_blank')
    open.disabled = !m.html
    nav.append(open)

    let body
    if (view === 'html' && m.html) {
      body = document.createElement('iframe')
      // An email brings its own <style> written against nothing. srcdoc gives it
      // the isolated document it expects and keeps it out of this page.
      body.srcdoc = m.html
      body.sandbox = ''
    } else {
      body = document.createElement('pre')
      body.textContent = m[view] ?? '(no ' + view + ' part)'
    }
    pane.append(dl, nav, body)
  }

  $('refresh').onclick = load
  $('clear').onclick = async () => { await fetch('/outbox', { method: 'DELETE' }); picked = null; await load(); draw() }
  setInterval(() => { if ($('auto').checked) load() }, 1500)
  load()
</script>`
