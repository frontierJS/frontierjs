// test/microsoft.drive.ts — the connector through a real conduit against the sink.
//
// Run: `bun run drive`. Starts its own sink and its own notification receiver
// on ephemeral ports; no fixture, because no conforming Graph exists to run.
//
// The negative control is the sink's handshake: a subscription whose
// notification URL does NOT echo the validationToken must be refused by the
// sink, or the row saying the create succeeded because `handshake` answered
// is about nothing.
//
// The lock rows are the point of the package: two resolvers over one store —
// two processes — expire the token and race, and the identity platform is
// asked ONCE, because a refresh token Microsoft rotated is dead for the
// process that lost.

import { createConduit, type CredentialCaller, type CredentialResolver, type Delivery } from '@frontierjs/conduit'
import { results, report, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startMicrosoftSink, CLIENT_ID, CLIENT_SECRET, MAILBOX } from '../sink.ts'
import {
  microsoftTargets, bindMicrosoft, me, listFolders, folder, createFolder, deltaStart, deltaNext, walkDelta, conversation, message, attachmentBytes,
  createDraft, createReply, patchMessage, sendDraft, moveMessage, findByInternetMessageId, sendMime, authorizeUrl, exchangeCode, linkToRequest,
  microsoftTokenResolver, memoryGrantStore, createSubscription, ensureSubscription, type SubscriptionStore,
  graphChangeDialect, graphLifecycleDialect, subscriptionIdOf, resourceIdOf, handshake, translate, addressesOf, headerOf,
  type GraphChangeEvent, type GraphLifecycleEvent, type Subscription,
} from '../src/index.ts'

const { got, t } = results()
const creds = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }
const WHO: CredentialCaller = { tenant: 'agency', principal: 'u1', grant: '1' }

// ── the sink and the targets ─────────────────────────────────────────────
const sink = startMicrosoftSink({ mailboxes: [MAILBOX], accessTokenTtl: 3600 })
const box  = sink.mailbox(MAILBOX)
const targets = microsoftTargets({ grantRef: 'MS_GRANT', graphUrl: sink.graphUrl, loginUrl: sink.url, tenant: 'organizations' })

// ── two "processes": two resolvers over one grant store ──────────────────
const store = memoryGrantStore()
const late: { conduit?: ReturnType<typeof createConduit> } = {}
// The resolver mints through the bundle before conduit exists, so the bundle sends through `late`.
const ms = bindMicrosoft({ send: r => late.conduit!.send(r) }, targets, { who: WHO })
const resolverA = microsoftTokenResolver(ms, creds, store, { self: 'A', pollMs: 5, waitMs: 2_000 })
const resolverB = microsoftTokenResolver(ms, creds, store, { self: 'B', pollMs: 5, waitMs: 2_000 })
let active = resolverA
const credentials: CredentialResolver = {
  get: r => active.get(r),
  getFor: (r, w) => active.getFor(r, w),
  invalidateFor: (r, v, w) => active.invalidateFor(r, v, w),
}
const conduit = createConduit({ credentials, ...DRIVE_RESILIENCE })
late.conduit = conduit
for (const d of Object.values(targets)) await conduit.register(d)

const calls = () => sink.received.length
const statuses = (re: RegExp) => sink.received.filter(r => re.test(r.path)).map(r => r.status)

// ── the notification receiver: handshake first, then the dialect by hand (no junction here) ──
const subs = new Map<string, string>()
const receiver = { applied: [] as GraphChangeEvent[], lifecycle: [] as GraphLifecycleEvent[], refused: [] as string[], keys: [] as string[], reset() { this.applied.length = 0; this.lifecycle.length = 0; this.refused.length = 0; this.keys.length = 0 } }
const hook = Bun.serve({
  port: 0,
  async fetch(req) {
    const hs = handshake(req.url)
    if (hs) return hs
    const rawBody = await req.text()
    const url = new URL(req.url)
    const d: Delivery = { method: req.method, path: url.pathname, query: url.search.slice(1), route: {}, headers: Object.fromEntries(req.headers), rawBody, body: JSON.parse(rawBody) }
    const id = subscriptionIdOf(d)
    const cred = id ? subs.get(id) ?? '' : ''
    const dialect = url.pathname.endsWith('/lifecycle') ? graphLifecycleDialect : graphChangeDialect
    const v = dialect.verify(d, cred, { now: Date.now() / 1000, seenNonce: () => false })
    if (!v.ok) { receiver.refused.push(v.reason); return new Response(null, { status: 401 }) }
    const ev = dialect.parse(d, cred)
    if (ev) {
      receiver.keys.push(dialect.dedupeKey(d, ev as never, cred))
      if (ev.type === 'change') receiver.applied.push(ev as GraphChangeEvent)
      else receiver.lifecycle.push(ev as GraphLifecycleEvent)
    }
    return new Response(null, { status: 202 })
  },
})
const HOOK = `http://127.0.0.1:${hook.port}/receive/microsoft`
const dumb = Bun.serve({ port: 0, fetch: () => new Response('nope', { status: 200 }) })

// ── sign in through the real redirect, as the browser would ──────────────
async function signIn(): Promise<string> {
  const url = authorizeUrl({ clientId: CLIENT_ID, redirectUri: 'http://app.test/connect/microsoft/callback', state: 's1', loginUrl: sink.url })
  const res = await fetch(url, { redirect: 'manual' })
  const back = new URL(res.headers.get('location')!)
  const code = back.searchParams.get('code')!
  const x = await exchangeCode(ms, creds, { code, redirectUri: 'http://app.test/connect/microsoft/callback' })
  if (x.error) throw new Error(`exchange: ${x.error.kind} ${x.error.message}`)
  return x.tokens!.refresh_token!
}

try {
  // ── targets ─────────────────────────────────────────────────────────────
  t('targets.threeOneCredentialEach', {
    ids: Object.values(targets).map(d => d.id),
    auth: Object.values(targets).map(d => d.auth.type + ('per_caller' in d.auth && d.auth.per_caller ? ':per_caller' : '')),
    encodings: Object.values(targets).map(d => d.encoding ?? 'json'),
    retries: Object.values(targets).map(d => d.resilience?.retry_limit),
    preferImmutable: [targets.graph, targets.mime].every(d => d.headers?.prefer === 'IdType="ImmutableId"'),
  })

  // ── login ───────────────────────────────────────────────────────────────
  const auth = new URL(authorizeUrl({ clientId: 'c', redirectUri: 'http://a/cb', state: 'xyz', prompt: 'select_account' }))
  t('login.authorizeUrlIsPure', { host: auth.host, path: auth.pathname, scope: auth.searchParams.get('scope'), state: auth.searchParams.get('state'), prompt: auth.searchParams.get('prompt'), mode: auth.searchParams.get('response_mode') })
  const rt0 = await signIn()
  t('login.codeExchangeAnswersGrant', { rotates: rt0.startsWith(`rt.${MAILBOX}.`), formEncoded: sink.received.find(r => r.path.endsWith('/token'))?.body && typeof (sink.received.find(r => r.path.endsWith('/token'))!.body as Record<string, string>).grant_type === 'string' })
  store.put('1', rt0)

  // ── the resolver ────────────────────────────────────────────────────────
  const u = await me(ms)
  t('resolver.firstSendRefreshesAndRotates', { mail: u.user?.mail, refreshes: resolverA.refreshes('1'), rowRotated: store.rows.get('1')!.refreshToken !== rt0, rowHoldsToken: !!store.rows.get('1')!.accessToken, lockReleased: store.rows.get('1')!.refreshing })
  await me(ms)
  t('resolver.secondSendUsesRow', { refreshes: resolverA.refreshes('1'), vendorRefreshes: box.refreshes })

  sink.expireAccessTokens()
  const before = calls()
  const r401 = await me(ms)
  t('resolver.401ForgetsAndReplaysOnce', { ok: !r401.error, statuses: sink.received.slice(before).filter(r => r.path === '/v1.0/me').map(r => r.status), refreshes: resolverA.refreshes('1') })

  // Two processes race one expired grant: the row's compare-and-set lets one refresh.
  store.rows.get('1')!.expiresAt = 0
  sink.knobs.tokenDelayMs = 60
  const vendorBefore = box.refreshes
  const [ra, rb] = await Promise.all([
    (async () => { active = resolverA; return me(ms) })(),
    (async () => { await Bun.sleep(5); active = resolverB; return me(ms) })(),
  ])
  active = resolverA
  sink.knobs.tokenDelayMs = 0
  t('resolver.crossProcessLockOneRefresh', { bothOk: !ra.error && !rb.error, vendorAsked: box.refreshes - vendorBefore, refreshesA: resolverA.refreshes('1'), refreshesB: resolverB.refreshes('1'), sameRow: store.rows.get('1')!.refreshing === null })

  // Eight callers in one process share one refresh.
  store.rows.get('1')!.expiresAt = 0
  const v2 = box.refreshes
  const eight = await Promise.all(Array.from({ length: 8 }, () => me(ms)))
  t('resolver.inProcessRacersShareOneRefresh', { allOk: eight.every(r => !r.error), vendorAsked: box.refreshes - v2 })

  // The grant dies: fail closed, the row marked, and a new sign-in clears it.
  sink.revoke(MAILBOX)
  sink.expireAccessTokens()
  store.rows.get('1')!.expiresAt = 0
  const lost = await me(ms)
  t('resolver.lostGrantFailsClosed', { kind: lost.error?.kind, retryable: lost.error?.retryable, state: resolverA.state('1'), stored: store.lost.get('1')?.kind, aadsts: store.lost.get('1')?.aadsts, again: (await me(ms)).error?.kind, vendorAskedAgain: box.refreshes })
  store.put('1', await signIn())
  resolverA.forget('1'); resolverB.forget('1')
  t('resolver.reSignInRecovers', { mail: (await me(ms)).user?.mail, state: resolverA.state('1') })

  // ── translate, pure ─────────────────────────────────────────────────────
  const err = (raw: unknown, kind = 'client_error') => ({ kind: kind as never, target: 't', protocol: 'http' as const, message: 'm', retryable: false, raw })
  t('errors.translateReadsBothVendors', {
    grantLost: (({ kind, aadsts }) => ({ kind, aadsts }))(translate(err({ error: 'invalid_grant', error_description: 'AADSTS70000: redeemed' }), 400)),
    badClient: translate(err({ error: 'invalid_client', error_description: 'AADSTS7000215: secret' }), 401).kind,
    syncReset: translate(err({ error: { code: 'SyncStateNotFound', message: 'x' } }), 410).kind,
    gone: translate(err({ error: { code: 'ErrorItemNotFound' } }), 404).kind,
    forbidden: translate(err({ error: { code: 'ErrorAccessDenied' } }), 403).kind,
    throttled: (({ kind, retryable }) => ({ kind, retryable }))(translate({ ...err({ error: { code: 'ApplicationThrottled' } }, 'rate_limited'), retryable: true, retry_after_ms: 2000 } as never, 429)),
  })

  // ── folders ─────────────────────────────────────────────────────────────
  const folders = await listFolders(ms)
  const inbox = await folder(ms, 'inbox')
  const made = await createFolder(ms, 'Lawn Leads')
  t('folders.listWellKnownCreate', { names: folders.folders?.map(f => f.displayName).sort(), inbox: inbox.folder?.displayName, created: made.folder?.displayName, onlyByName: (await listFolders(ms, { displayName: 'Lawn Leads' })).folders?.length })

  // ── delta ───────────────────────────────────────────────────────────────
  const since = new Date(Date.now() - 7 * 86_400_000)
  box.deliver({ from: 'pat@example.test', subject: 'Old one', receivedAt: new Date(Date.now() - 30 * 86_400_000) })
  const m1 = box.deliver({ from: { name: 'Dana', address: 'dana@cleanaffinity.test' }, subject: 'Quote for spring clean', html: '<p>Can you quote?</p>' })
  box.deliver({ from: 'lee@rosecitywindows.test', subject: 'Window schedule' })
  const first = await walkDelta(ms, { folderId: inbox.folder!.id, since, select: 'id,conversationId' })
  const firstReq = sink.received.find(r => r.path.endsWith('/messages/delta'))!
  t('delta.firstRoundCarriesSinceAndSelect', { items: first.round?.items.length, removed: first.round?.removed.length, filter: firstReq.query.$filter?.startsWith('receivedDateTime ge '), select: firstReq.query.$select, hasDeltaLink: !!first.round?.deltaLink, onlyIds: first.round?.items.every(i => Object.keys(i).filter(k => !k.startsWith('@')).sort().join() === 'conversationId,id') })
  for (let i = 0; i < 12; i++) box.deliver({ from: 'bulk@example.test', subject: `Bulk ${i}` })
  box.move(m1.immutableId, 'archive')
  const second = await walkDelta(ms, { deltaLink: first.round!.deltaLink })
  t('delta.nextRoundPagesAndTombstones', { items: second.round?.items.length, removed: second.round?.removed, pages: second.round?.pages })
  const idle = await walkDelta(ms, { deltaLink: second.round!.deltaLink })
  t('delta.quietRoundIsEmpty', { items: idle.round?.items.length, pages: idle.round?.pages })
  sink.expireDeltaTokens(MAILBOX)
  const reset = await deltaNext(ms, idle.round!.deltaLink)
  t('delta.410IsSyncReset', { kind: reset.error?.kind, code: reset.error?.code, retryable: reset.error?.retryable })
  const n = calls()
  const foreign = await deltaNext(ms, 'https://graph.evil.test/v1.0/me/mailFolders/x/messages/delta?$deltatoken=1')
  t('delta.foreignLinkRefusedUnsent', { kind: foreign.error?.kind, sent: calls() - n, pure: linkToRequest(`${sink.graphUrl}/me/messages/delta?$skiptoken=abc`, sink.graphUrl) })

  // ── conversation and attachments ────────────────────────────────────────
  const m2 = box.deliver({ from: 'dana@cleanaffinity.test', subject: 'Re: Quote for spring clean', conversationId: m1.conversationId, html: '<p>Estimate attached.</p>', attachments: [{ name: 'estimate.pdf', contentType: 'application/pdf', bytes: '%PDF-1.4 estimate' }] })
  const conv = await conversation(ms, m1.conversationId)
  const withFile = conv.messages?.find(m => m.id === m2.immutableId)
  t('conversation.allMessagesAttachmentMetaOnly', { count: conv.messages?.length, immutableIds: conv.messages?.every(m => m.id.startsWith('AAkALg')), named: withFile?.attachments?.[0]?.name, noBytes: !JSON.stringify(withFile?.attachments).includes('contentBytes'), from: addressesOf(withFile?.toRecipients)[0]?.address, header: headerOf(withFile!, 'x-ms-exchange-organization-authas') })
  const bytes = await attachmentBytes(ms, m2.immutableId, withFile!.attachments![0].id)
  t('attachment.bytesOnDemand', { text: new TextDecoder().decode(bytes.bytes!), length: bytes.bytes?.length })
  const one = await message(ms, m2.restId)
  t('message.restIdAnswersImmutable', { same: one.message?.id === m2.immutableId, isRead: one.message?.isRead })

  // ── subscriptions and the handshake ─────────────────────────────────────
  const held: { id: string | null; clientState: string; expiresAt: string | null }[] = []
  const subStore: SubscriptionStore = { current: () => { const last = held.at(-1); return last?.id ? { id: last.id, clientState: last.clientState } : null }, save(rec) { held.push(rec); if (rec.id) subs.set(rec.id, rec.clientState); else subs.set('pending', rec.clientState) } }
  const e1 = await ensureSubscription(ms, subStore, { notificationUrl: HOOK, lifecycleNotificationUrl: `${HOOK}/lifecycle`, minutes: 4230 })
  const sub1 = (e1.ensured as { subscription: Subscription }).subscription
  const minutes = Math.round((Date.parse(sub1.expirationDateTime) - Date.now()) / 60_000)
  t('subscriptions.createdAfterHandshake', { action: e1.ensured?.action, handshakes: sink.deliveries.filter(d => d.kind === 'validation').length, minutes, clientStateSavedBeforeCreate: held[0]?.id === null && held[1]?.id === sub1.id, resource: sub1.resource })
  const e2 = await ensureSubscription(ms, subStore, { notificationUrl: HOOK, lifecycleNotificationUrl: `${HOOK}/lifecycle` })
  sink.lapse(sub1.id)
  const e3 = await ensureSubscription(ms, subStore, { notificationUrl: HOOK, lifecycleNotificationUrl: `${HOOK}/lifecycle` })
  t('subscriptions.renewThenRecreateOn404', { second: e2.ensured?.action, third: e3.ensured?.action, replaced: (e3.ensured as { replaced?: string }).replaced === sub1.id, newSecret: held.at(-1)!.clientState !== held[1].clientState })

  // ── receiving ───────────────────────────────────────────────────────────
  receiver.reset()
  const fresh = box.deliver({ from: 'new@example.test', subject: 'A new lead' })
  await sink.settle()
  const ev = receiver.applied[0]
  t('receive.changeVerifiedAndParsed', { applied: receiver.applied.length, refused: receiver.refused.length, type: ev?.type, changes: ev?.payload.notifications.map(n => n.changeType), restId: ev && resourceIdOf(ev.payload.notifications[0]) === fresh.restId })
  receiver.reset()
  sink.knobs.forgeClientState = 1
  box.deliver({ from: 'forger@example.test', subject: 'Forged' })
  await sink.settle()
  t('receive.forgedClientStateRefused', { refused: [...receiver.refused], applied: receiver.applied.length })
  receiver.reset()
  sink.knobs.duplicates = 2
  box.deliver({ from: 'twice@example.test', subject: 'Delivered twice' })
  await sink.settle()
  sink.knobs.duplicates = 1
  t('receive.redeliveryHasOneDedupeKey', { deliveries: receiver.keys.length, distinct: new Set(receiver.keys).size })
  receiver.reset()
  await sink.lifecycle('reauthorizationRequired')
  t('receive.lifecycleParsed', { type: receiver.lifecycle[0]?.type, event: receiver.lifecycle[0]?.payload.events[0]?.lifecycleEvent, refused: receiver.refused.length })

  // ── writes ──────────────────────────────────────────────────────────────
  const n2 = calls()
  const badHeader = await createDraft(ms, { subject: 'x', headers: [{ name: 'Message-ID', value: '<a@b>' }] })
  t('writes.nonXHeaderRefusedUnsent', { kind: badHeader.error?.kind, sent: calls() - n2 })
  const draft = await createDraft(ms, { subject: 'Your quote', html: '<p>Attached.</p>', to: [{ address: 'dana@cleanaffinity.test', name: 'Dana' }], headers: [{ name: 'x-ela-thread', value: 't-42' }] })
  const sent = await sendDraft(ms, draft.draft!.id)
  const found = await findByInternetMessageId(ms, draft.draft!.internetMessageId!)
  t('writes.draftSendFindByMessageId', { drafted: draft.draft?.isDraft, sent: sent.sent, found: !!found.message, newId: found.message?.id !== draft.draft?.id, keptHeader: headerOf(found.message!, 'x-ela-thread'), inSent: found.message?.parentFolderId === box.folder('sentitems') })
  const reply = await createReply(ms, m2.immutableId, 'reply', { html: '<p>Sure.</p>' })
  const read = await patchMessage(ms, m2.immutableId, { isRead: true })
  const moved = await moveMessage(ms, m2.immutableId, 'archive')
  t('writes.replyPatchMove', { replyInThread: reply.draft?.conversationId === m1.conversationId, replyTo: addressesOf(reply.draft?.toRecipients)[0]?.address, isRead: read.message?.isRead, movedSameId: moved.message?.id === m2.immutableId, folder: moved.message?.parentFolderId === box.folder('archive') })

  // ── MIME send ───────────────────────────────────────────────────────────
  const mimeText = ['From: office@kobami.test', 'To: dana@cleanaffinity.test', 'Subject: =?UTF-8?B?' + Buffer.from('Résumé').toString('base64') + '?=', 'Message-ID: <mime-1@kobami.test>', 'Content-Type: text/html; charset=utf-8', '', '<p>Hi</p>'].join('\r\n')
  const n3 = calls()
  const notB64 = await sendMime(ms, mimeText)
  const mimeSent = await sendMime(ms, Buffer.from(mimeText).toString('base64'))
  const mimeReq = sink.received.find(r => r.path.endsWith('/sendMail'))
  t('mime.sendMailBase64TextPlain', { refusedPlain: notB64.error?.kind, plainSent: calls() - n3 - 1, sent: mimeSent.sent, subject: box.messages().find(m => m.internetMessageId === '<mime-1@kobami.test>')?.subject, bodyWasString: typeof mimeReq?.body === 'string' })

  // ── resilience ──────────────────────────────────────────────────────────
  sink.failNext({ path: /\/v1\.0\/me$/ }, 429, { times: 3, retryAfter: 1 })
  const n4 = calls()
  const throttled = await me(ms)
  t('resilience.429RetriedThenSurfacedWithRetryAfter', { kind: throttled.error?.kind, retryable: throttled.error?.retryable, retryAfterMs: throttled.error?.retryAfterMs, attempts: calls() - n4 })
  const draft2 = await createDraft(ms, { subject: 'Lost answer', to: [{ address: 'x@y.test' }] })
  sink.dropNext({ method: 'POST', path: /\/send$/ })
  const lostSend = await sendDraft(ms, draft2.draft!.id)
  const resolved = await findByInternetMessageId(ms, draft2.draft!.internetMessageId!)
  t('resilience.lostAnswerIndeterminateResolvedByRead', { kind: lostSend.error?.kind, indeterminate: lostSend.error?.indeterminate ?? false, writeHappened: !!resolved.message && resolved.message.id !== draft2.draft!.id })

  // ── negative control ────────────────────────────────────────────────────
  const dumbUrl = `http://127.0.0.1:${dumb.port}/no-echo`
  const refused = await createSubscription(ms, { notificationUrl: dumbUrl, clientState: 'cs' })
  t('control.handshakeNotEchoedIsRefused', { kind: refused.error?.kind, status: refused.error?.status, mentionsValidation: refused.error?.message.includes('validation') })
} catch (e) {
  got.__threw = String((e as Error).stack ?? e)
} finally {
  sink.stop(); hook.stop(true); dumb.stop(true)
}

const expected = {
  'targets.threeOneCredentialEach': { ids: ['provider:microsoft:graph', 'provider:microsoft:mime', 'provider:microsoft:login'], auth: ['bearer:per_caller', 'bearer:per_caller', 'none'], encodings: ['json', 'binary', 'form'], retries: [2, 0, 0], preferImmutable: true },
  'login.authorizeUrlIsPure': { host: 'login.microsoftonline.com', path: '/organizations/oauth2/v2.0/authorize', scope: 'offline_access openid profile email User.Read Mail.ReadWrite Mail.Send', state: 'xyz', prompt: 'select_account', mode: 'query' },
  'login.codeExchangeAnswersGrant': { rotates: true, formEncoded: true },
  'resolver.firstSendRefreshesAndRotates': { mail: MAILBOX, refreshes: 1, rowRotated: true, rowHoldsToken: true, lockReleased: null },
  'resolver.secondSendUsesRow': { refreshes: 1, vendorRefreshes: 1 },
  'resolver.401ForgetsAndReplaysOnce': { ok: true, statuses: [401, 200], refreshes: 2 },
  'resolver.crossProcessLockOneRefresh': { bothOk: true, vendorAsked: 1, refreshesA: 3, refreshesB: 0, sameRow: true },
  'resolver.inProcessRacersShareOneRefresh': { allOk: true, vendorAsked: 1 },
  'resolver.lostGrantFailsClosed': { kind: 'auth_failed', retryable: false, state: 'lost', stored: 'grant_lost', aadsts: '50173', again: 'auth_failed', vendorAskedAgain: 4 },
  'resolver.reSignInRecovers': { mail: MAILBOX, state: 'ok' },
  'errors.translateReadsBothVendors': { grantLost: { kind: 'grant_lost', aadsts: '70000' }, badClient: 'auth_failed', syncReset: 'sync_reset', gone: 'gone', forbidden: 'forbidden', throttled: { kind: 'rate_limited', retryable: true } },
  'folders.listWellKnownCreate': { names: ['Archive', 'Deleted Items', 'Drafts', 'Inbox', 'Sent Items'], inbox: 'Inbox', created: 'Lawn Leads', onlyByName: 1 },
  'delta.firstRoundCarriesSinceAndSelect': { items: 2, removed: 0, filter: true, select: 'id,conversationId', hasDeltaLink: true, onlyIds: true },
  'delta.nextRoundPagesAndTombstones': { items: 12, removed: [m1Id()], pages: 2 },
  'delta.quietRoundIsEmpty': { items: 0, pages: 1 },
  'delta.410IsSyncReset': { kind: 'sync_reset', code: 'SyncStateNotFound', retryable: false },
  'delta.foreignLinkRefusedUnsent': { kind: 'refused', sent: 0, pure: { path: '/me/messages/delta', query: { $skiptoken: 'abc' } } },
  'conversation.allMessagesAttachmentMetaOnly': { count: 2, immutableIds: true, named: 'estimate.pdf', noBytes: true, from: MAILBOX, header: 'Anonymous' },
  'attachment.bytesOnDemand': { text: '%PDF-1.4 estimate', length: 17 },
  'message.restIdAnswersImmutable': { same: true, isRead: false },
  'subscriptions.createdAfterHandshake': { action: 'created', handshakes: 2, minutes: 4230, clientStateSavedBeforeCreate: true, resource: 'me/messages' },
  'subscriptions.renewThenRecreateOn404': { second: 'renewed', third: 'created', replaced: true, newSecret: true },
  'receive.changeVerifiedAndParsed': { applied: 1, refused: 0, type: 'change', changes: ['created'], restId: true },
  'receive.forgedClientStateRefused': { refused: ['clientState does not match the subscription'], applied: 0 },
  'receive.redeliveryHasOneDedupeKey': { deliveries: 2, distinct: 1 },
  'receive.lifecycleParsed': { type: 'lifecycle', event: 'reauthorizationRequired', refused: 0 },
  'writes.nonXHeaderRefusedUnsent': { kind: 'refused', sent: 0 },
  'writes.draftSendFindByMessageId': { drafted: true, sent: true, found: true, newId: true, keptHeader: 't-42', inSent: true },
  'writes.replyPatchMove': { replyInThread: true, replyTo: 'dana@cleanaffinity.test', isRead: true, movedSameId: true, folder: true },
  'mime.sendMailBase64TextPlain': { refusedPlain: 'refused', plainSent: 0, sent: true, subject: 'Résumé', bodyWasString: true },
  'resilience.429RetriedThenSurfacedWithRetryAfter': { kind: 'rate_limited', retryable: true, retryAfterMs: 1000, attempts: 3 },
  'resilience.lostAnswerIndeterminateResolvedByRead': { kind: 'server_error', indeterminate: true, writeHappened: true },
  'control.handshakeNotEchoedIsRefused': { kind: 'refused', status: 400, mentionsValidation: true },
}

function m1Id() { return (got['delta.nextRoundPagesAndTombstones'] as { removed?: string[] } | undefined)?.removed?.[0] ?? '(m1)' }

process.exit(report(got, expected))
