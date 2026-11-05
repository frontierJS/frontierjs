// test/gmail.drive.ts — the connector through a real conduit against the sink.
//
// Run: `bun run drive`. Starts its own sink and its own push receiver on
// ephemeral ports; no fixture, because no conforming Gmail exists to run.
//
// The negative control is the sink's MIME parser: a message built by hand
// with a raw accented Subject — what `buildMime` would produce with the
// RFC 2047 encoder removed — must be REFUSED by the sink naming the header,
// or the row that says the subject went as an encoded word is about nothing.
//
// Two rows are findings rather than features: the per-user unit limit spelled
// as a 403 is `auth_failed` to conduit and never retried, so the connector
// hands the wait to the caller; and a 401 is replayed once only when the
// resolver has `invalidate`, which the static resolver lacks, so this drive
// brings its own.

import { createConduit, withCache, type CredentialResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startGmailSink, type SeenRequest, type SeenPush } from '../sink.ts'
import {
  gmailTarget, bindSend, getProfile, getThread, getMessage, listHistory, walkHistory, listThreadIds, watch, sendMessage, findByMessageId,
  modifyMessage, trashMessage, untrashMessage, getAttachment, listLabels,
  buildMime, mintMessageId, replyHeaders, messageIdOf, parseMessage, headerOf, addressesOf, advanceHistoryId, backfillQuery, decodePushEnvelope, pushVerifier,
  type ParsedMessage,
} from '../src/index.ts'

const { got, t } = results()
const TOKEN = 'ya29.agency', MAILBOX = 'agency@kobami.test'
const day = 86_400_000, ago = (d: number) => Date.now() - d * day
const b64 = (s: string) => Buffer.from(s).toString('base64')

// ── the receiving end: the push's bearer verified against the sink's certs, the publisher pinned ──
const receiver = {
  applied: new Set<string>(), answered: [] as number[], deliveries: 0,
  last: null as null | { ok: boolean; refetched?: true; reason?: string },
  reset() { this.applied.clear(); this.answered.length = 0; this.deliveries = 0; this.last = null },
}
let certsUrl = ''
const certs: CredentialResolver = { async get() { return fetch(certsUrl).then(r => r.text()) } }
const keys = pushVerifier(withCache(certs, { ttl_ms: 60_000 }), 'certs')
const hook = Bun.serve({
  port: 0,
  async fetch(req) {
    const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const v = await keys.verify(jwt, { audience: HOOK_URL, publisher: sink.state.publisher, now: Math.floor(Date.now() / 1000) })
    receiver.last = v.ok ? { ok: true, ...(v.refetched ? { refetched: true as const } : {}) } : { ok: false, reason: v.reason, ...(v.refetched ? { refetched: true as const } : {}) }
    const answer = (status: number) => { receiver.answered.push(status); return new Response(null, { status }) }
    if (!v.ok) return answer(401)
    receiver.deliveries++
    const n = decodePushEnvelope(await req.json().catch(() => null))
    // Garbage is acked: a redelivery cannot fix bad JSON. The id is the dedupe.
    if (n && !receiver.applied.has(n.messageId)) receiver.applied.add(n.messageId)
    return answer(200)
  },
})
const HOOK_URL = `http://127.0.0.1:${hook.port}/push/gmail`

// ── the sink, seeded: one thread begun three weeks ago with a reply yesterday, one fresh ──
const sink = startGmailSink({ hookUrl: HOOK_URL, mailboxes: [{ token: TOKEN, emailAddress: MAILBOX, messages: [
  { from: 'Dana <dana@cleanaffinity.test>', to: MAILBOX, subject: 'Quote for spring clean', text: 'Can you quote a spring clean?', html: '<p>Can you quote a <b>spring clean</b>?</p>', date: ago(20), messageId: '<a1@cleanaffinity.test>' },
  { from: MAILBOX, to: 'dana@cleanaffinity.test', subject: 'Re: Quote for spring clean', text: 'Sure, see below.', date: ago(19), messageId: '<a2@kobami.test>', inReplyTo: '<a1@cleanaffinity.test>' },
  { from: 'Dana <dana@cleanaffinity.test>', to: MAILBOX, subject: 'Re: Quote for spring clean', text: 'Estimate attached.', html: '<p>Estimate attached.</p>', date: ago(1), messageId: '<a3@cleanaffinity.test>', inReplyTo: '<a2@kobami.test>', attachments: [{ filename: 'estimate.pdf', mimeType: 'application/pdf', bytes: '%PDF-1.4 estimate' }] },
  { from: 'lee@rosecitywindows.test', to: MAILBOX, subject: 'Window schedule', text: 'When can you come by?', date: ago(2), messageId: '<b1@rosecitywindows.test>' },
] }] })
certsUrl = `${sink.url}/oauth2/v3/certs`
const ctl = control(sink.url)

// A resolver with `invalidate`, so a 401 is forgotten and replayed once; the count is the drive's evidence that a 403 kept it.
let invalidations = 0
const grant: CredentialResolver = { async get(ref) { return ref === 'GOOGLE_GRANT' ? TOKEN : null }, invalidate() { invalidations++ } }
const conduit = createConduit({ credentials: grant, ...DRIVE_RESILIENCE })
await conduit.register(gmailTarget({ address: sink.url }))
const send = bindSend(conduit)

type Seen = { requests: SeenRequest[]; pushes: SeenPush[]; units: Record<string, number>; mailboxes: { emailAddress: string; watch: unknown; historyId: string }[] }
const seen     = () => ctl.seen<never>() as unknown as Promise<Seen>
const attempts = async () => (await seen()).requests.length
const mail     = (body: Record<string, unknown>) => fetch(`${sink.url}/_sink/mail`, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()) as Promise<{ id: string; threadId: string; historyId: string; pushes: SeenPush[] }>
const push     = (body: Record<string, unknown>) => fetch(`${sink.url}/_sink/push`, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()) as Promise<{ pushes: SeenPush[] }>
const byDate   = (a: ParsedMessage, b: ParsedMessage) => a.sentAt - b.sentAt

try {
  // ── profile and backfill ─────────────────────────────────────────────────
  const profile = await getProfile(send)
  t('profile.answersMailbox', { email: profile.profile?.emailAddress, hasHistoryId: /^\d+$/.test(profile.profile?.historyId ?? '') })
  const H0 = profile.profile!.historyId

  await ctl.reset()
  const ids = await listThreadIds(send, backfillQuery(7))
  const listed = (await seen()).requests.filter(r => r.path.endsWith('/messages')).length
  const threads: ParsedMessage[][] = []
  for (const id of ids.threadIds ?? []) { const th = await getThread(send, id); threads.push(th.thread!.messages!.map(parseMessage).sort(byDate)) }
  const quote = threads.find(th => th[0].subject === 'Quote for spring clean')!
  const windows = threads.find(th => th[0].subject === 'Window schedule')!
  t('backfill.distinctThreadsOldestFirst', { threads: threads.length, messages: threads.flat().length, listCalls: listed, firstIsRoot: headerOf(quote[0].headers, 'in-reply-to') === undefined && quote[0].externalId !== quote[2].externalId })
  t('backfill.unitsAreRecorded', { units: (await seen()).units[TOKEN] })

  // ── parsing, pure over what came back ────────────────────────────────────
  t('parse.htmlPreferredTextFallback', { kinds: [quote[0].bodyKind, windows[0].bodyKind], htmlBody: quote[0].body.includes('<b>'), textBody: windows[0].body })
  const withFile = quote[2]
  t('parse.attachmentsAreMetadata', { named: withFile.attachments[0]?.filename, hasId: !!withFile.attachments[0]?.attachmentId, noBytes: !JSON.stringify(withFile.attachments).includes('"data"'), bodyStillRead: withFile.bodyKind })
  t('parse.headersKeepCaseAndLookupLower', { spelled: Object.keys(quote[0].headers).find(k => k.toLowerCase() === 'message-id'), lookup: headerOf(quote[0].headers, 'message-id') })
  t('parse.internalDateWinsAndAddressesLower', { oldestFirst: quote[0].sentAt < quote[1].sentAt && quote[1].sentAt < quote[2].sentAt, addresses: addressesOf('Dana <Dana@CleanAffinity.test>, lee@x.test, nobody') })

  // ── history ──────────────────────────────────────────────────────────────
  await mail({ from: 'pat@mobilegroomers.test', to: MAILBOX, subject: 'Grooming van', text: 'Do you do vans?' })
  await mail({ from: 'lee@rosecitywindows.test', to: MAILBOX, subject: 'Re: Window schedule', text: 'Any day works.', inReplyTo: '<b1@rosecitywindows.test>' })
  const walked = await walkHistory(send, H0)
  t('history.walksFromWatermark', { threadIds: walked.walked?.threadIds.length, includesReplyThread: walked.walked?.threadIds.includes(windows[0].threadId), advanced: BigInt(walked.walked?.historyId ?? 0) > BigInt(H0) })
  await ctl.arm({ staleHistory: true })
  const gap = await listHistory(send, { startHistoryId: H0 })
  t('history.staleWatermarkIsGap', { kind: gap.error?.kind, retryable: gap.error?.retryable, reason: gap.error?.reason })
  t('history.advanceIsForwardOnly', { back: advanceHistoryId('10', '9'), forward: advanceHistoryId('10', '11'), bigintSafe: advanceHistoryId('9007199254740993', '9007199254740992'), missing: advanceHistoryId(null, '5') })

  // ── watch ────────────────────────────────────────────────────────────────
  await ctl.reset()
  const w = await watch(send, { topicName: 'projects/sink/topics/gmail' })
  t('watch.answersSevenDays', { hasHistoryId: /^\d+$/.test(w.watch?.historyId ?? ''), expiresInDays: Math.round((Number(w.watch?.expiration) - Date.now()) / day) })
  await ctl.reset()
  await watch(send, { topicName: 'projects/sink/topics/gmail' })
  const order = (await seen()).requests.map(r => r.path.split('/').pop())
  t('watch.rewatchReplaces', { stopsFirst: order[0] === 'stop' && order[1] === 'watch', calls: order.length, watches: (await seen()).mailboxes.filter(m => m.watch).length })
  let threw = ''
  try { await watch(send, { topicName: '' }) } catch (e) { threw = (e as Error).message }
  t('watch.noTopicRefusedBeforeSend', { threw: /topicName/.test(threw) })

  // ── the push ─────────────────────────────────────────────────────────────
  const env = (data: unknown, messageId = '42') => ({ message: { data: b64(JSON.stringify(data)), messageId, publishTime: '1970-01-01T00:00:00Z' }, subscription: 'projects/x/subscriptions/y' })
  const asString = decodePushEnvelope(env({ emailAddress: MAILBOX, historyId: '9876543210' }))
  const asNumber = decodePushEnvelope(env({ emailAddress: MAILBOX, historyId: 9876543210 }))
  t('push.envelopeDecodes', { email: asString?.emailAddress, historyId: asString?.historyId, isString: typeof asString?.historyId, messageId: asString?.messageId, fromNumber: asNumber?.historyId })
  t('push.malformedIsNull', [decodePushEnvelope({ message: { data: b64('nope'), messageId: '1' } }), decodePushEnvelope({}), decodePushEnvelope(env({ historyId: '1' })), decodePushEnvelope(null)].every(x => x === null))

  receiver.reset()
  await ctl.arm({ deliverTwice: true })
  const twice = await mail({ from: 'dana@cleanaffinity.test', to: MAILBOX, subject: 'Re: Quote for spring clean', text: 'One more thing.', inReplyTo: '<a2@kobami.test>' })
  t('push.deliveredTwiceAppliedOnce', { deliveries: twice.pushes.length, answered: twice.pushes.map(p => p.status), applied: receiver.applied.size, sameMessageId: new Set(twice.pushes.map(p => p.messageId)).size })

  receiver.reset()
  await push({ forged: true })
  t('push.forgedBearerRefused', receiver.last?.ok)
  receiver.reset()
  await push({ rogue: true })
  t('push.rogueKidRefusedAfterOneRefetch', { ok: receiver.last?.ok, refetched: receiver.last?.refetched === true })
  receiver.reset()
  await push({ email: 'someone-else@attacker.iam.gserviceaccount.com' })
  const wrongPublisher = receiver.last
  await push({ exp: Math.floor(Date.now() / 1000) - 7200 })
  t('push.wrongPublisherAndStaleTokenRefused', { publisher: wrongPublisher?.ok, namesPublisher: /publisher/.test(wrongPublisher?.reason ?? ''), expired: receiver.last?.ok, saysExpired: /expired/.test(receiver.last?.reason ?? ''), applied: receiver.applied.size })
  receiver.reset()
  await fetch(`${sink.url}/_sink/rotate`)
  await push({ numeric: true })
  t('push.rotatedKeyVerifiesAfterRefetch', { ok: receiver.last?.ok, refetched: receiver.last?.refetched === true, applied: receiver.applied.size })

  // ── send ─────────────────────────────────────────────────────────────────
  const H1 = (await getProfile(send)).profile!.historyId
  const parent = quote[2]
  const reply = replyHeaders(parent)
  const replyMime = buildMime({ from: MAILBOX, fromName: 'Kobami', to: parent.from!, subject: 'Re: Quote for spring clean', text: 'Thanks, Dana.', html: '<p>Thanks, Dana.</p>', messageId: mintMessageId('kobami.test'), ...reply })
  await ctl.reset()
  const sentReply = await sendMessage(send, { mime: replyMime, threadId: parent.threadId })
  const onWire = (await seen()).requests[0].sent!
  t('send.threadsAsReply', { inReplyTo: onWire.headers['In-Reply-To'], references: onWire.headers['References'], threadIdOnWire: onWire.threadId === parent.threadId, sameThread: sentReply.sent?.threadId === parent.threadId, forked: onWire.forked })

  await ctl.reset()
  const accent = await sendMessage(send, { mime: buildMime({ from: MAILBOX, to: 'dana@cleanaffinity.test', subject: 'Café — été', text: 'Bonjour', messageId: mintMessageId('kobami.test') }) })
  const accentWire = (await seen()).requests[0].sent!
  t('send.subjectWithAccentIsEncodedWord', { ok: !accent.error, onWire: /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(accentWire.rawHeaders.find(l => l.startsWith('Subject:')) ?? ''), decoded: accentWire.headers.Subject })

  // NEGATIVE CONTROL: the same message with the encoder removed.
  await ctl.reset()
  const bare = buildMime({ from: MAILBOX, to: 'dana@cleanaffinity.test', subject: 'Cafe', text: 'Bonjour', messageId: mintMessageId('kobami.test') }).replace('Subject: Cafe', 'Subject: Café')
  const refused = await sendMessage(send, { mime: bare })
  t('send.rawUtf8HeaderRefusedBySink', { kind: refused.error?.kind, namesHeader: /header 'Subject'/.test(refused.error?.message ?? ''), attempts: await attempts() })

  await ctl.reset()
  threw = ''
  try { buildMime({ from: MAILBOX, to: 'dana@cleanaffinity.test\r\nBcc: evil@attacker.test', subject: 'Hi', text: 'x', messageId: mintMessageId('kobami.test') }) } catch (e) { threw = (e as Error).message }
  t('send.headerInjectionRefusedBeforeSend', { threw: /header 'To'/.test(threw), attempts: await attempts() })

  let fork = '', noThread = ''
  try { buildMime({ from: MAILBOX, to: parent.from!, subject: 'Invoice', text: 'x', messageId: mintMessageId('kobami.test'), ...reply }) } catch (e) { fork = (e as Error).message }
  try { await sendMessage(send, { mime: replyMime }) } catch (e) { noThread = (e as Error).message }
  t('send.forkAndThreadlessReplyRefusedBeforeSend', { subjectFork: /forks the thread/.test(fork), noThreadId: /threadId/.test(noThread), attempts: await attempts() })

  await ctl.reset()
  await ctl.arm({ failNext: true })
  const failedMime = buildMime({ from: MAILBOX, to: 'lee@rosecitywindows.test', subject: 'Schedule', text: 'Tuesday?', messageId: mintMessageId('kobami.test') })
  const failed = await sendMessage(send, { mime: failedMime })
  t('send.messageIdMintedBeforeSend', { returnedOnFailure: failed.messageId === messageIdOf(failedMime), failed: !!failed.error, kind: failed.error?.kind, attempts: await attempts() })

  await ctl.reset()
  await ctl.arm({ rateLimit: { status: 429, limit: 'sending' } })
  const limited = await sendMessage(send, { mime: failedMime })
  t('send.rateLimitedComesBackWithWait', { attempts: await attempts(), kind: limited.error?.kind, retryAfterMs: limited.error?.retryAfterMs, limit: limited.error?.limit, retryable: limited.error?.retryable })

  await ctl.reset()
  await ctl.arm({ lost: true })
  const lostMime = buildMime({ from: MAILBOX, to: parent.from!, subject: 'Re: Quote for spring clean', text: 'Did this land?', messageId: mintMessageId('kobami.test'), ...reply })
  const lost = await sendMessage(send, { mime: lostMime, threadId: parent.threadId })
  t('send.lostResponseIsIndeterminate', { kind: lost.error?.kind, indeterminate: lost.error?.indeterminate === true, retryable: lost.error?.retryable, attempts: await attempts() })
  await ctl.reset()
  const found = await findByMessageId(send, lost.messageId)
  t('send.lostResponseResolvedByMessageId', { found: !!found.found, sameThread: found.found?.threadId === parent.threadId, queryOnWire: decodeURIComponent((await seen()).requests[0].query).includes(`rfc822msgid:${lost.messageId.replace(/^<|>$/g, '')}`) })

  const after = await walkHistory(send, H1)
  const copy = await getMessage(send, sentReply.sent!.id, { format: 'metadata', metadataHeaders: ['Message-ID'] })
  t('send.sentCopyAppearsInHistory', { inHistory: after.walked?.threadIds.includes(parent.threadId), hasSent: copy.message?.labelIds?.includes('SENT'), messageIdKept: headerOf(Object.fromEntries((copy.message?.payload?.headers ?? []).map(h => [h.name, h.value])), 'message-id') === sentReply.messageId })

  // ── labels ───────────────────────────────────────────────────────────────
  const read = await modifyMessage(send, withFile.externalId, { remove: ['UNREAD'] })
  const unread = await modifyMessage(send, withFile.externalId, { add: ['UNREAD'] })
  t('modify.readIsLabelToggle', { unreadRemoved: !read.message?.labelIds?.includes('UNREAD'), unreadAdded: !!unread.message?.labelIds?.includes('UNREAD') })
  const trashed = await trashMessage(send, withFile.externalId)
  const still = await getMessage(send, withFile.externalId, { format: 'minimal' })
  const restored = await untrashMessage(send, withFile.externalId)
  t('trash.isSoftAndReversible', { trashed: !!trashed.message?.labelIds?.includes('TRASH'), stillReadable: !!still.message, restored: !restored.message?.labelIds?.includes('TRASH') })
  const labels = await listLabels(send)
  t('labels.listsSystemLabels', { hasInbox: !!labels.labels?.labels?.some(l => l.id === 'INBOX'), hasSent: !!labels.labels?.labels?.some(l => l.id === 'SENT') })
  const att = await getAttachment(send, withFile.externalId, withFile.attachments[0].attachmentId)
  t('attachment.fetchedByIdOnly', { size: att.attachment?.size, bytes: Buffer.from(att.attachment?.data ?? '', 'base64url').toString() })

  // ── the four 403s, and the rest of the error table ───────────────────────
  await ctl.reset()
  const kept = invalidations
  await ctl.arm({ forbidScope: true })
  const scope = await getProfile(send)
  t('scope.insufficientIsForbiddenNotAuthFailed', { kind: scope.error?.kind, scopeMissing: scope.error?.scopeMissing, reason: scope.error?.reason, credentialKept: invalidations === kept, attempts: await attempts() })
  await ctl.arm({ quota: true })
  const quota = await getProfile(send)
  t('quota.dailyIsQuotaNotRateLimit', { kind: quota.error?.kind, retryable: quota.error?.retryable, credentialKept: invalidations === kept })
  await ctl.reset()
  await ctl.arm({ rateLimit: { status: 429 } })
  const paced = await getProfile(send)
  t('rateLimit.getIsRetriedByConduit', { ok: !paced.error, attempts: await attempts() })
  await ctl.reset()
  await ctl.arm({ rateLimit: { status: 403 } })
  const units = await getProfile(send)
  t('rateLimit.unitsAs403IsNotRetriedByConduit', { kind: units.error?.kind, limit: units.error?.limit, retryAfterMs: units.error?.retryAfterMs, attempts: await attempts(), credentialKept: invalidations === kept })
  await ctl.reset()
  await ctl.arm({ failNext: true })
  const flaky = await getProfile(send)
  t('backendError.getIsRetriedByConduit', { ok: !flaky.error, attempts: await attempts() })
  await ctl.arm({ signIn: true })
  const html = await getProfile(send)
  t('html200.isInvalidResponse', { kind: html.error?.kind, retryable: html.error?.retryable })
  await ctl.reset()
  await ctl.arm({ revoke: true })
  const revoked = await getProfile(send)
  t('revoked.isAuthFailedOnce', { kind: revoked.error?.kind, attempts: await attempts(), invalidated: invalidations - kept })
  await ctl.reset()
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack)
  got.__threw = String((e as Error).message)
} finally {
  sink.stop(); hook.stop(true); await conduit.destroy()
}

process.exit(report(got, {
  'profile.answersMailbox':                      { email: MAILBOX, hasHistoryId: true },
  'backfill.distinctThreadsOldestFirst':         { threads: 2, messages: 4, listCalls: 1, firstIsRoot: true },
  'backfill.unitsAreRecorded':                   { units: 85 },
  'parse.htmlPreferredTextFallback':             { kinds: ['html', 'text'], htmlBody: true, textBody: 'When can you come by?' },
  'parse.attachmentsAreMetadata':                { named: 'estimate.pdf', hasId: true, noBytes: true, bodyStillRead: 'html' },
  'parse.headersKeepCaseAndLookupLower':         { spelled: 'Message-Id', lookup: '<a1@cleanaffinity.test>' },
  'parse.internalDateWinsAndAddressesLower':     { oldestFirst: true, addresses: ['dana@cleanaffinity.test', 'lee@x.test'] },
  'history.walksFromWatermark':                  { threadIds: 2, includesReplyThread: true, advanced: true },
  'history.staleWatermarkIsGap':                 { kind: 'history_gap', retryable: false, reason: 'notFound' },
  'history.advanceIsForwardOnly':                { back: '10', forward: '11', bigintSafe: '9007199254740993', missing: '5' },
  'watch.answersSevenDays':                      { hasHistoryId: true, expiresInDays: 7 },
  'watch.rewatchReplaces':                       { stopsFirst: true, calls: 2, watches: 1 },
  'watch.noTopicRefusedBeforeSend':              { threw: true },
  'push.envelopeDecodes':                        { email: MAILBOX, historyId: '9876543210', isString: 'string', messageId: '42', fromNumber: '9876543210' },
  'push.malformedIsNull':                        true,
  'push.deliveredTwiceAppliedOnce':              { deliveries: 2, answered: [200, 200], applied: 1, sameMessageId: 1 },
  'push.forgedBearerRefused':                    false,
  'push.rogueKidRefusedAfterOneRefetch':         { ok: false, refetched: true },
  'push.wrongPublisherAndStaleTokenRefused':     { publisher: false, namesPublisher: true, expired: false, saysExpired: true, applied: 0 },
  'push.rotatedKeyVerifiesAfterRefetch':         { ok: true, refetched: true, applied: 1 },
  'send.threadsAsReply':                         { inReplyTo: '<a3@cleanaffinity.test>', references: '<a1@cleanaffinity.test> <a2@kobami.test> <a3@cleanaffinity.test>', threadIdOnWire: true, sameThread: true, forked: false },
  'send.subjectWithAccentIsEncodedWord':         { ok: true, onWire: true, decoded: 'Café — été' },
  'send.rawUtf8HeaderRefusedBySink':             { kind: 'refused', namesHeader: true, attempts: 1 },
  'send.headerInjectionRefusedBeforeSend':       { threw: true, attempts: 0 },
  'send.forkAndThreadlessReplyRefusedBeforeSend': { subjectFork: true, noThreadId: true, attempts: 0 },
  'send.messageIdMintedBeforeSend':              { returnedOnFailure: true, failed: true, kind: 'server_error', attempts: 1 },
  'send.rateLimitedComesBackWithWait':           { attempts: 1, kind: 'rate_limited', retryAfterMs: 1000, limit: 'sending', retryable: true },
  'send.lostResponseIsIndeterminate':            { kind: 'timeout', indeterminate: true, retryable: false, attempts: 1 },
  'send.lostResponseResolvedByMessageId':        { found: true, sameThread: true, queryOnWire: true },
  'send.sentCopyAppearsInHistory':               { inHistory: true, hasSent: true, messageIdKept: true },
  'modify.readIsLabelToggle':                    { unreadRemoved: true, unreadAdded: true },
  'trash.isSoftAndReversible':                   { trashed: true, stillReadable: true, restored: true },
  'labels.listsSystemLabels':                    { hasInbox: true, hasSent: true },
  'attachment.fetchedByIdOnly':                  { size: 17, bytes: '%PDF-1.4 estimate' },
  'scope.insufficientIsForbiddenNotAuthFailed':  { kind: 'forbidden', scopeMissing: true, reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', credentialKept: true, attempts: 1 },
  'quota.dailyIsQuotaNotRateLimit':              { kind: 'quota', retryable: false, credentialKept: true },
  'rateLimit.getIsRetriedByConduit':             { ok: true, attempts: 2 },
  'rateLimit.unitsAs403IsNotRetriedByConduit':   { kind: 'rate_limited', limit: 'units', retryAfterMs: 1000, attempts: 1, credentialKept: true },
  'backendError.getIsRetriedByConduit':          { ok: true, attempts: 2 },
  'html200.isInvalidResponse':                   { kind: 'invalid_response', retryable: false },
  'revoked.isAuthFailedOnce':                    { kind: 'auth_failed', attempts: 2, invalidated: 1 },
}))
