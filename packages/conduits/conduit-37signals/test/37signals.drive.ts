// test/37signals.drive.ts — the connector against the sink, and 0.2's
// fixtures. What only this drive asks: the account is the target's address
// and the `User-Agent` the target's header, so a call names neither and none
// can forget them; a target whose `User-Agent` is empty gets Basecamp's `400`
// (the negative control); a 403 is `forbidden` and not a bad key; a 404 is
// `gone` unless it carries `Reason: Account Inactive`; and no fixture carries
// an address that is not a placeholder, because Kobami's account is client data.
// The reads (2.2): a walk follows `Link` whole and stops on the empty page that
// still names a next one; a list is `unchanged` only when every page answers
// `304`; a recording's envelope is followed to its typed read; the todolists
// are the ENABLED todoset's.
// The verbs (2.3): a create is sent once, so a lost answer is `indeterminate`
// with ONE request on the wire, and `findCreated` on its attempt finds the row
// it made — by this principal, since the attempt, with its text, through the
// `<div>` Basecamp wraps rich text in — and nothing older, nobody else's and
// nothing never sent. A completion is a state and is resent.
// Rich text (2.4): `{ text }` goes out escaped with its line breaks as `<br>`,
// and a lost one is found by its words, `<` and all; a plain field (a to-do's
// name) is compared as written, never stripped as if it were markup.
// Chaos (2.5): a read waits out `Retry-After` and is resent, a create is not —
// a 429 left it unapplied and says so, a 500 may have applied it and is
// `indeterminate`, and `findCreated` tells the two apart. An inactive account
// answers every path alike and nothing retries it. A row this token cannot see
// answers the 404 an id that never existed does.
// The token (2.6): a refresh is a form POST to `token` with no bearer, its
// `expires_in` is when the token stops, two sends across an expiry make one
// refresh whether the clock or a `401` found it, a refused refresh is one
// `auth_failed` that the grant store hears and no send repeats, a refresh that
// failed in transit is sent once and keeps the grant, and a rotated
// refresh token reaches the app before the next refresh spends it.
// The feed (3.1): a poll enters by `since` and names FEED_TYPES and never
// `exclude_performers`; a walk follows `next` whole to the end, in id order,
// each event once; a stored position resumes after it; a position under other
// filters is `filters_changed` and a bad one `invalid_position`, both
// re-entered by `since` from the last event applied; a position below the
// epoch is `before_epoch` and its `resume` re-enters at the epoch; a bad
// cursor or filter never reaches the wire.
// The apply (3.3): a replayed walk names only job ids already queued; a
// re-read answers the recording as it is now, typed where the event names its
// noun and through the envelope for a chat line or a boost; a 404 is `gone`
// in one request, whether the row is hidden or never was; a malformed event
// never reaches the wire.
// The stream (3.4): each dial mints its own ticket and dials the URL it
// answered whole, so a redial after the first ticket expired still connects;
// one subscribe goes out with the poll's filters and nothing else ever does,
// the server's beat neither decoded nor counted dropped; a frame lands once
// however often it is sent, under the job id the poll later names it by, and
// the poll repairs a frame the socket never carried; a rejected subscription
// is never believed; bad filters never reach the wire.

import { readdirSync, readFileSync } from 'node:fs'
import { createConduit, withCache } from '@frontierjs/conduit'
import type { CredentialCaller, CredentialResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '@frontierjs/conduit/testing'
import { startBasecampSink } from '../sink.ts'
import { basecampTargets, bindBasecamp, translate, basecampTokenResolver, BASECAMP_API_TARGET, BASECAMP_PERSON_TARGET, type GrantStore, type BasecampSend, me, project, projects, recording, todolists, walk, nextLink, type DockEntry,
  createTodo, completeTodo, postMessage, comment, chatLine, findCreated, type RichText, pollEvents, FEED_TYPES, type FeedFrom, type FeedFilters, eventJobId, reread,
  basecampStreamDialect, BASECAMP_STREAM_TARGET, type StreamEvent } from '../src/index.ts'

const { got, t } = results()
const sink = startBasecampSink({ people: { bc_refresh_ana: 1000200, bc_refresh_ben: 1000201 } }), ctl = control(sink.url)
const UA = 'conduit-37signals drive (https://frontierjs.dev)'
const credentials: CredentialResolver = { async get(ref) { return ref === 'BASECAMP_TOKEN' ? sink.token : null } }
const conduit = createConduit({ credentials, ...DRIVE_RESILIENCE })
const targets = basecampTargets({ accountId: sink.account, userAgent: UA, apiOrigin: sink.url })
await conduit.register(targets.api)
// An EMPTY header, not an absent one: Bun's fetch fills an absent one with
// `Bun/1.4.2`, which Basecamp answers 200 (measured), so only an empty one
// reaches the 400.
await conduit.register({ ...targets.api, id: 'provider:37signals:no-ua', headers: { 'user-agent': '' } })
const send = bindBasecamp(conduit, targets)
const noUa = bindBasecamp(conduit, { ...targets, api: { id: 'provider:37signals:no-ua' } })
const fail = async (armed: Record<string, unknown>, path = '/my/profile.json') => {
  await ctl.reset(); await ctl.arm(armed)
  const r = await send.api({ method: 'GET', path, replayable: true })
  return r.error ? translate(r.error, r.meta.status, r.meta.headers) : null
}
const throws = (fn: () => unknown) => { try { fn(); return null } catch (e) { return (e as Error).constructor.name } }
const rejects = (p: Promise<unknown>) => p.then(() => null, e => (e as Error).constructor.name)
type Seen = { method: string; path: string; userAgent: string; authorization: string; ifNoneMatch: string | null; body: Record<string, unknown> | null; status: number }
const requests = async () => ((await fetch(`${sink.url}/_sink/seen`).then(r => r.json())) as { requests: Seen[] }).requests
// A walk that never stops would hang the drive rather than fail it, so a walk
// row spends a `send` that gives out after `n` calls.
const capped = (n = 20, base: BasecampSend = send): BasecampSend => ({ ...base, api: req => --n < 0 ? Promise.reject(new Error('runaway')) : base.api(req) })
const runaway = <T>(p: Promise<T>) => p.catch(e => { if ((e as Error).message === 'runaway') return 'runaway' as const; throw e })

try {
  const real = basecampTargets({ accountId: 999, userAgent: UA })
  t('targets.defaults', {
    api: real.api.address, apiId: real.api.id, apiAuth: real.api.auth.type, ua: real.api.headers?.['user-agent'],
    token: real.token.address, tokenAuth: real.token.auth.type, tokenEncoding: real.token.encoding,
    stream: [real.stream.id, real.stream.kind, real.stream.address, real.stream.auth.type],
    person: [real.person.id, real.person.address === real.api.address, real.person.headers?.['user-agent'] === UA, real.person.auth],
  })
  t('targets.refuseWithoutUaOrAccount', {
    noUa: throws(() => basecampTargets({ accountId: 999, userAgent: '' })),
    blankUa: throws(() => basecampTargets({ accountId: 999, userAgent: '   ' })),
    noAccount: throws(() => basecampTargets({ accountId: '', userAgent: UA })),
    url: throws(() => basecampTargets({ accountId: 'https://3.basecampapi.com/999', userAgent: UA })),
  })

  await ctl.reset()
  const mine = await send.api<{ id: number }>({ method: 'GET', path: '/my/profile.json', replayable: true })
  const { requests: [wire] } = await fetch(`${sink.url}/_sink/seen`).then(r => r.json()) as { requests: { path: string; userAgent: string; authorization: string }[] }
  t('send.accountAndUaOnTheWire', { status: mine.meta.status, id: mine.data?.id, path: wire?.path, ua: wire?.userAgent === UA, bearer: wire?.authorization === `Bearer ${sink.token}`, ratelimit: !!mine.meta.headers?.['x-ratelimit'] })

  await ctl.reset()
  const bare = await noUa.api({ method: 'GET', path: '/projects.json', replayable: true })
  const refused = bare.error ? translate(bare.error, bare.meta.status, bare.meta.headers) : null
  t('control.noUserAgentIs400', { status: bare.meta.status, kind: refused?.kind, retryable: refused?.retryable, names: /User-Agent/.test(refused?.message ?? '') })

  const forbidden = await fail({ forbidden: true })
  t('translate.403EmptyIsForbidden', { kind: forbidden?.kind, retryable: forbidden?.retryable, said: !!forbidden?.message, requests: (await requests()).length })

  const body404 = JSON.parse(readFileSync(new URL('./fixture/not-found.json', import.meta.url), 'utf8'))
  const gone = await fail({ answer: { status: 404, body: body404 } }, '/buckets/1/todos/1.json')
  t('translate.404IsGone', { kind: gone?.kind, message: gone?.message, retryable: gone?.retryable })


  const position = JSON.parse(readFileSync(new URL('./fixture/events-invalid-position.json', import.meta.url), 'utf8'))
  const bad = await fail({ answer: { status: 400, body: position } }, '/events.json')
  t('translate.400NamesItsReason', { kind: bad?.kind, code: bad?.code, retryable: bad?.retryable })

  // Last: conduit counts a 5xx toward the breaker, and a 507 is one.
  const full = await fail({ answer: { status: 507, body: { status: 507, error: 'Insufficient Storage' }, times: 3 } })
  t('translate.507IsCapacity', { kind: full?.kind, retryable: full?.retryable })

  // ─── Reads ───────────────────────────────────────────────────
  await ctl.reset()
  const who = await me(send)
  const whoAgain = await me(send, { etag: who.etag })
  t('reads.meThenUnchanged', { id: who.row?.id, weak: who.etag?.startsWith('W/"'), unchanged: whoAgain.unchanged, row: whoAgain.row ?? null })

  await ctl.reset()
  const all = await runaway(projects(capped()))
  const walked = await requests()
  t('walk.gearedStopsOnTheEmptyPage', {
    rows: all === 'runaway' ? 'runaway' : all.rows?.length,
    pages: walked.map(w => w.path),
    everyPageAuthored: walked.every(w => w.userAgent === UA && w.authorization === `Bearer ${sink.token}`),
  })

  await ctl.reset()
  const first = await projects(capped())
  await ctl.reset()
  const again = await projects(capped(), { etags: first.etags })
  t('walk.everyPage304IsUnchanged', { unchanged: again.unchanged, rows: again.rows ?? null, statuses: (await requests()).map(w => w.status), conditional: (await requests()).every(w => w.ifNoneMatch?.startsWith('W/"')) })

  // Page 3's row changes; pages 1 and 2 still answer 304, so one tag could not have said so.
  await ctl.reset()
  const before = await projects(capped())
  await fetch(`${sink.url}/_sink/project`, { method: 'POST', body: JSON.stringify({ id: 2_000_046, name: 'Renamed' }) })
  const after = await projects(capped(), { etags: before.etags })
  const statuses = (await requests()).slice(4).map(w => w.status)
  t('walk.aChangedPageRestarts', { unchanged: after.unchanged ?? null, rows: after.rows?.length, renamed: after.rows?.find(p => p.id === 2_000_046)?.name, statuses })

  await ctl.reset()
  await ctl.arm({ answer: { status: 200, body: [{ id: 1 }], headers: { link: `<${sink.url}/999/projects.json?page=2>; rel="next"` }, times: 3 } })
  const cycle = await runaway(walk(capped(), '/projects.json'))
  t('walk.aLinkCycleIsRefused', { kind: cycle === 'runaway' ? 'runaway' : cycle.error?.kind, requests: (await requests()).length })

  await ctl.reset()
  await ctl.arm({ answer: { status: 200, body: [{ id: 1 }], headers: { link: '<https://elsewhere.example/999/projects.json?page=2>; rel="next"' } } })
  const foreign = await walk(capped(), '/projects.json')
  t('walk.aForeignLinkIsNotFollowed', { kind: foreign.error?.kind, requests: (await requests()).length })

  t('walk.nextLink', {
    one: nextLink('<https://3.basecampapi.com/999/projects.json?page=2>; rel="next"'),
    many: nextLink('<https://a/1>; rel="prev", <https://a/3>; rel="next"'),
    none: nextLink(undefined) ?? null,
  })

  await ctl.reset()
  const home = await project(send, 1_000_161)
  const reversed = { id: home.row!.id, dock: [...home.row!.dock].reverse() as DockEntry[] }
  const lists = await todolists(capped(), reversed)
  const disabled = home.row!.dock.find(d => d.name === 'todoset' && !d.enabled)!
  const wrong = await walk(capped(), `/buckets/${home.row!.id}/todosets/${disabled.id}/todolists.json`)
  t('todolists.theEnabledTodoset', {
    todosets: home.row!.dock.filter(d => d.name === 'todoset').length,
    firstByNameIsDisabled: reversed.dock.find(d => d.name === 'todoset')?.enabled,
    lists: lists.rows?.map(l => l.id), disabledSetIs: wrong.error?.kind,
  })

  await ctl.reset()
  const off = await todolists(capped(), { id: 2_000_001, dock: [] })
  t('todolists.toolOffIsEmpty', { rows: off.rows, requests: (await requests()).length })

  await ctl.reset()
  const typed = await recording(send, 1_000_161, 1_000_434, { type: 'Todo' })
  const typedAgain = await recording(send, 1_000_161, 1_000_434, { type: 'Todo', etag: typed.etag })
  t('recording.typedOneRequest', { completed: typeof typed.row?.completed, completionUrl: !!typed.row?.completion_url, unchanged: typedAgain.unchanged, requests: (await requests()).length })

  await ctl.reset()
  const envelope = await send.api<Record<string, unknown>>({ method: 'GET', path: '/buckets/1000161/recordings/1000434.json', replayable: true })
  const untyped = await recording(send, 1_000_161, 1_000_434)
  t('recording.untypedFollowsTheEnvelope', {
    envelopeHasCompleted: 'completed' in (envelope.data ?? {}),
    completed: typeof (untyped.row as { completed?: unknown } | undefined)?.completed,
    paths: (await requests()).slice(1).map(w => w.path),
  })

  const line = await recording(send, 1_000_161, 1_000_490)
  t('recording.aChatLineByItsEnvelope', { type: line.row?.type, content: typeof (line.row as { content?: unknown } | undefined)?.content })

  // Each typed path is a hand-kept table entry; a wrong one is a 404, read as `gone`.
  const each = await Promise.all([
    recording(send, 1_000_161, 1_000_427, { type: 'Todolist' }),
    recording(send, 1_000_119, 1_000_280, { type: 'Message' }),
    recording(send, 1_000_161, 1_000_497, { type: 'Comment' }),
  ])
  t('recording.everyTypedPath', each.map(r => r.row?.type ?? r.error?.kind))

  const missing = await recording(send, 1_000_161, 1, { type: 'Todo' })
  t('recording.hiddenIsGone', { kind: missing.error?.kind, retryable: missing.error?.retryable })

  t('recording.refusesBadInput', {
    type: await rejects(recording(send, 1, 1, { type: 'Kanban' as 'Todo' })),
    bucket: await rejects(recording(send, 1.5, 1)),
    id: await rejects(recording(send, 1, -1)),
  })

  // ─── Verbs ───────────────────────────────────────────────────
  const B = 1_000_161, LIST = 1_000_427, TODO = 1_000_434, CHAT = 1_000_448, BOARD_BUCKET = 1_000_119, BOARD = 1_000_273, ME = 1_000_133
  const seed = (path: string, rows: Record<string, unknown>[]) => fetch(`${sink.url}/_sink/seed`, { method: 'POST', body: JSON.stringify({ path, rows }) })
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  const posts = async () => (await requests()).filter(w => w.method === 'POST')

  await ctl.reset()
  const todo = await createTodo(send, { bucket: B, todolist: LIST, content: 'Call Ana', description: { html: '<b>before Friday</b>' }, dueOn: '2026-10-20', assigneeIds: [ME], notify: true })
  const [todoPost] = await posts()
  t('create.todoOnTheWire', {
    path: todoPost?.path, body: todoPost?.body, id: typeof todo.row?.id, content: todo.row?.content,
    attempt: { type: todo.attempt.type, bucket: todo.attempt.bucket, parent: todo.attempt.parent, match: todo.attempt.match, startedAt: typeof todo.attempt.startedAt },
  })

  await ctl.reset()
  const msg = await postMessage(send, { bucket: BOARD_BUCKET, board: BOARD, subject: 'Week 42', content: { html: 'Plan' } })
  t('create.messageIsPublished', { path: (await posts())[0]?.path, status: (await posts())[0]?.body?.status, subject: msg.row?.subject })

  await ctl.reset()
  const said = await comment(send, { bucket: B, recording: TODO, content: { html: 'On it &amp; done' } })
  const posted = await chatLine(send, { bucket: B, chat: CHAT, content: { text: 'Deploying' } })
  t('create.commentAndLine', { comment: (await posts())[0]?.path, stored: said.row?.content, line: (await posts())[1]?.path, lineBody: (await posts())[1]?.body, lineType: posted.row?.type })

  // The lost create: applied, never answered.
  await ctl.reset()
  await seed(`/buckets/${B}/recordings/${TODO}/comments.json`, [
    ...Array.from({ length: 20 }, (_, i) => ({ content: `Older ${i}`, created_at: ago(3_600_000 - i * 1000) })),
    { content: 'Did this land?', created_at: ago(3_600_000) },
    { content: 'Did this land?', creatorId: 1_000_189, created_at: ago(1000) },
  ])
  await ctl.arm({ lost: true })
  const lost = await comment(send, { bucket: B, recording: TODO, content: { html: '<p>Did this <em>land</em>?</p>' } })
  t('create.lostIsIndeterminateAndSentOnce', { kind: lost.error?.kind, indeterminate: lost.error?.indeterminate ?? null, row: lost.row ?? null, posts: (await posts()).length })

  const sentSoFar = (await requests()).length
  const found = await findCreated(send, lost.attempt)
  const reads = (await requests()).slice(sentSoFar).map(w => w.path)
  t('find.theLostCommentThroughItsDiv', { found: found.found?.length, stored: found.found?.[0]?.content, mine: found.found?.[0]?.creator.id, pages: reads.filter(p => p.includes('/comments.json')).length })

  const never = await findCreated(send, { ...lost.attempt, match: 'Never sent' })
  t('find.nothingNeverSentOlderOrOthers', { never: never.found, olderAndOthersExcluded: found.found?.length === 1 })

  await ctl.reset()
  await seed(`/buckets/${B}/chats/${CHAT}/lines.json`, Array.from({ length: 40 }, (_, i) => ({ content: `Old line ${i}`, created_at: ago(7_200_000 + i * 1000) })))
  await ctl.arm({ lost: true })
  const lostLine = await chatLine(send, { bucket: B, chat: CHAT, content: { text: 'Deploy done' } })
  const lineFound = await findCreated(send, lostLine.attempt)
  t('find.newestFirstStopsAtOnePage', { indeterminate: lostLine.error?.indeterminate ?? null, found: lineFound.found?.map(l => l.content), lineReads: (await requests()).filter(w => w.method === 'GET' && w.path.includes('/lines.json')).length })

  await ctl.reset()
  const made = await createTodo(send, { bucket: B, todolist: LIST, content: 'Ship it' })
  const done = await completeTodo(send, made.row!)
  const afterCompletion = await recording(send, B, made.row!.id, { type: 'Todo' })
  t('complete.followsCompletionUrl', { ok: done.ok, unbucketed: (await posts())[1]?.path === `/999/todos/${made.row!.id}/completion.json`, completed: afterCompletion.row?.completed })

  await ctl.reset()
  const twice = await createTodo(send, { bucket: B, todolist: LIST, content: 'Ship it twice' })
  await ctl.arm({ lost: true })
  const resent = await completeTodo(send, twice.row!)
  t('complete.aLostCompletionIsResent', { ok: resent.ok, completions: (await posts()).filter(w => w.path.endsWith('/completion.json')).length })

  // ─── Rich text (2.4) ─────────────────────────────────────────
  await ctl.reset()
  const escaped = await comment(send, { bucket: B, recording: TODO, content: { text: 'a <b> & "c"\nd' } })
  t('rich.textIsEscaped', { sent: (await posts())[0]?.body?.content, stored: escaped.row?.content, match: escaped.attempt.match })

  await ctl.reset()
  await ctl.arm({ lost: true })
  const lostText = await chatLine(send, { bucket: B, chat: CHAT, content: { text: 'if a <b> && c > d\nship' } })
  const textFound = await findCreated(send, lostText.attempt)
  t('find.aLostLineByItsWords', { indeterminate: lostText.error?.indeterminate ?? null, found: textFound.found?.map(l => l.content) })

  await ctl.reset()
  await ctl.arm({ lost: true })
  const lostName = await createTodo(send, { bucket: B, todolist: LIST, content: 'Fix <div> & &amp;' })
  const nameFound = await findCreated(send, lostName.attempt)
  t('find.aPlainFieldIsNotParsed', { match: lostName.attempt.match, found: nameFound.found?.map(r => r.content) })

  t('rich.refusesAmbiguousBodies', {
    bareLine: await rejects(chatLine(send, { bucket: B, chat: CHAT, content: 'hi' as unknown as RichText })),
    both: await rejects(comment(send, { bucket: B, recording: TODO, content: { text: 'a', html: 'a' } as unknown as RichText })),
    emptyText: await rejects(chatLine(send, { bucket: B, chat: CHAT, content: { text: ' \n ' } })),
    description: await rejects(createTodo(send, { bucket: B, todolist: LIST, content: 'x', description: '<b>x</b>' as unknown as RichText })),
  })

  t('create.refusesBadInput', {
    bareString: await rejects(comment(send, { bucket: B, recording: TODO, content: 'hi' as unknown as RichText })),
    emptyComment: await rejects(comment(send, { bucket: B, recording: TODO, content: { html: '<div> </div>' } })),
    noName: await rejects(createTodo(send, { bucket: B, todolist: LIST, content: ' ' })),
    date: await rejects(createTodo(send, { bucket: B, todolist: LIST, content: 'x', dueOn: '20 Oct' })),
    parent: await rejects(chatLine(send, { bucket: B, chat: 0, content: { text: 'x' } })),
    noSubject: await rejects(postMessage(send, { bucket: B, board: BOARD, subject: '' })),
    completion: await rejects(completeTodo(send, {} as { completion_url: string })),
  })

  // ─── Chaos (2.5) ─────────────────────────────────────────────
  await ctl.reset()
  await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const started = performance.now()
  const waited = await me(send)
  const waitedMs = performance.now() - started
  const [limitedHit] = await requests()
  const raw = await fetch(`${sink.url}/_sink/seen`).then(r => r.json()) as { requests: Seen[] }
  t('rate.aReadWaitsOutRetryAfter', { id: waited.row?.id, statuses: raw.requests.map(w => w.status), waitedTheSecond: waitedMs >= 1000, first: limitedHit?.path })

  await ctl.reset()
  await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const refusedComment = await comment(send, { bucket: B, recording: TODO, content: { text: 'Rate me' } })
  const notMade = await findCreated(send, refusedComment.attempt)
  t('rate.aCreateIsRefusedNotLost', {
    kind: refusedComment.error?.kind, retryable: refusedComment.error?.retryable, retryAfterMs: refusedComment.error?.retryAfterMs,
    indeterminate: refusedComment.error?.indeterminate ?? null, posts: (await posts()).length, found: notMade.found,
  })

  await ctl.reset()
  await ctl.arm({ failNext: true })
  const flaky = await me(send)
  t('fail.aReadIsResent', { id: flaky.row?.id, statuses: (await requests()).map(w => w.status) })

  await ctl.reset()
  await ctl.arm({ failNext: true })
  const broken = await createTodo(send, { bucket: B, todolist: LIST, content: 'Survive a 500' })
  const brokenFound = await findCreated(send, broken.attempt)
  t('fail.aCreateIsIndeterminateAndFindSaysNotMade', { kind: broken.error?.kind, indeterminate: broken.error?.indeterminate ?? null, posts: (await posts()).length, found: brokenFound.found })

  await ctl.reset()
  await ctl.arm({ inactive: true })
  const dead = await Promise.all([
    me(send).then(r => r.error),
    projects(capped()).then(r => r.error),
    comment(send, { bucket: B, recording: TODO, content: { text: 'Anyone?' } }).then(r => r.error),
  ])
  const deadRequests = (await requests()).length
  await ctl.reset()
  t('inactive.everyPathOnceAndNoRetry', {
    kinds: dead.map(e => e?.kind), retryable: dead.map(e => e?.retryable), indeterminate: dead[2]?.indeterminate ?? null,
    requests: deadRequests, afterReset: (await me(send)).row?.id,
  })

  await ctl.reset()
  const shown = await createTodo(send, { bucket: B, todolist: LIST, content: 'Out of sight' })
  await createTodo(send, { bucket: B, todolist: LIST, content: 'In sight' })
  await fetch(`${sink.url}/_sink/hide`, { method: 'POST', body: JSON.stringify({ id: shown.row!.id }) })
  const hiddenRead = await send.api({ method: 'GET', path: `/buckets/${B}/todos/${shown.row!.id}.json`, replayable: true })
  const neverRead = await send.api({ method: 'GET', path: `/buckets/${B}/todos/1.json`, replayable: true })
  const hiddenTyped = await recording(send, B, shown.row!.id, { type: 'Todo' })
  const listed = await walk<{ id: number; content: string }>(capped(), `/buckets/${B}/todolists/${LIST}/todos.json`)
  t('hidden.goneAsIfItNeverWas', {
    kind: hiddenTyped.error?.kind,
    sameAnswer: hiddenRead.meta.status === neverRead.meta.status && JSON.stringify(hiddenRead.error?.raw) === JSON.stringify(neverRead.error?.raw),
    status: hiddenRead.meta.status, listed: listed.rows?.map(r => r.content),
  })

  // A second conduit, whose `api` bearer is minted at `token`; the store is the
  // app's row for Jordan's grant.
  const grant = { refresh: sink.refreshToken as string | null, lost: [] as string[], rotated: [] as [string, string][] }
  const resolver = basecampTokenResolver(bindBasecamp({ send: req => minting.send(req) }), {
    clientId: 'fjs-drive',
    grants: {
      refreshTokenFor: () => grant.refresh,
      onLost: (_ref, f) => { grant.lost.push(f.code ?? f.kind); grant.refresh = null },
      onRotated: (_ref, next, previous) => { grant.rotated.push([previous, next]); grant.refresh = next },
    },
  })
  const minting = createConduit({ credentials: withCache(resolver, { ttl_ms: Infinity }), ...DRIVE_RESILIENCE })
  const tokenTargets = basecampTargets({ accountId: sink.account, userAgent: UA, apiOrigin: sink.url, tokenOrigin: sink.url })
  await minting.register(tokenTargets.api)
  await minting.register(tokenTargets.token)
  const authed = bindBasecamp(minting, tokenTargets)
  const refreshes = async () => (await requests()).filter(w => w.path === '/oauth/tokens')
  const bearers = async () => (await requests()).filter(w => w.path !== '/oauth/tokens').map(w => [w.authorization, w.status])

  await ctl.reset()
  await ctl.arm({ tokenLife: 1 })
  const firstMint = await me(authed)
  const [mint] = await refreshes()
  t('token.refreshOnTheWire', {
    id: firstMint.row?.id, path: mint?.path, body: mint?.body, bearer: mint?.authorization ?? null, ua: mint?.userAgent === UA,
    spent: await bearers(),
  })

  // The clock: the token's one second is over, and two reads find it so together.
  await new Promise(res => setTimeout(res, 1_100))
  const pair = await Promise.all([me(authed), projects(capped(20, authed))])
  t('token.twoAcrossAnExpiryOneRefresh', { ids: [pair[0].row?.id, pair[1].rows?.length], refreshes: (await refreshes()).length, spent: (await bearers()).slice(1) })

  // The far side: Basecamp ended the token while the cache still held it.
  await ctl.reset()
  await ctl.arm({ expire: true })
  const held = await me(authed)
  await ctl.reset()
  await ctl.arm({ expire: true })
  const replayed = await Promise.all([me(authed), me(authed)])
  t('token.a401RemintsOnceForBoth', {
    held: held.row?.id, ids: replayed.map(r => r.row?.id), refreshes: (await refreshes()).length,
    statuses: (await bearers()).map(b => b[1]).sort(),
  })

  await ctl.reset()
  await ctl.arm({ expire: true, refuseRefresh: true })
  const refusedMint = await me(authed)
  const afterRefusal = await me(authed)
  t('token.aRefusedRefreshIsAuthFailedOnce', {
    kind: refusedMint.error?.kind, retryable: refusedMint.error?.retryable, lost: [...grant.lost],
    refreshes: (await refreshes()).length, apiRequests: (await bearers()).length, after: afterRefusal.error?.kind,
  })

  grant.refresh = sink.refreshToken
  await ctl.reset()
  // A refresh is sent once, as `conduit-oidc`'s is: a 429 never reached
  // Basecamp and is worth sending again, a 500 may have burned a rotating
  // token and is not, and neither loses the grant.
  await ctl.arm({ expire: true, rateLimit: { retryAfter: 1 } })
  const throttled = await me(authed)
  await ctl.arm({ expire: true, failNext: true })
  const outage = await me(authed)
  t('token.aFailedRefreshKeepsTheGrant', {
    throttled: [throttled.error?.kind, throttled.error?.retryable, throttled.error?.retryAfterMs],
    outage: [outage.error?.kind, outage.error?.retryable], grantKept: grant.refresh === sink.refreshToken,
    later: (await me(authed)).row?.id, refreshes: (await refreshes()).map(w => w.status),
  })

  await ctl.reset()
  await ctl.arm({ expire: true, rotate: true })
  await me(authed)
  await ctl.arm({ expire: true })
  const rotatedRead = await me(authed)
  t('token.aRotatedRefreshReachesTheApp', {
    id: rotatedRead.row?.id, rotated: [...grant.rotated], sent: (await refreshes()).map(w => w.body?.refresh_token),
  })

  // A third conduit, whose `person` spends the caller's grant: the store is
  // each person's own row (`FJS-D1126`), read off `who.principal`.
  const rows: Record<string, { refresh: string | null; lost: string[] }> = { ana: { refresh: 'bc_refresh_ana', lost: [] }, ben: { refresh: 'bc_refresh_ben', lost: [] } }
  const rowOf = (who: CredentialCaller): GrantStore => ({
    refreshTokenFor: () => rows[who.principal ?? '']?.refresh ?? null,
    onLost: (_ref, f) => { rows[who.principal!].lost.push(f.code ?? f.kind); rows[who.principal!].refresh = null },
  })
  const perCaller = createConduit({
    credentials: withCache(basecampTokenResolver(bindBasecamp({ send: req => perCaller.send(req) }), { clientId: 'fjs-drive', grantsFor: rowOf }), { ttl_ms: Infinity }),
    ...DRIVE_RESILIENCE,
  })
  await perCaller.register(tokenTargets.person)
  await perCaller.register(tokenTargets.token)
  // Whose grant a call spends is chosen once, at bind, never by handing a call a different Send.
  const asPerson = (principal: string) => bindBasecamp(perCaller, tokenTargets, { as: 'person', who: { tenant: null, principal, grant: null } })
  const refreshed = async () => (await refreshes()).map(w => w.body?.refresh_token)

  await ctl.reset()
  const spent = [await me(asPerson('ana')), await me(asPerson('ben')), await me(asPerson('ana'))]
  const personBearers = (await bearers()).map(b => b[0])
  t('person.spendsTheCallersToken', {
    ids: spent.map(r => r.row?.id), refreshed: await refreshed(),
    bearers: [personBearers[0] === personBearers[2], personBearers[0] !== personBearers[1]],
  })

  const bens = await createTodo(asPerson('ben'), { bucket: B, todolist: LIST, content: 'Ben calls Ana' })
  t('person.aVerbIsTheCallersOwn', {
    creator: bens.row?.creator?.id,
    foundByBen: (await findCreated(asPerson('ben'), bens.attempt)).found?.length,
    foundByAna: (await findCreated(asPerson('ana'), bens.attempt)).found?.length,
  })

  await ctl.reset()
  await ctl.arm({ expire: true, revoke: 'bc_refresh_ana' })
  const anaLost = await me(asPerson('ana'))
  const benAfter = await me(asPerson('ben'))
  t('person.aLostGrantIsTheCallersAlone', {
    ana: [anaLost.error?.kind, anaLost.error?.retryable], lost: [rows.ana.lost, rows.ben.lost], ben: benAfter.row?.id,
    refreshed: await refreshed(), anaAgain: (await me(asPerson('ana'))).error?.kind,
  })

  await ctl.reset()
  const nobody = await bindBasecamp(perCaller, tokenTargets, { as: 'person' }).api({ method: 'GET', path: '/my/profile.json', replayable: true })
  const appOnly = createConduit({ credentials: basecampTokenResolver(send, { clientId: 'fjs-drive', grants: { refreshTokenFor: () => null } }), ...DRIVE_RESILIENCE })
  t('person.noCallerOrNoStoreFailsClosed', {
    nobody: nobody.error?.kind, requests: (await requests()).length,
    noGrantsFor: await rejects(appOnly.register(tokenTargets.person)),
    noStore: throws(() => basecampTokenResolver(send, { clientId: 'fjs-drive' })),
  })

  const polls = async () => (await requests()).filter(w => w.path.startsWith('/999/events.json'))
  const query = (w: Seen) => Object.fromEntries(new URL(w.path, sink.url).searchParams)
  const appendEvents = (events: Record<string, unknown>[]) => fetch(`${sink.url}/_sink/events`, { method: 'POST', body: JSON.stringify({ events }) }).then(r => r.json() as Promise<{ ids: number[] }>)
  /** Every page from `from`, following `next` whole, as a caller applies them. */
  const drain = async (from: FeedFrom & FeedFilters) => {
    const ids: number[] = []
    let page = await pollEvents(send, from), pages = 1
    for (;;) {
      if (page.error) return { ids, pages, position: undefined, error: page.error }
      ids.push(...page.events!.map(e => e.id))
      if (!page.next || pages > 10) return { ids, pages, position: page.position }
      page = await pollEvents(send, { url: page.next }); pages++
    }
  }

  await ctl.reset()
  const present = await pollEvents(send, { since: 'now' })
  const [entry] = await polls()
  t('feed.entersAtThePresent', {
    events: present.events, position: typeof present.position, next: present.next ?? null,
    since: query(entry).since, types: query(entry).types?.split(',').length, excludes: 'exclude_performers' in query(entry),
  })

  await ctl.reset()
  await ctl.arm({ feedPage: 5 })
  const replay = await drain({ since: 0 })
  const replayPolls = await polls()
  t('feed.replayFollowsNextToTheEnd', {
    ids: replay.ids, pages: replay.pages,
    followedWhole: replayPolls.slice(1).every(w => query(w).position !== undefined && query(w).types === FEED_TYPES.join(',')),
  })

  const added = await appendEvents([{ event_type: 'todo.created', kind: 'todo_created', recording_id: 1000500 }, { event_type: 'card.created', kind: 'card_created' }])
  const resumed = await pollEvents(send, { position: replay.position! })
  const idle = await pollEvents(send, { position: resumed.position! })
  t('feed.resumesAfterItsPosition', { ids: resumed.events?.map(e => e.id), added: added.ids[0], next: resumed.next ?? null, after: idle.events?.length })

  await ctl.reset()
  const narrowed = await drain({ since: 0, types: ['todo.created', 'todo.completed'], buckets: [1000147] })
  const [narrow] = await polls()
  t('feed.filtersRideTheQuery', { ids: narrowed.ids, types: query(narrow).types, buckets: query(narrow).buckets })

  await ctl.reset()
  await ctl.arm({ feedPage: 4 })
  const firstPage = await pollEvents(send, { since: 0 })
  const lastApplied = firstPage.events!.at(-1)!.id
  const changed = await pollEvents(send, { position: firstPage.position!, types: ['todo.completed'] })
  const reentered = await drain({ since: lastApplied, types: ['todo.completed'] })
  t('feed.otherFiltersAreFiltersChanged', {
    kind: changed.error?.kind, code: changed.error?.code, retryable: changed.error?.retryable, events: changed.events ?? null,
    lastApplied, reentered: reentered.ids,
  })

  await ctl.reset()
  await ctl.arm({ feedPage: 2 })
  const heldPage = await pollEvents(send, { since: 0 })
  await ctl.arm({ epoch: 1000560 })
  const below = await pollEvents(send, { position: heldPage.position! })
  const atEpoch = await drain({ url: below.error?.resume ?? 'http://127.0.0.1:1/' })
  t('feed.belowTheEpochResumesAtIt', {
    kind: below.error?.kind, code: below.error?.code, retryable: below.error?.retryable, resume: typeof below.error?.resume,
    ids: atEpoch.ids, fromZero: (await pollEvents(send, { since: 0 })).events?.[0]?.id,
  })

  await ctl.reset()
  const garbled = await pollEvents(send, { position: 'not-a-position' })
  const unknownType = await pollEvents(send, { since: 0, types: ['nope.created'] })
  t('feed.a400SaysWhichToFix', {
    position: [garbled.error?.kind, garbled.error?.code], filter: [unknownType.error?.kind, unknownType.error?.code],
    again: (await drain({ since: 1000574 })).ids,
  })

  await ctl.reset()
  t('feed.refusesBadCursorsBeforeTheWire', {
    none: await rejects(pollEvents(send, {} as FeedFrom)),
    two: await rejects(pollEvents(send, { since: 0, position: 'x' } as unknown as FeedFrom)),
    aTime: await rejects(pollEvents(send, { since: '2026-10-16' as unknown as number })),
    negative: await rejects(pollEvents(send, { since: -1 })),
    noTypes: await rejects(pollEvents(send, { since: 0, types: [] })),
    commaType: await rejects(pollEvents(send, { since: 0, types: ['todo.created,card.created'] })),
    buckets: await rejects(pollEvents(send, { since: 0, buckets: Array.from({ length: 101 }, (_, i) => i + 1) })),
    requests: (await polls()).length,
  })

  // A Set stands in for caravan's jobs table: that a stated id queues once is
  // caravan's own `stated-id.test.ts`. This row is the connector's half, that
  // the id is the event's alone, so a replay names what is already queued.
  await ctl.reset()
  await ctl.arm({ feedPage: 5 })
  const queued = new Set<string>()
  const queueAll = async (from: FeedFrom) => {
    const before = queued.size
    let page = await pollEvents(send, from)
    for (let n = 0; !page.error && n < 10; n++) {
      for (const e of page.events!) queued.add(eventJobId(e))
      if (!page.next) break
      page = await pollEvents(send, { url: page.next })
    }
    return queued.size - before
  }
  t('feed.aReplayedPageQueuesNothingNew', { first: await queueAll({ since: 0 }), replayed: await queueAll({ since: 0 }), id: eventJobId({ id: 1000504 }) })

  const sinceHere = async () => { const n = (await requests()).length; return async () => (await requests()).slice(n).map(w => w.path) }
  await ctl.reset()
  const pointed = await createTodo(send, { bucket: 1000161, todolist: 1000427, content: 'Reread me' })
  const head = await pollEvents(send, { since: 'now' })
  await appendEvents([{ event_type: 'todo.created', kind: 'todo_created', bucket_id: 1000161, recording_id: pointed.row!.id }])
  const [createdEvent] = (await pollEvents(send, { position: head.position! })).events!
  await completeTodo(send, pointed.row!)
  let seenSince = await sinceHere()
  const now = await reread(send, createdEvent)
  t('reread.readsTheRecordingAsItIsNow', { id: now.row?.id === pointed.row!.id, completed: (now.row as unknown as { completed: boolean })?.completed, wire: (await seenSince()).map(w => w.replace(String(pointed.row!.id), '<id>')) })

  const chatLineAt = { bucket_id: 1000161, recording_id: 1000490 }
  seenSince = await sinceHere()
  const created = await reread(send, { ...chatLineAt, event_type: 'chat.line.created' })
  const boosted = await reread(send, { ...chatLineAt, event_type: 'boost.created' })
  t('reread.aLineOrABoostGoesThroughItsEnvelope', { types: [created.row?.type, boosted.row?.type], ids: [created.row?.id, boosted.row?.id], wire: await seenSince() })

  await fetch(`${sink.url}/_sink/hide`, { method: 'POST', body: JSON.stringify({ id: pointed.row!.id }) })
  seenSince = await sinceHere()
  const hidden = await reread(send, { event_type: 'todo.completed', bucket_id: 1000161, recording_id: pointed.row!.id })
  const unknown = await reread(send, { event_type: 'chat.line.created', bucket_id: 1000161, recording_id: 1 })
  t('reread.a404IsGoneAndAsksOnce', {
    hidden: [hidden.error?.kind, hidden.error?.retryable], never: [unknown.error?.kind, unknown.error?.retryable], rows: [hidden.row ?? null, unknown.row ?? null], requests: (await seenSince()).length,
  })

  seenSince = await sinceHere()
  t('reread.refusesABadEventBeforeTheWire', {
    noType: await rejects(reread(send, { bucket_id: 1000161, recording_id: 1000490 } as never)),
    aKind: await rejects(reread(send, { event_type: 'chat_lines_rich_text_created', bucket_id: 1000161, recording_id: 1000490 })),
    noBucket: await rejects(reread(send, { event_type: 'todo.created', recording_id: 1000490 } as never)),
    zeroId: await rejects(reread(send, { event_type: 'todo.created', bucket_id: 1000161, recording_id: 0 })),
    noJobId: throws(() => eventJobId({} as never)),
    requests: (await seenSince()).length,
  })

  await ctl.reset()
  await ctl.arm({ beatMs: 30, ticketLife: 1 })
  const until = async (ok: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise(r => setTimeout(r, 20)); return ok() }
  const sinkSeen = async () => (await fetch(`${sink.url}/_sink/seen`).then(r => r.json())) as { requests: Seen[]; cable: { ticket: string; frame: string }[]; open: number }
  const live = createConduit({ credentials, ...DRIVE_RESILIENCE })
  await live.register(targets.api); await live.register(targets.stream)
  const landedLive: StreamEvent[] = []
  const dialedAt = Date.now()
  await live.receive({ provider: '37signals', target: BASECAMP_STREAM_TARGET, dialect: basecampStreamDialect(bindBasecamp(live, targets)), apply(ev: StreamEvent) { landedLive.push(ev); return 'applied' as const } })
  const health = () => live.stats().subscriptions[BASECAMP_STREAM_TARGET]!
  await new Promise(r => setTimeout(r, 300))
  let cable = await sinkSeen()
  t('stream.oneSubscribeWithThePollsFilters', {
    connected: health().connected, frames: cable.cable.length, identifier: (() => { const id = JSON.parse(JSON.parse(cable.cable[0]!.frame).identifier); return [id.channel, id.types.split(',').length] })(),
    command: JSON.parse(cable.cable[0]!.frame).command, received: health().received, dropped: health().dropped,
  })

  const liveHead = await pollEvents(send, { since: 'now' })
  const queuedLive = new Set<string>()
  const [liveId] = (await (await fetch(`${sink.url}/_sink/events`, { method: 'POST', body: JSON.stringify({ duplicate: true, events: [{ event_type: 'todo.created', kind: 'todo_created', bucket_id: 1000161, recording_id: 1000427 }] }) })).json() as { ids: number[] }).ids
  await until(() => landedLive.length >= 1)
  await new Promise(r => setTimeout(r, 100))
  for (const ev of landedLive) queuedLive.add(eventJobId(ev.payload))
  const [quietId] = (await (await fetch(`${sink.url}/_sink/events`, { method: 'POST', body: JSON.stringify({ live: false, events: [{ event_type: 'message.created', kind: 'message_created', bucket_id: 1000161, recording_id: 1000469 }] }) })).json() as { ids: number[] }).ids
  await new Promise(r => setTimeout(r, 100))
  const polled = (await pollEvents(send, { position: liveHead.position! })).events!
  const repaired = polled.map(e => eventJobId(e)).filter(id => !queuedLive.has(id))
  t('stream.aFrameLandsOnceAsItsJob', {
    landed: landedLive.length, type: landedLive[0]?.type, job: eventJobId(landedLive[0]!.payload) === eventJobId({ id: liveId! }), actorType: landedLive[0]?.payload.actor_type,
    repaired: repaired.map(id => id === eventJobId({ id: quietId! }) ? '<quiet>' : id),
  })

  await new Promise(r => setTimeout(r, Math.max(0, dialedAt + 1200 - Date.now())))
  const firstTicket = (await sinkSeen()).cable[0]!.ticket
  await ctl.arm({ hangUp: true })
  await until(() => !health().connected, 1000)
  const reconnected = await until(() => health().connected)
  cable = await sinkSeen()
  const mints = cable.requests.filter(r => r.path === '/999/events/stream_ticket.json')
  const stale = await fetch(`${sink.url}/cable/999?ticket=${firstTicket}`)
  t('stream.aTicketPerDial', {
    reconnected, tickets: cable.cable.map(c => c.ticket), mints: mints.map(r => [r.method, r.status, r.authorization?.startsWith('Bearer '), r.userAgent === UA]), staleTicket: stale.status,
  })
  await live.destroy()

  const rejected = createConduit({ credentials, ...DRIVE_RESILIENCE })
  await rejected.register(targets.api); await rejected.register({ ...targets.stream, id: 'broker:37signals:rejected' })
  const rejectedLanded: StreamEvent[] = []
  const errors = console.error; console.error = () => {}
  try {
    await rejected.receive({ provider: '37signals', target: 'broker:37signals:rejected', dialect: basecampStreamDialect(bindBasecamp(rejected, targets), { types: ['todo.archived'] }), apply(ev: StreamEvent) { rejectedLanded.push(ev); return 'applied' as const } })
    await new Promise(r => setTimeout(r, 150))
    t('stream.aRejectedSubscriptionIsNotBelieved', { connected: rejected.stats().subscriptions['broker:37signals:rejected']!.connected, landed: rejectedLanded.length })
  } finally { console.error = errors; await rejected.destroy() }

  seenSince = await sinceHere()
  t('stream.refusesBadFiltersBeforeTheWire', {
    noTypes: throws(() => basecampStreamDialect(send, { types: [] })),
    commaType: throws(() => basecampStreamDialect(send, { types: ['todo.created,todo.completed'] })),
    buckets: throws(() => basecampStreamDialect(send, { buckets: Array.from({ length: 101 }, (_, i) => i + 1) })),
    personBound: throws(() => basecampStreamDialect(bindBasecamp(conduit, targets, { as: 'person' }))),
    requests: (await seenSince()).length,
  })

  const dir = new URL('./fixture/', import.meta.url)
  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  const text = files.map(f => readFileSync(new URL(f, dir), 'utf8')).join('\n')
  const emails = [...new Set(text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [])].filter(e => !/^person-\d+@example\.com$/.test(e))
  const accounts = [...new Set([...text.matchAll(/(?:basecampapi|basecamp)\.com\/(\d+)\//g)].map(m => m[1]))]
  t('fixtures.scrubbed', { files: files.length, parse: files.every(f => { try { JSON.parse(readFileSync(new URL(f, dir), 'utf8')); return true } catch { return false } }), strayEmails: emails, accounts })
} catch (e) {
  t('__threw', String((e as Error)?.stack ?? e))
} finally {
  sink.stop()
}

process.exit(report(got, {
  'targets.defaults': {
    api: 'https://3.basecampapi.com/999', apiId: BASECAMP_API_TARGET, apiAuth: 'bearer', ua: UA,
    token: 'https://app.basecamp.com', tokenAuth: 'none', tokenEncoding: 'form',
    stream: [BASECAMP_STREAM_TARGET, 'broker', '', 'none'],
    person: [BASECAMP_PERSON_TARGET, true, true, { type: 'bearer', ref: 'BASECAMP_PERSON_TOKEN', per_caller: true }],
  },
  'targets.refuseWithoutUaOrAccount': { noUa: 'TypeError', blankUa: 'TypeError', noAccount: 'TypeError', url: 'TypeError' },
  'send.accountAndUaOnTheWire':       { status: 200, id: 1000133, path: '/999/my/profile.json', ua: true, bearer: true, ratelimit: true },
  'control.noUserAgentIs400':         { status: 400, kind: 'refused', retryable: false, names: true },
  'translate.403EmptyIsForbidden':    { kind: 'forbidden', retryable: false, said: true, requests: 1 },
  'translate.404IsGone':              { kind: 'gone', message: 'Not Found', retryable: false },
  'translate.400NamesItsReason':      { kind: 'refused', code: 'invalid_position', retryable: false },
  'translate.507IsCapacity':          { kind: 'capacity', retryable: false },
  'reads.meThenUnchanged':            { id: 1000133, weak: true, unchanged: true, row: null },
  'walk.gearedStopsOnTheEmptyPage':   { rows: 47, pages: ['/999/projects.json', '/999/projects.json?page=2', '/999/projects.json?page=3', '/999/projects.json?page=4'], everyPageAuthored: true },
  'walk.everyPage304IsUnchanged':     { unchanged: true, rows: null, statuses: [304, 304, 304, 304], conditional: true },
  'walk.aChangedPageRestarts':        { unchanged: null, rows: 47, renamed: 'Renamed', statuses: [304, 304, 200, 200, 200, 200, 200] },
  'walk.aLinkCycleIsRefused':         { kind: 'invalid_response', requests: 2 },
  'walk.aForeignLinkIsNotFollowed':   { kind: 'invalid_request', requests: 1 },
  'walk.nextLink':                    { one: 'https://3.basecampapi.com/999/projects.json?page=2', many: 'https://a/3', none: null },
  'todolists.theEnabledTodoset':      { todosets: 2, firstByNameIsDisabled: false, lists: [1000427], disabledSetIs: 'gone' },
  'todolists.toolOffIsEmpty':         { rows: [], requests: 0 },
  'recording.typedOneRequest':        { completed: 'boolean', completionUrl: true, unchanged: true, requests: 2 },
  'recording.untypedFollowsTheEnvelope': { envelopeHasCompleted: false, completed: 'boolean', paths: ['/999/buckets/1000161/recordings/1000434.json', '/999/buckets/1000161/todos/1000434.json'] },
  'recording.aChatLineByItsEnvelope': { type: 'Chat::Lines::RichText', content: 'string' },
  'recording.everyTypedPath':         ['Todolist', 'Message', 'Comment'],
  'recording.hiddenIsGone':           { kind: 'gone', retryable: false },
  'recording.refusesBadInput':        { type: 'TypeError', bucket: 'TypeError', id: 'TypeError' },
  'create.todoOnTheWire': {
    path: '/999/buckets/1000161/todolists/1000427/todos.json',
    body: { content: 'Call Ana', description: '<b>before Friday</b>', assignee_ids: [1000133], due_on: '2026-10-20', notify: true },
    id: 'number', content: 'Call Ana',
    attempt: { type: 'Todo', bucket: 1000161, parent: 1000427, match: 'Call Ana', startedAt: 'string' },
  },
  'create.messageIsPublished':        { path: '/999/buckets/1000119/message_boards/1000273/messages.json', status: 'active', subject: 'Week 42' },
  'create.commentAndLine':            { comment: '/999/buckets/1000161/recordings/1000434/comments.json', stored: '<div>On it &amp; done</div>', line: '/999/buckets/1000161/chats/1000448/lines.json', lineBody: { content: 'Deploying', content_type: 'text/html' }, lineType: 'Chat::Lines::RichText' },
  'create.lostIsIndeterminateAndSentOnce': { kind: 'timeout', indeterminate: true, row: null, posts: 1 },
  'find.theLostCommentThroughItsDiv': { found: 1, stored: '<div><p>Did this <em>land</em>?</p></div>', mine: 1000133, pages: 2 },
  'find.nothingNeverSentOlderOrOthers': { never: [], olderAndOthersExcluded: true },
  'find.newestFirstStopsAtOnePage':   { indeterminate: true, found: ['<div>Deploy done</div>'], lineReads: 1 },
  'complete.followsCompletionUrl':    { ok: true, unbucketed: true, completed: true },
  'complete.aLostCompletionIsResent': { ok: true, completions: 2 },
  'rich.textIsEscaped':               { sent: 'a &lt;b&gt; &amp; &quot;c&quot;<br>d', stored: '<div>a &lt;b&gt; &amp; &quot;c&quot;<br>d</div>', match: 'a <b> & "c" d' },
  'find.aLostLineByItsWords':         { indeterminate: true, found: ['<div>if a &lt;b&gt; &amp;&amp; c &gt; d<br>ship</div>'] },
  'find.aPlainFieldIsNotParsed':      { match: 'Fix <div> & &amp;', found: ['Fix <div> & &amp;'] },
  'rich.refusesAmbiguousBodies':      { bareLine: 'TypeError', both: 'TypeError', emptyText: 'TypeError', description: 'TypeError' },
  'create.refusesBadInput':           { bareString: 'TypeError', emptyComment: 'TypeError', noName: 'TypeError', date: 'TypeError', parent: 'TypeError', noSubject: 'TypeError', completion: 'TypeError' },
  'rate.aReadWaitsOutRetryAfter':     { id: 1000133, statuses: [429, 200], waitedTheSecond: true, first: '/999/my/profile.json' },
  'rate.aCreateIsRefusedNotLost':     { kind: 'rate_limited', retryable: true, retryAfterMs: 1000, indeterminate: null, posts: 1, found: [] },
  'fail.aReadIsResent':               { id: 1000133, statuses: [500, 200] },
  'fail.aCreateIsIndeterminateAndFindSaysNotMade': { kind: 'server_error', indeterminate: true, posts: 1, found: [] },
  'inactive.everyPathOnceAndNoRetry': { kinds: ['inactive', 'inactive', 'inactive'], retryable: [false, false, false], indeterminate: null, requests: 3, afterReset: 1000133 },
  'hidden.goneAsIfItNeverWas':        { kind: 'gone', sameAnswer: true, status: 404, listed: ['In sight'] },
  'token.refreshOnTheWire': {
    id: 1000133, path: '/oauth/tokens', body: { grant_type: 'refresh_token', refresh_token: 'bc_refresh', client_id: 'fjs-drive' }, bearer: null, ua: true,
    spent: [['Bearer bc_minted_1', 200]],
  },
  'token.twoAcrossAnExpiryOneRefresh': { ids: [1000133, 47], refreshes: 2, spent: [['Bearer bc_minted_2', 200], ['Bearer bc_minted_2', 200], ['Bearer bc_minted_2', 200], ['Bearer bc_minted_2', 200], ['Bearer bc_minted_2', 200]] },
  'token.a401RemintsOnceForBoth':     { held: 1000133, ids: [1000133, 1000133], refreshes: 1, statuses: [200, 200, 401, 401] },
  'token.aRefusedRefreshIsAuthFailedOnce': { kind: 'auth_failed', retryable: false, lost: ['invalid_grant'], refreshes: 1, apiRequests: 1, after: 'auth_failed' },
  'token.aFailedRefreshKeepsTheGrant': { throttled: ['auth_failed', true, 1000], outage: ['auth_failed', false], grantKept: true, refreshes: [429, 500, 200], later: 1000133 },
  'token.aRotatedRefreshReachesTheApp': { id: 1000133, rotated: [['bc_refresh', 'bc_refresh_6'], ['bc_refresh_6', 'bc_refresh_7']], sent: ['bc_refresh', 'bc_refresh_6'] },
  'person.spendsTheCallersToken':     { ids: [1000200, 1000201, 1000200], refreshed: ['bc_refresh_ana', 'bc_refresh_ben'], bearers: [true, true] },
  'person.aVerbIsTheCallersOwn':      { creator: 1000201, foundByBen: 1, foundByAna: 0 },
  'person.aLostGrantIsTheCallersAlone': { ana: ['auth_failed', false], lost: [['invalid_grant'], []], ben: 1000201, refreshed: ['bc_refresh_ana', 'bc_refresh_ben'], anaAgain: 'auth_failed' },
  'person.noCallerOrNoStoreFailsClosed': { nobody: 'auth_failed', requests: 0, noGrantsFor: 'TypeError', noStore: 'TypeError' },
  'feed.entersAtThePresent':          { events: [], position: 'string', next: null, since: 'now', types: 16, excludes: false },
  'feed.replayFollowsNextToTheEnd':   { ids: [1000504, 1000511, 1000518, 1000525, 1000532, 1000539, 1000546, 1000553, 1000560, 1000567, 1000574, 1000581], pages: 3, followedWhole: true },
  'feed.resumesAfterItsPosition':     { ids: [1000588], added: 1000588, next: null, after: 0 },
  'feed.filtersRideTheQuery':         { ids: [1000532, 1000546, 1000574], types: 'todo.created,todo.completed', buckets: '1000147' },
  'feed.otherFiltersAreFiltersChanged': { kind: 'refused', code: 'filters_changed', retryable: false, events: null, lastApplied: 1000525, reentered: [1000546, 1000574] },
  'feed.belowTheEpochResumesAtIt':    { kind: 'refused', code: 'before_epoch', retryable: false, resume: 'string', ids: [1000567, 1000574, 1000581], fromZero: 1000567 },
  'feed.a400SaysWhichToFix':          { position: ['refused', 'invalid_position'], filter: ['refused', 'invalid_filter'], again: [1000581] },
  'feed.refusesBadCursorsBeforeTheWire': { none: 'TypeError', two: 'TypeError', aTime: 'TypeError', negative: 'TypeError', noTypes: 'TypeError', commaType: 'TypeError', buckets: 'TypeError', requests: 0 },
  'feed.aReplayedPageQueuesNothingNew': { first: 12, replayed: 0, id: '37signals:event:1000504' },
  'reread.readsTheRecordingAsItIsNow': { id: true, completed: true, wire: ['/999/buckets/1000161/todos/<id>.json'] },
  'reread.aLineOrABoostGoesThroughItsEnvelope': {
    types: ['Chat::Lines::RichText', 'Chat::Lines::RichText'], ids: [1000490, 1000490],
    wire: ['/999/buckets/1000161/recordings/1000490.json', '/999/buckets/1000161/chats/1000448/lines/1000490.json', '/999/buckets/1000161/recordings/1000490.json', '/999/buckets/1000161/chats/1000448/lines/1000490.json'],
  },
  'reread.a404IsGoneAndAsksOnce': { hidden: ['gone', false], never: ['gone', false], rows: [null, null], requests: 2 },
  'reread.refusesABadEventBeforeTheWire': { noType: 'TypeError', aKind: 'TypeError', noBucket: 'TypeError', zeroId: 'TypeError', noJobId: 'TypeError', requests: 0 },
  'stream.oneSubscribeWithThePollsFilters': { connected: true, frames: 1, identifier: ['EventsChannel', 16], command: 'subscribe', received: 0, dropped: 0 },
  'stream.aFrameLandsOnceAsItsJob':   { landed: 1, type: 'event', job: true, actorType: 'person', repaired: ['<quiet>'] },
  'stream.aTicketPerDial':            { reconnected: true, tickets: ['tkt_1', 'tkt_2'], mints: [['POST', 201, true, true], ['POST', 201, true, true]], staleTicket: 401 },
  'stream.aRejectedSubscriptionIsNotBelieved': { connected: false, landed: 0 },
  'stream.refusesBadFiltersBeforeTheWire': { noTypes: 'TypeError', commaType: 'TypeError', buckets: 'TypeError', personBound: 'TypeError', requests: 0 },
  'fixtures.scrubbed':                { files: 17, parse: true, strayEmails: [], accounts: ['999'] },
}))
