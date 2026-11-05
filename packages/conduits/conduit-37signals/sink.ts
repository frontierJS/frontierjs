// sink.ts — Basecamp, standing in for `3.basecampapi.com`. One account, `999`,
// so every path is under `/999`; a bearer token; a `User-Agent` or `400`
// `text/plain`, Basecamp's own refusal word for word; `X-Ratelimit` on every
// answer. It serves 0.2's fixtures for the reads it knows, with their
// `3.basecampapi.com` URLs pointed at itself so a client can follow them, and
// a `404` with Basecamp's body for the rest. Every `200` GET carries a weak
// `ETag` of its body and answers `304` to it, repeating `ETag`, `Link` and
// `X-Total-Count`, as Basecamp does (0.3).
//
// `projects.json` is `projects` rows (default 47) in Basecamp's geared pages,
// 15, 30, 50, 100, and its `Link` never ends: an empty page still names the
// next (0.3). The first row is `project.json`, whose dock carries an enabled
// todoset and a disabled one; only the enabled one has todolists.
//
// The creates (2.3) POST to a parent's list and land there: a to-do in its
// todolist, a message on its board, a comment on its recording, a line in its
// chat — made by the profile, `201` with the row. A rich text body comes back
// wrapped in `<div>`, as Basecamp's do; a chat line is rich only when it says
// `content_type: text/html`. Those lists answer in Basecamp's orders — lines
// and messages newest first, comments oldest first, to-dos as added — in the
// same geared pages, and their `Link` ends at the last page.
// `/_sink/seed` puts rows on a list (`{ path, rows }`, each row partial) so a
// drive can stand older and other people's rows beside a create.
//
// Chaos under `/_sink/arm`, each one request unless it says otherwise:
// `{ rateLimit: { retryAfter } }` is a 429 with `Retry-After` and
// `X-Ratelimit` at `remaining: 0`; `{ failNext }` a 500; `{ forbidden }` a 403
// with an empty body, an Agent's answer outside its endpoints; `{ inactive }`
// is `404` with `Reason: Account Inactive` on EVERY path until reset, as an
// expired or suspended account answers; `{ lost }` APPLIES the next request and
// never answers it, so the caller times out not knowing. None of the refusals
// applies the request. `{ answer: { status, body?, headers?, times? } }` is any
// other answer, for the next `times` requests (default 1).
// `/_sink/hide` (`{ id }`) keeps a created row on the account and answers its
// reads `404`, byte for byte the answer to an id that never existed, and leaves
// it off its list: a recording this token cannot see.
// `/_sink/project` merges fields into one project row, which changes the page
// that holds it.
//
// The token endpoint (2.6) is `POST /oauth/tokens` on the same origin, as
// `app.basecamp.com` answers it: a form body, `grant_type=refresh_token` with
// the sink's `refreshToken`, mints an access token good for `tokenLife`
// seconds (default 3600, the CLI's measured lifetime), and every API path
// takes it until it expires; `token` stays good for the drive's fixed
// credential. An armed answer (`failNext`, `answer`) is spent here as on any
// path, so `{ expire, failNext }` fails the refresh the expiry causes. `{ expire }` ends every minted token now, so a send in flight
// gets the `401` an expired one does; `{ refuseRefresh }` answers every
// refresh `400` `invalid_grant` until reset; `{ rotate }` answers each refresh
// with a new refresh token and burns the old one. Whether Basecamp rotates,
// and the words of its refusal, are unmeasured: these are RFC 6749's.
// `people` adds a grant per person (4.1), refresh token to person id: a token
// minted from it is that person's, so `my/profile.json` answers their id and a
// create is theirs. `{ revoke: <refresh token> }` ends one grant alone.
//
// The event feed (3.1) is `GET /events.json` over 0.2's replay, oldest first,
// `feedPage` a page (default 100). A position token names the last event
// served and the digest of the filters it was minted for — the docs' `srv2`
// recipe over `types` and `buckets` — so resuming it under other filters is
// `409` with both digests. A walk's `next` also freezes the head it started
// at, and carries the filters; a page cut short of the head has one, the last
// page does not. `since` is an id, `0` or `now`, and anything else is `400`
// `invalid_position`, as is a token the sink did not mint; an uncataloged type
// or a 101st bucket is `400` `invalid_filter`. `{ epoch }` raises the floor:
// a cursor below it is `410` with `epoch_after_id` and a `resume` URL at the
// epoch, filters kept, while `since=0` enters at the epoch. `/_sink/events`
// appends events (`{ events }`, each partial), ids counting on by 7.
// Unmeasured: the 409 and 410 bodies beyond the fields the docs name, and
// whether Basecamp's `next` repeats the filters (0.3 walked with none).
//
// The live stream (3.4) is `POST /events/stream_ticket.json`, authenticated as
// any API path, answering `{ ticket, expires_in, url }`; the url is on a path
// of its own, `/cable/999`, as Basecamp's is on a host of its own, so a client
// that built one would miss. A ticket lives `ticketLife` seconds (default 120)
// and an unknown or expired one is a `401` with no upgrade. The socket speaks
// ActionCable as the docs give it: `welcome` on open, `{"type":"ping"}` every
// `beatMs` (default 3000), ONE `subscribe` to `EventsChannel` confirmed, a
// second with other parameters, another channel or an uncataloged type
// `reject_subscription`, and any other command `disconnect` with
// `reconnect: false` and a close. `/_sink/events` pushes each appended event to
// every subscription whose filters take it, unless it says `live: false`, and
// `duplicate: true` sends each frame twice. `{ hangUp }` closes every socket;
// `{ ticketLife, beatMs }` hold for tickets minted and sockets opened after.
// Unmeasured: the frames beyond the docs' examples, and whether the upgrade
// wants a `User-Agent`.

import { readFileSync } from 'node:fs'

export interface BasecampSinkOptions { port?: number; token?: string; projects?: number; refreshToken?: string; people?: Record<string, number>; tokenLife?: number; feedPage?: number; ticketLife?: number; beatMs?: number }
type Answer = { status: number; body?: unknown; headers?: Record<string, string>; times?: number }
type Armed = { answer?: Answer; rateLimit?: { retryAfter: number }; failNext?: boolean; forbidden?: boolean; inactive?: boolean; lost?: boolean; expire?: boolean; refuseRefresh?: boolean; revoke?: string; rotate?: boolean; tokenLife?: number; epoch?: number; feedPage?: number; hangUp?: boolean; ticketLife?: number; beatMs?: number }
type Json = Record<string, any>

const ACCOUNT = '999'
const GEARS = [15, 30, 50, 100]
const gear = (page: number) => GEARS[Math.min(page, GEARS.length) - 1]
const NO_UA = 'Provide a User-Agent header in the following format: My App (https://example.com/myapp)\n'
/** What `buckets/{b}/recordings/{id}.json` answers of a recording (measured 2026-10-16); the rest is the typed read's. */
const ENVELOPE = ['app_url', 'bookmark_url', 'bucket', 'created_at', 'creator', 'id', 'inherits_status', 'parent', 'status', 'subscription_url', 'title', 'type', 'updated_at', 'url', 'visible_to_clients']
const TYPED: Record<string, string> = { todos: 'todo.json', todolists: 'todolist.json', messages: 'message.json', comments: 'comment.json' }
/** Each list a create lands on: its path under the account, the fixture its rows are made from, the field holding rich text, and its order. */
const LISTS: { re: RegExp; fixture: string; rich?: string; newest?: true; oldest?: true }[] = [
  { re: /^\/buckets\/(\d+)\/todolists\/(\d+)\/todos\.json$/,          fixture: 'todo.json',      rich: 'description' },
  { re: /^\/buckets\/(\d+)\/message_boards\/(\d+)\/messages\.json$/,  fixture: 'message.json',   rich: 'content', newest: true },
  { re: /^\/buckets\/(\d+)\/recordings\/(\d+)\/comments\.json$/,      fixture: 'comment.json',   rich: 'content', oldest: true },
  { re: /^\/buckets\/(\d+)\/chats\/(\d+)\/lines\.json$/,              fixture: 'chat-line.json', newest: true },
]
/** The feed's catalog (`event_feed.md`, read 2026-10-16): a type outside it is the filter `400`. */
const CATALOG = new Set([
  'comment.created', 'comment.content_changed', 'message.created', 'message.content_changed', 'message.subject_changed',
  'todo.created', 'todo.completed', 'todo.moved', 'todo.content_changed', 'todo.description_changed', 'todo.scheduled', 'todo.rescheduled', 'todo.unscheduled', 'todo.assignment_changed',
  'card.created', 'card.completed', 'card.moved', 'card.content_changed', 'card.title_changed', 'card.due_on_changed', 'card.assignment_changed',
  'chat.line.created', 'boost.created', 'question.created', 'question.answer.created',
])
type Filters = { types?: string[]; buckets?: number[] }
type Cursor = { a: number; d: string; h?: number }
/** `srv2`: present dimensions only, values deduplicated and sorted, keys sorted, minimal JSON, SHA-256, 16 hex. */
const digest = (f: Filters) => new Bun.CryptoHasher('sha256').update(JSON.stringify({
  ...(f.buckets ? { buckets: [...new Set(f.buckets)].sort((a, b) => a - b) } : {}),
  ...(f.types ? { types: [...new Set(f.types)].sort() } : {}),
})).digest('hex').slice(0, 16)
const mint = (c: Cursor) => `BAh${Buffer.from(JSON.stringify(c)).toString('base64url')}`
const unmint = (t: string): Cursor | null => {
  if (!t.startsWith('BAh')) return null
  try { const c = JSON.parse(Buffer.from(t.slice(3), 'base64url').toString()); return Number.isSafeInteger(c?.a) && typeof c?.d === 'string' ? c : null } catch { return null }
}

type Cable = { ticket: string; identifier?: string; filters?: Filters; beat: ReturnType<typeof setInterval> }

export function startBasecampSink(opts: BasecampSinkOptions = {}) {
  const TOKEN = opts.token ?? 'bc_dev'
  const seen: { method: string; path: string; userAgent: string | null; authorization: string | null; ifNoneMatch: string | null; body: unknown; status: number }[] = []
  let answer: Answer | null = null, lost = false, inactive = false
  /** Live refresh token → the person it is a grant of; null is the profile's own. */
  const grants = new Map<string, number | null>()
  const regrant = () => { grants.clear(); grants.set(opts.refreshToken ?? 'bc_refresh', null); for (const [r, id] of Object.entries(opts.people ?? {})) grants.set(r, id) }
  regrant()
  let refuseRefresh = false, rotate = false, tokenLife = opts.tokenLife ?? 3600
  let feed: Json[] | null = null, epoch = 0, feedPage = opts.feedPage ?? 100
  const events = (): Json[] => feed ??= fixture('events-replay.json').events
  /** Minted access token → when it stops being good, epoch ms, and whose it is. */
  const minted = new Map<string, { until: number; person: number | null }>()
  const profileOf = (person: number | null | undefined) => person ? { ...fixture('profile.json'), id: person } : fixture('profile.json')
  let mints = 0
  const hidden = new Set<number>()
  const hanging: (() => void)[] = []
  /** Rows made by a create or a seed, per list path. */
  const made = new Map<string, Json[]>()
  let nextId = 3_000_000
  let origin = ''
  /** Ticket → when it stops opening a socket, epoch ms; every socket, and every frame a client sent on one. */
  const tickets = new Map<string, number>()
  const cables = new Set<import('bun').ServerWebSocket<Cable>>()
  const cableSent: { ticket: string; frame: string }[] = []
  let ticketsMinted = 0, ticketLife = opts.ticketLife ?? 120, beatMs = opts.beatMs ?? 3000
  const fixture = (name: string): Json =>
    JSON.parse(readFileSync(new URL(`./test/fixture/${name}`, import.meta.url), 'utf8').replaceAll('https://3.basecampapi.com', origin))

  const rateLimit = (remaining = 49, untilMs = 10_000) => ({ 'x-ratelimit': JSON.stringify({ name: 'API', period: 10, limit: 50, remaining, until: new Date(Date.now() + untilMs).toISOString() }) })
  const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(b === undefined ? '' : JSON.stringify(b), { status, headers: { ...(b === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }), ...rateLimit(), ...headers } })
  const notFound = () => json({ status: 404, error: 'Not Found' }, 404)
  const tagged = (req: Request, b: unknown, headers: Record<string, string> = {}) => {
    const etag = `W/"${new Bun.CryptoHasher('md5').update(JSON.stringify(b)).digest('hex')}"`
    if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag, ...rateLimit(), ...headers } })
    return json(b, 200, { etag, ...headers })
  }

  let rows: Json[] | null = null
  const projectRows = () => rows ??= Array.from({ length: opts.projects ?? 47 }, (_, i) => {
    const p = fixture('project.json')
    if (i === 0) return p
    const id = 2_000_000 + i
    return { ...p, id, name: `Name P${i}`, url: `${origin}/${ACCOUNT}/projects/${id}.json`, dock: p.dock.filter((d: Json) => d.name !== 'todoset') }
  })
  /** One geared page of `all`. `projects.json`'s `Link` never ends (0.3); a create's list ends at its last page. */
  const paged = (req: Request, url: URL, all: Json[], endless = false) => {
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
    let start = 0
    for (let k = 1; k < page; k++) start += gear(k)
    const more = endless || start + gear(page) < all.length
    return tagged(req, all.slice(start, start + gear(page)), {
      ...(more ? { link: `<${origin}${url.pathname}?page=${page + 1}>; rel="next"` } : {}),
      'x-total-count': String(all.length),
    })
  }

  const listOf = (path: string) => {
    for (const l of LISTS) { const m = path.match(l.re); if (m) return { ...l, bucket: Number(m[1]), parent: Number(m[2]) } }
    return null
  }
  /** A row as Basecamp answers a create: the list's fixture, made by the profile, now, under this bucket and parent. */
  const build = (path: string, fields: Json, person?: number | null): Json => {
    const l = listOf(path)!
    const id = nextId++, base = fixture(l.fixture), me = profileOf(person)
    const row: Json = {
      ...base, id, status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), creator: me,
      bucket: { ...base.bucket, id: l.bucket }, parent: { ...base.parent, id: l.parent },
      url: `${origin}/${ACCOUNT}${path.replace(/\/[^/]+\.json$/, '')}/${id}.json`,
    }
    if (l.fixture === 'todo.json') Object.assign(row, { completed: false, url: `${origin}/${ACCOUNT}/buckets/${l.bucket}/todos/${id}.json`, completion_url: `${origin}/${ACCOUNT}/todos/${id}/completion.json` })
    if (l.fixture === 'message.json') row.url = `${origin}/${ACCOUNT}/buckets/${l.bucket}/messages/${id}.json`
    if (l.fixture === 'comment.json') row.url = `${origin}/${ACCOUNT}/buckets/${l.bucket}/comments/${id}.json`
    const { creatorId, content_type, ...rest } = fields
    // A line is plain text unless it says `text/html` (`campfires.md`).
    const rich = l.fixture === 'chat-line.json' ? (content_type === 'text/html' ? 'content' : undefined) : l.rich
    if (l.fixture === 'chat-line.json') row.type = rich ? 'Chat::Lines::RichText' : 'Chat::Lines::Text'
    Object.assign(row, rest)
    if (creatorId !== undefined) row.creator = { ...me, id: creatorId }
    if (rich && typeof rest[rich] === 'string' && !/^<div>/.test(rest[rich])) row[rich] = `<div>${rest[rich]}</div>`
    return row
  }
  const ordered = (path: string) => {
    const l = listOf(path)!, rows = (made.get(path) ?? []).filter(r => !hidden.has(r.id))
    const at = (r: Json) => Date.parse(r.created_at)
    return l.newest ? rows.sort((a, b) => at(b) - at(a)) : l.oldest ? rows.sort((a, b) => at(a) - at(b)) : rows
  }
  const madeRow = (id: number) => [...made.values()].flat().find(r => r.id === id)
  const visible = (id: number) => hidden.has(id) ? undefined : madeRow(id)

  /** One page of the feed, or its refusal. */
  const poll = (req: Request, url: URL): Response => {
    const q = url.searchParams
    const list = (k: string) => q.get(k)?.split(',').filter(Boolean)
    const f: Filters = {}
    const types = list('types'), buckets = list('buckets')
    if (types) {
      const unknown = types.filter(t => !CATALOG.has(t))
      if (unknown.length) return json({ error: `Unknown event types: ${unknown.join(', ')}. Fix the filters; a position reset won't help.`, reason: 'invalid_filter' }, 400)
      f.types = types
    }
    if (buckets) {
      if (buckets.length > 100 || !buckets.every(b => /^\d+$/.test(b))) return json({ error: 'Buckets are at most 100 integer ids. Fix the filters; a position reset won\'t help.', reason: 'invalid_filter' }, 400)
      f.buckets = buckets.map(Number)
    }
    const d = digest(f), all = events(), head = all.at(-1)?.id ?? 0
    const invalid = () => json({ error: 'Unrecognized position. Resume with since=<id> or since=now.', reason: 'invalid_position' }, 400)
    let after: number, frozen: number
    const position = q.get('position'), since = q.get('since')
    if (position !== null) {
      const c = unmint(position)
      if (!c) return invalid()
      if (c.d !== d) return json({ error: 'Position was minted for a different filter set. Re-enter with since=.', position_digest: c.d, filters_digest: d }, 409)
      after = c.a; frozen = c.h ?? head
    } else if (since === null || since === 'now') {
      after = head; frozen = head
    } else if (/^\d+$/.test(since)) {
      after = Number(since) === 0 ? epoch : Number(since); frozen = head
    } else return invalid()
    const filters = `${f.types ? `&types=${f.types.join(',')}` : ''}${f.buckets ? `&buckets=${f.buckets.join(',')}` : ''}`
    if (after < epoch) return json({ error: 'Position predates the feed epoch.', epoch_after_id: epoch, resume: `${origin}/${ACCOUNT}/events.json?since=${epoch}${filters}` }, 410)
    const served = all.filter(e => e.id > after && e.id <= frozen && (!f.types || f.types.includes(e.event_type)) && (!f.buckets || f.buckets.includes(e.bucket_id)))
    const page = served.slice(0, feedPage), more = served.length > page.length
    const last = page.at(-1)?.id ?? frozen
    const body: Json = { events: page, position: mint({ a: last, d }) }
    if (more) body.next = `${origin}/${ACCOUNT}/events.json?position=${mint({ a: last, d, h: frozen })}${filters}`
    return tagged(req, body, { 'x-feed-position': body.position, ...(more ? { link: `<${body.next}>; rel="next"` } : {}) })
  }

  const server = Bun.serve<Cable>({
    port: opts.port ?? 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname.startsWith('/cable/')) {
        const ticket = url.searchParams.get('ticket') ?? ''
        if (url.pathname !== `/cable/${ACCOUNT}` || !((tickets.get(ticket) ?? 0) > Date.now())) return new Response('Unauthorized', { status: 401 })
        return srv.upgrade(req, { data: { ticket } as Cable }) ? undefined : new Response('Upgrade Required', { status: 426 })
      }
      if (url.pathname === '/_sink/seen')    return Response.json({ requests: seen, cable: cableSent, open: cables.size })
      if (url.pathname === '/_sink/reset')   {
        seen.length = 0; answer = null; lost = false; inactive = false; hidden.clear(); rows = null; made.clear()
        minted.clear(); regrant(); refuseRefresh = false; rotate = false; tokenLife = opts.tokenLife ?? 3600
        feed = null; epoch = 0; feedPage = opts.feedPage ?? 100
        cableSent.length = 0; ticketsMinted = 0; tickets.clear(); ticketLife = opts.ticketLife ?? 120; beatMs = opts.beatMs ?? 3000
        return Response.json({ ok: true })
      }
      if (url.pathname === '/_sink/arm') {
        const a = (await req.json()) as Armed
        lost = !!a.lost
        inactive = !!a.inactive
        if (a.expire) for (const m of minted.values()) m.until = 0
        if (a.revoke) grants.delete(a.revoke)
        if (a.refuseRefresh) refuseRefresh = true
        if (a.rotate) rotate = true
        if (a.tokenLife !== undefined) tokenLife = a.tokenLife
        if (a.epoch !== undefined) epoch = a.epoch
        if (a.feedPage !== undefined) feedPage = a.feedPage
        if (a.ticketLife !== undefined) ticketLife = a.ticketLife
        if (a.beatMs !== undefined) beatMs = a.beatMs
        if (a.hangUp) for (const ws of cables) ws.close(1011, 'sink hang-up')
        answer = a.answer ?? (a.rateLimit ? { status: 429, body: { status: 429, error: 'Too Many Requests' }, headers: { 'retry-after': String(a.rateLimit.retryAfter), ...rateLimit(0, a.rateLimit.retryAfter * 1000) } }
          : a.failNext ? { status: 500, body: { status: 500, error: 'Internal Server Error' } }
          : a.forbidden ? { status: 403 }
          : null)
        return Response.json({ ok: true })
      }
      if (url.pathname === '/_sink/hide') {
        const { id } = (await req.json()) as { id: number }
        if (madeRow(id)) hidden.add(id)
        return Response.json({ ok: hidden.has(id) })
      }
      if (url.pathname === '/_sink/seed') {
        const { path, rows: seeded } = (await req.json()) as { path: string; rows: Json[] }
        if (!listOf(path)) return Response.json({ ok: false })
        made.set(path, [...(made.get(path) ?? []), ...seeded.map(r => build(path, r))])
        return Response.json({ ok: true })
      }
      if (url.pathname === '/_sink/events') {
        const { events: added, live = true, duplicate: twice = false } = (await req.json()) as { events: Json[]; live?: boolean; duplicate?: boolean }
        const base = events()[0]
        for (const e of added) events().push({ ...base, details: undefined, ...e, id: events().at(-1)!.id + 7, created_at: new Date().toISOString() })
        const fresh = events().slice(-added.length)
        if (live) for (const ws of cables) {
          const f = ws.data.filters
          if (!f) continue
          for (const e of fresh) {
            if (f.types && !f.types.includes(e.event_type)) continue
            if (f.buckets && !f.buckets.includes(e.bucket_id)) continue
            const frame = JSON.stringify({ identifier: ws.data.identifier, message: { ...e, actor_type: 'person', visible_to_clients: false } })
            ws.send(frame)
            if (twice) ws.send(frame)
          }
        }
        return Response.json({ ok: true, ids: fresh.map(e => e.id) })
      }
      if (url.pathname === '/_sink/project') {
        const patch = (await req.json()) as Json
        const row = projectRows().find(p => p.id === patch.id)
        if (row) Object.assign(row, patch)
        return Response.json({ ok: !!row })
      }
      if (req.method === 'POST' && url.pathname === '/oauth/tokens') {
        const form = Object.fromEntries(new URLSearchParams(await req.text()))
        const entry = { method: req.method, path: url.pathname, userAgent: req.headers.get('user-agent'), authorization: req.headers.get('authorization'), ifNoneMatch: null, body: form, status: 0 }
        seen.push(entry)
        const reply = (b: unknown, status: number, headers: Record<string, string> = {}) => { entry.status = status; return Response.json(b, { status, headers: { 'cache-control': 'no-store', ...headers } }) }
        if (answer) {
          const a = answer
          if (!a.times || --a.times <= 0) answer = null
          return reply(a.body, a.status, a.headers)
        }
        if (form.grant_type !== 'refresh_token') return reply({ error: 'unsupported_grant_type' }, 400)
        if (refuseRefresh || !grants.has(form.refresh_token)) return reply({ error: 'invalid_grant', error_description: 'The provided authorization grant is invalid, expired, revoked, or was issued to another client.' }, 400)
        const access = `bc_minted_${++mints}`, person = grants.get(form.refresh_token)!
        minted.set(access, { until: Date.now() + tokenLife * 1000, person })
        const next = `bc_refresh_${mints}`
        if (rotate) { grants.delete(form.refresh_token); grants.set(next, person) }
        return reply({ access_token: access, token_type: 'Bearer', expires_in: tokenLife, ...(rotate ? { refresh_token: next } : {}) }, 200)
      }
      const text = req.method === 'GET' ? '' : await req.text()
      const entry = { method: req.method, path: `${url.pathname}${url.search}`, userAgent: req.headers.get('user-agent'), authorization: req.headers.get('authorization'), ifNoneMatch: req.headers.get('if-none-match'), body: text ? JSON.parse(text) : null, status: 0 }
      seen.push(entry)
      // A lost answer: the request is applied below and its answer is never sent.
      const record = async (r: Response) => {
        if (lost) { lost = false; await new Promise<void>(res => hanging.push(res)) }
        entry.status = r.status
        return r
      }
      if (!entry.userAgent?.trim()) return record(new Response(NO_UA, { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8', ...rateLimit() } }))
      const bearer = entry.authorization?.match(/^Bearer (.+)$/)?.[1]
      const spent = minted.get(bearer ?? '')
      if (bearer !== TOKEN && !((spent?.until ?? 0) > Date.now())) return record(json({ error: 'OAuth token could not be verified.' }, 401))
      if (inactive) return record(json({ status: 404, error: 'Not Found' }, 404, { reason: 'Account Inactive' }))
      if (answer) {
        const a = answer
        if (!a.times || --a.times <= 0) answer = null
        return record(json(a.body, a.status, a.headers))
      }
      const [, account, ...rest] = url.pathname.split('/')
      const path = `/${rest.join('/')}`
      if (account !== ACCOUNT) return record(notFound())
      const n = (s: string) => Number(s)
      let m: RegExpMatchArray | null
      if (req.method === 'POST' && path === '/events/stream_ticket.json') {
        const ticket = `tkt_${++ticketsMinted}`, life = ticketLife
        tickets.set(ticket, Date.now() + life * 1000)
        return record(json({ ticket, expires_in: life, url: `${origin.replace(/^http/, 'ws')}/cable/${ACCOUNT}?ticket=${ticket}` }, 201))
      }
      if (req.method === 'POST' && listOf(path)) {
        const row = build(path, entry.body as Json, spent?.person)
        made.set(path, [...(made.get(path) ?? []), row])
        return record(json(row, 201))
      }
      if (req.method === 'POST' && (m = path.match(/^\/todos\/(\d+)\/completion\.json$/))) {
        const row = visible(n(m[1]))
        if (row) row.completed = true
        return record(row ? new Response(null, { status: 204, headers: rateLimit() }) : notFound())
      }
      if (req.method !== 'GET') return record(notFound())
      // An empty list is `[]`, not a 404: the parent is there, nothing is on it yet.
      if (listOf(path)) return record(paged(req, url, ordered(path)))
      if (path === '/my/profile.json') return record(tagged(req, profileOf(spent?.person)))
      if (path === '/events.json') return record(poll(req, url))
      if (path === '/projects.json') return record(paged(req, url, projectRows(), true))
      if ((m = path.match(/^\/projects\/(\d+)\.json$/))) {
        const p = projectRows().find(p => p.id === n(m![1]))
        return record(p ? tagged(req, p) : notFound())
      }
      if ((m = path.match(/^\/buckets\/(\d+)\/todosets\/(\d+)\/todolists\.json$/))) {
        const list = fixture('todolist.json')
        return record(list.bucket.id === n(m[1]) && list.parent.id === n(m[2]) ? tagged(req, [list]) : notFound())
      }
      if ((m = path.match(/^\/buckets\/(\d+)\/(todos|todolists|messages|comments)\/(\d+)\.json$/))) {
        if (hidden.has(n(m[3]))) return record(notFound())
        const r = madeRow(n(m[3])) ?? fixture(TYPED[m[2]])
        return record(r.bucket.id === n(m[1]) && r.id === n(m[3]) ? tagged(req, r) : notFound())
      }
      if ((m = path.match(/^\/buckets\/(\d+)\/chats\/\d+\/lines\/(\d+)\.json$/))) {
        const r = fixture('chat-line.json')
        return record(r.bucket.id === n(m[1]) && r.id === n(m[2]) ? tagged(req, r) : notFound())
      }
      if ((m = path.match(/^\/buckets\/(\d+)\/recordings\/(\d+)\.json$/))) {
        const r = [...Object.values(TYPED), 'chat-line.json'].map(fixture).find(r => r.bucket.id === n(m![1]) && r.id === n(m![2]))
        return record(r ? tagged(req, Object.fromEntries(ENVELOPE.filter(k => k in r).map(k => [k, r[k]]))) : notFound())
      }
      return record(notFound())
    },
    websocket: {
      open(ws) {
        cables.add(ws)
        ws.send(JSON.stringify({ type: 'welcome' }))
        ws.data.beat = setInterval(() => ws.send(JSON.stringify({ type: 'ping', message: Math.floor(Date.now() / 1000) })), beatMs)
      },
      close(ws) { clearInterval(ws.data.beat); cables.delete(ws) },
      message(ws, raw) {
        const frame = String(raw)
        cableSent.push({ ticket: ws.data.ticket, frame })
        const c = (() => { try { return JSON.parse(frame) } catch { return null } })()
        const refuse = () => { ws.send(JSON.stringify({ type: 'disconnect', reason: 'invalid_event_stream_command', reconnect: false })); ws.close(1000) }
        if (c?.command !== 'subscribe' || typeof c.identifier !== 'string') { refuse(); return }
        const id = (() => { try { return JSON.parse(c.identifier) } catch { return null } })()
        if (!id) { refuse(); return }
        const reject = () => { ws.send(JSON.stringify({ identifier: c.identifier, type: 'reject_subscription' })) }
        if (ws.data.identifier !== undefined) { if (ws.data.identifier !== c.identifier) reject(); return }
        const types = typeof id.types === 'string' ? id.types.split(',') : undefined
        const buckets = typeof id.buckets === 'string' ? id.buckets.split(',').map(Number) : undefined
        if (id.channel !== 'EventsChannel' || (types && !types.every((t: string) => CATALOG.has(t)))) { reject(); return }
        ws.data.identifier = c.identifier
        ws.data.filters = { types, buckets }
        ws.send(JSON.stringify({ identifier: c.identifier, type: 'confirm_subscription' }))
      },
    },
  })
  origin = `http://127.0.0.1:${server.port}`
  return { port: server.port, url: origin, account: ACCOUNT, token: TOKEN, refreshToken: opts.refreshToken ?? 'bc_refresh', people: opts.people ?? {}, stop() { hanging.splice(0).forEach(res => res()); for (const ws of cables) clearInterval(ws.data.beat); server.stop(true) } }
}
if (import.meta.main) console.log(`[basecamp-sink] ${startBasecampSink({ port: Number(process.env.BASECAMP_SINK_PORT ?? 0) }).url}`)
