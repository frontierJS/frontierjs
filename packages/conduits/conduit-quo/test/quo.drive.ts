// test/quo.drive.ts — the connector against the sink. No fixture: nobody runs
// a local Quo. What is only provable here: each call goes out on its own
// generation (v1 bare, dated with the version pinned); a daily limit spelled
// 429 is not a rate limit; a lost send is found again by the read with no key
// to find it by; a webhook verifies with the key its create handed back and
// stops verifying the moment that key is rotated; and both webhook
// generations land one row shape through conduit's own order.

import { createConduit, createStaticResolver, type Delivery } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startQuoSink } from '../sink.ts'
import {
  quoTargets, bindQuo, sendMessage, findSent, getMessage, retryMessage, createWebhook, listWebhooks, getWebhook, updateWebhook, rotateWebhookKey, deleteWebhook, listDeliveries, getDelivery, retryDelivery, healDeliveries, sendTestEvent, QUO_MAX_PAGE,
  backfillMessages, backfillCalls, backfillConversations, backfillContacts, getContactProperties, markRead, markDone, markOpen,
  getCall, getCallRecordings, getCallTranscripts, fileBytes,
  getTask, backfillTasks, setTaskStatus, linkTask, unlinkTask, assignTask, unassignTask, setTaskDueDate,
  getPhoneNumber, backfillPhoneNumbers, getPhoneNumberSettings, updatePhoneNumberSettings, getPhoneNumberMembers, availablePhoneNumbers,
  getUser, backfillUsers, getUserPhoneNumbers, getOrganization,
  getA2PRegistration, createA2PRegistration, updateA2PRegistration, submitA2PRegistration, a2pRegistration, type QuoA2PDraft,
  toE164, verifyQuoSignature, signQuo, quoDialect, quoLegacyDialect, parseQuoEvent, QUO_EVENT_TYPES, type QuoEvent,
  mirror, messageModel, callModel, conversationModel, contactModel, userModel, organizationModel, QUO_TARGET, type QuoCall, type QuoContact, type QuoConversation, type QuoMessage, type PhoneNumberRow,
} from '../src/index.ts'

const { got, t } = results()
const KEY = 'quo_dev_key'
const LEGACY_KEY = Buffer.from('quo-dev-legacy-signing-key-00001').toString('base64')
const OURS = '+15550001111', THEM = '+14155550100', OTHER = '+14155550199'

const conduit = createConduit({ credentials: createStaticResolver({ QUO_API_KEY: KEY, QUO_LEGACY: LEGACY_KEY }), ...DRIVE_RESILIENCE })

// The app's half: the key it stored from create or rotate, and what landed.
const stored = { key: '' }
type Payload = QuoEvent['payload']
const inbox: ({ id: string; type: string; status: string } & Pick<Payload, 'message' | 'call' | 'contact' | 'task' | 'external' | 'conversationExternalId' | 'errorCode' | 'contactExternalIds' | 'recordings' | 'transcript'>)[] = []
const landed = (type: string, ev: QuoEvent) => {
  const { message, call, contact, task, external, conversationExternalId, errorCode, contactExternalIds, recordings, transcript } = ev.payload
  inbox.push({ id: ev.id, type, status: message?.status ?? '', message, call, contact, task, external, conversationExternalId, errorCode, contactExternalIds, recordings, transcript })
  return 'applied' as const
}
const answered: { path: string; status: number; result?: string; webhookId: string | null }[] = []
conduit.receive({ provider: 'quo', path: '/webhooks/quo', dialect: quoDialect, credential: () => stored.key || null,
  apply: ev => landed(ev.type, ev) })
conduit.receive({ provider: 'quo-legacy', path: '/webhooks/quo-legacy', dialect: quoLegacyDialect, credential: 'QUO_LEGACY',
  apply: ev => landed(`legacy:${ev.type}`, ev) })
// A second subscription from the same workspace, on its own path and key.
const stored2 = { key: '' }
conduit.receive({ provider: 'quo', path: '/webhooks/quo-2', dialect: quoDialect, credential: () => stored2.key || null,
  apply: ev => landed(`second:${ev.type}`, ev) })
// A third, hearing the task events.
const stored3 = { key: '' }
conduit.receive({ provider: 'quo', path: '/webhooks/quo-tasks', dialect: quoDialect, credential: () => stored3.key || null,
  apply: ev => landed(`task:${ev.type}`, ev) })

// The transport an app's route would be: raw bytes in, conduit's order, its status out.
const receiver = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url), rawBody = await req.text()
    const d: Delivery = { method: req.method, path: url.pathname, query: url.search, route: {}, headers: Object.fromEntries([...req.headers].map(([k, v]) => [k.toLowerCase(), v])), rawBody, body: (() => { try { return JSON.parse(rawBody) } catch { return null } })() }
    const r = await conduit.accept(url.pathname, d, Math.floor(Date.now() / 1000))
    answered.push({ path: url.pathname, status: r.status, result: r.result, webhookId: req.headers.get('webhook-id') })
    return new Response(null, { status: r.status })
  },
})
const hookUrl = `http://127.0.0.1:${receiver.port}/webhooks/quo`
const sink = await startQuoSink({ key: KEY, legacy: { url: () => `http://127.0.0.1:${receiver.port}/webhooks/quo-legacy`, key: LEGACY_KEY } })
const ctl = control(sink.url)
// The sink's storage is on localhost, which a files target refuses unless told.
const targets = quoTargets({ address: sink.url, fileDestinations: { allowHttp: true, allowPrivate: true } })
await conduit.register(targets.v1)
await conduit.register(targets.dated)
await conduit.register(targets.files)
const quo = bindQuo(conduit, targets)
type Seen = { requests: { method: string; path: string; query: string; version: string | null; auth: string | null; body: string }[]; contacts: QuoContact[]; messages: { id: string; text: string }[]; deliveries: { hook: string; id: string; status: string; createdAt: string }[] }
const seen = () => ctl.seen() as unknown as Promise<Seen>
// The report compares JSON, where a Date is `{}`, so a time shows as its type and value.
const shown = (row: object | null | undefined) => row && Object.fromEntries(Object.entries(row).map(([k, x]) => [k, x instanceof Date ? `Date ${x.toISOString()}` : x]))
const settle = () => new Promise(r => setTimeout(r, 80))
const until = async (ok: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise(r => setTimeout(r, 20)) }

try {
  t('e164.normalizes', { paren: toE164('(415) 555-0100', '1'), intl: toE164('+44 20 7946 0958'), zeros: toE164('0044 20 7946 0958') })

  // C9: refused here, so the sink never hears of them.
  await ctl.reset()
  const local = {
    noCountry: await sendMessage(quo, { from: OURS, to: '555-0100', text: 'hi' }).then(() => false, e => /no country code/.test(e.message)),
    blank:     await sendMessage(quo, { from: OURS, to: THEM, text: '  \n ' }).then(() => false, e => /non-blank/.test(e.message)),
    tooLong:   await sendMessage(quo, { from: OURS, to: THEM, text: 'x'.repeat(1601) }).then(() => false, e => /at most 1600/.test(e.message)),
    tooMany:   await sendMessage(quo, { from: OURS, to: Array.from({ length: 11 }, (_, i) => `+1415555${String(1000 + i)}`), text: 'hi' }).then(() => false, e => /1–10 recipients/.test(e.message)),
    noEvents:  await createWebhook(quo, { url: hookUrl, events: [] }).then(() => false, e => /at least one event/.test(e.message)),
    notMessageId: await retryMessage(quo, 'PNour0001').then(() => false, e => /not a message id/.test(e.message)),
    notWebhookId: await listDeliveries(quo, 'WHabc').then(() => false, e => /not a dated webhook id/.test(e.message)),
    pageTooBig:   await listDeliveries(quo, '1', { limit: 51 }).then(() => false, e => /1–50/.test(e.message)),
    retryNotWebhookId: await retryDelivery(quo, 'WHabc', 'msg_1').then(() => false, e => /not a dated webhook id/.test(e.message)),
    retryNoDelivery:   await retryDelivery(quo, '1', '').then(() => false, e => /delivery id/.test(e.message)),
    testNotWebhookId:  await sendTestEvent(quo, 'WHabc', 'call.completed').then(() => false, e => /not a dated webhook id/.test(e.message)),
    testUnknownType:   await sendTestEvent(quo, '1', 'call.dropped').then(() => false, e => /not an event type/.test(e.message)),
    getNotWebhookId:    await getWebhook(quo, 'WHabc').then(() => false, e => /not a dated webhook id/.test(e.message)),
    updateNotWebhookId: await updateWebhook(quo, 'WHabc', { status: 'enabled' }).then(() => false, e => /not a dated webhook id/.test(e.message)),
    updateNothing:      await updateWebhook(quo, '1', { label: undefined }).then(() => false, e => /at least one field/.test(e.message)),
    updateNoEvents:     await updateWebhook(quo, '1', { events: [] }).then(() => false, e => /at least one event/.test(e.message)),
    updateUnknownEvent: await updateWebhook(quo, '1', { events: ['call.dropped' as never] }).then(() => false, e => /not an event type/.test(e.message)),
    backfillNoPages:    await backfillContacts(quo, { pages: 0 }).then(() => false, e => /at least one page/.test(e.message)),
    backfillBadSince:   await backfillMessages(quo, { since: 'yesterday' }).then(() => false, e => /not a time/.test(e.message)),
    propertiesNoContact: await getContactProperties(quo, '').then(() => false, e => /Quo id/.test(e.message)),
    markNotConversationId: await markRead(quo, 'AC123').then(() => false, e => /not a conversation id/.test(e.message)),
    markBarePrefix:        await markDone(quo, 'CN').then(() => false, e => /not a conversation id/.test(e.message)),
    callNotCallId:         await getCall(quo, 'CN123').then(() => false, e => /not a call id/.test(e.message)),
    recordingsNotCallId:   await getCallRecordings(quo, 'VM123').then(() => false, e => /not a call id/.test(e.message)),
    transcriptsBarePrefix: await getCallTranscripts(quo, 'AC').then(() => false, e => /not a call id/.test(e.message)),
    fileNotAUrl:           await fileBytes(quo, 'recordings/a.mp3').then(() => false, e => /not a file URL/.test(e.message)),
  }
  t('local.refusedBeforeSending', { ...local, reached: (await seen()).requests.length })

  // The key comes back once, on create; the list never shows it.
  const made = await createWebhook(quo, { url: hookUrl, events: ['message.received', 'message.delivered', 'message.failed', 'message.undelivered', 'call.ringing', 'call.answered', 'call.missed', 'call.completed'], label: 'drive' })
  stored.key = made.key ?? ''
  const listed = await listWebhooks(quo)
  t('webhook.keyOnlyOnCreate', { key: /^whsec_/.test(made.key ?? ''), listed: listed.webhooks?.length, listHasKey: listed.webhooks?.some(w => 'key' in w), pinned: listed.webhooks?.[0]?.apiVersion })

  await ctl.reset(); inbox.length = 0
  const sent = await sendMessage(quo, { from: OURS, to: THEM, text: 'hello' })
  await settle()
  const read = await getMessage(quo, sent.message!.id)
  const wire = (await seen()).requests
  // The negative control: without the pinned header on the dated target, the read is Quo's 400.
  t('wire.eachCallOnItsGeneration', {
    send: wire.filter(r => r.method === 'POST').map(r => ({ path: r.path, version: r.version, auth: r.auth })),
    read: wire.filter(r => r.method === 'GET').map(r => ({ path: r.path.replace(/AC\w+/, 'AC…'), version: r.version })),
    readOk: read.message?.id === sent.message?.id,
  })
  t('send.queuedThenDeliveredLater', { atSend: sent.message?.status, laterEvent: inbox.find(e => e.type === 'message.delivered')?.status })

  inbox.length = 0
  await ctl.arm({ deliverFirst: true })
  const early = await sendMessage(quo, { from: OURS, to: THEM, text: 'hello again' })
  t('receipt.mayArriveBeforeSendAnswers', { sendSays: early.message?.status, receiptAlreadyIn: inbox.some(e => e.type === 'message.delivered' && e.message?.externalId === early.message?.id) })

  // The body's code decides, not the status.
  const refused = async (arm: Record<string, unknown> | null, to = THEM) => {
    await ctl.reset(); if (arm) await ctl.arm(arm)
    const r = await sendMessage(quo, { from: OURS, to, text: 'hi' })
    return { kind: r.error?.kind, retryable: r.error?.retryable, code: r.error?.code, attempts: (await seen()).requests.length }
  }
  t('refusals.domainWords', {
    unregistered:      await refused({ refuse: 'unregistered' }),
    dailyCap:          await refused({ refuse: 'dailyCap' }),
    conversationLimit: await refused({ refuse: 'conversationLimit' }),
    subscription:      await refused({ refuse: 'subscription' }),
    notMember:         await refused({ refuse: 'notMember' }),
    international:     await refused(null, '+442079460958'),
  })

  const field = await sendMessage(bindQuo({ send: req => conduit.send({ ...req, body: { ...(req.body as object), to: ['not-a-number'] } }) }, targets), { from: OURS, to: THEM, text: 'hi' })
  t('refusal.namesTheField', { kind: field.error?.kind, fields: field.error?.fields?.map(f => f.path), trace: typeof field.error?.trace })

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const limited = await sendMessage(quo, { from: OURS, to: THEM, text: 'hi' })
  t('rateLimited.handedToCaller', { kind: limited.error?.kind, retryable: limited.error?.retryable, retryAfterMs: limited.error?.retryAfterMs, attempts: (await seen()).requests.length })

  // C6: the send landed, its answer did not; the read finds it without a key.
  await ctl.reset(); await ctl.arm({ lost: true })
  const lost = await sendMessage(quo, { from: OURS, to: OTHER, text: 'did this land?' })
  const attempts = (await seen()).requests.length
  const found = await findSent(quo, lost.attempt)
  const landed = (await seen()).messages.find(m => m.text === 'did this land?')
  t('lostSend.indeterminateThenFound', { kind: lost.error?.kind, indeterminate: lost.error?.indeterminate, retryable: lost.error?.retryable, attempts, foundTheOne: !!landed && found.message?.id === landed.id })

  // The same words to someone else, or other words to the same person, are not this send.
  const elsewhere = await findSent(quo, { ...lost.attempt, to: [THEM] })
  const otherWords = await findSent(quo, { ...lost.attempt, text: 'something else' })
  const byPnId = await findSent(quo, { ...lost.attempt, from: sink.numbers[OURS] })
  t('findSent.matchesOnlyThisAttempt', { elsewhere: elsewhere.message, otherWords: otherWords.message, byPnId: byPnId.message?.id === landed?.id })

  // A failed text goes again under its own id; a permanent failure is Quo's 422, and nothing is replayed.
  const failing = async (fails: string) => {
    await ctl.arm({ failDelivery: fails })
    const s = await sendMessage(quo, { from: OURS, to: THEM, text: `fails ${fails}` })
    await settle()
    return s.message!.id
  }
  const retries = async () => (await seen()).requests.filter(r => r.path.endsWith('/retry'))
  const of = (id: string, type: string) => inbox.find(e => e.type === type && e.message?.externalId === id)
  await ctl.reset(); inbox.length = 0
  const transient = await failing('failed')
  const failedEvent = of(transient, 'message.failed')
  const retried = await retryMessage(quo, transient)
  await settle()
  t('retry.failedThenDelivered', {
    failed:    failedEvent && { status: failedEvent.message?.status, errorCode: failedEvent.errorCode },
    error:     retried.error ?? null,
    wire:      (await retries()).map(r => ({ path: r.path.replace(/AC\w+/, 'AC…'), version: r.version })),
    delivered: of(transient, 'message.delivered')?.message?.externalId === transient,
  })

  const refusedRetry = async (id: string) => {
    await ctl.reset()
    const r = await retryMessage(quo, id)
    return { kind: r.error?.kind, retryable: r.error?.retryable, attempts: (await retries()).length }
  }
  t('retry.onlyATransientFailure', {
    permanent:   await refusedRetry(await failing('permanent')),
    undelivered: await refusedRetry(await failing('undelivered')),
    delivered:   await refusedRetry(transient),
    unknown:     await refusedRetry('ACnosuchmessage'),
  })

  // The retry was taken and its answer lost; a replay would be refused, so the read says.
  await ctl.reset()
  const dropped = await failing('failed')
  await ctl.arm({ lost: true })
  const lostRetry = await retryMessage(quo, dropped)
  const lostAttempts = (await retries()).length
  await settle()
  t('retry.lostIsReadNotReplayed', { kind: lostRetry.error?.kind, indeterminate: lostRetry.error?.indeterminate, attempts: lostAttempts, afterRead: (await getMessage(quo, dropped)).message?.status })

  // A person texts our number; Quo retries with the same webhook-id; conduit applies it once.
  await ctl.reset(); inbox.length = 0; answered.length = 0
  await ctl.arm({ deliverTwice: true })
  const stop = await fetch(`${sink.url}/_sink/inbound`, { method: 'POST', body: JSON.stringify({ from: THEM, to: OURS, text: ' Stop ' }) }).then(r => r.json()) as { id: string }
  await settle()
  const standardIn = inbox.filter(e => e.type === 'message.received')
  const legacyIn = inbox.filter(e => e.type === 'legacy:message.received')
  const inRow = standardIn[0]?.message
  t('inbound.verifiedOnceAsARow', {
    standard: answered.filter(a => a.path === '/webhooks/quo').map(a => a.result),
    legacy:   answered.filter(a => a.path === '/webhooks/quo-legacy').map(a => a.result),
    applied:  standardIn.length,
    // No `updatedAt` and no user: the event names neither, so the row leaves them for a read to fill.
    columns:  inRow && Object.keys(inRow).sort(),
    message:  inRow && { key: inRow.externalId === stop.id, from: inRow.from, to: inRow.to, text: inRow.text, phoneNumber: inRow.phoneNumberExternalId, direction: inRow.direction, createdAt: inRow.createdAt instanceof Date },
    beside:   { external: standardIn[0]?.external, conversation: /^CN/.test(standardIn[0]?.conversationExternalId ?? ''), errorCode: standardIn[0]?.errorCode },
  })
  // Both generations, one row for the app; legacy alone names the user.
  const strip = (e: typeof inbox[number] | undefined) => e?.message && { ...shown(e.message), userExternalId: undefined, external: e.external, conversation: e.conversationExternalId }
  t('legacy.sameMessageRow', { same: JSON.stringify(strip(legacyIn[0])) === JSON.stringify(strip(standardIn[0])), legacyOnly: Object.keys(legacyIn[0]?.message ?? {}).filter(k => !(k in (inRow ?? {}))) })

  // Calls: a dated call context names participants, ours and theirs, so who is `from` turns on the direction.
  const call = async (b: { direction: 'incoming' | 'outgoing'; answered: boolean; unresolved?: boolean; segments?: number; voicemail?: boolean }) => {
    inbox.length = 0
    const r = await fetch(`${sink.url}/_sink/call`, { method: 'POST', body: JSON.stringify({ ours: OURS, theirs: THEM, ...b }) }).then(r => r.json()) as { id: string }
    await settle()
    const dated = inbox.filter(e => e.type.startsWith('call.')), legacy = inbox.filter(e => e.type.startsWith('legacy:call.'))
    const of = (type: string, from = dated) => from.find(e => e.type === type)
    return { id: r.id, dated, legacy, of }
  }

  const inAnswered = await call({ direction: 'incoming', answered: true })
  const columns = (e: typeof inbox[number] | undefined) => e?.call && Object.keys(e.call).sort()
  t('call.incomingAnswered', {
    types:     inAnswered.dated.map(e => e.type),
    sameId:    inAnswered.dated.every(e => e.call?.externalId === inAnswered.id),
    conversation: inAnswered.dated.every(e => /^CN/.test(e.conversationExternalId ?? '')),
    ringing:   columns(inAnswered.of('call.ringing')),
    answered:  columns(inAnswered.of('call.answered')),
    completed: columns(inAnswered.of('call.completed')),
    values:    { answeredBy: inAnswered.of('call.answered')?.call?.answeredByExternalId, status: inAnswered.of('call.completed')?.call?.status, duration: inAnswered.of('call.completed')?.call?.duration,
                 phoneNumber: inAnswered.of('call.ringing')?.call?.phoneNumberExternalId, external: inAnswered.of('call.ringing')?.external },
  })

  const missed = await call({ direction: 'incoming', answered: false })
  t('call.missedIsIncoming', {
    types:     missed.dated.map(e => e.type),
    missed:    { columns: columns(missed.of('call.missed')), direction: missed.of('call.missed')?.call?.direction },
    completed: { status: missed.of('call.completed')?.call?.status, answeredAt: missed.of('call.completed')?.call?.answeredAt, duration: missed.of('call.completed')?.call?.duration },
  })

  const outgoing = await call({ direction: 'outgoing', answered: true })
  t('call.outgoingExternalIsTheirs', { direction: outgoing.of('call.completed')?.call?.direction, external: outgoing.of('call.completed')?.external })

  const unresolved = await call({ direction: 'incoming', answered: true, unresolved: true })
  t('call.unavailableIsNull', { external: unresolved.of('call.completed')?.external, phoneNumber: unresolved.of('call.completed')?.call?.phoneNumberExternalId })

  // Both generations, one row; status is each generation's own word, and only dated carries a duration.
  const sides = (e: typeof inbox[number] | undefined) => e?.call && JSON.stringify([e.call.externalId, e.call.direction, e.call.phoneNumberExternalId, e.call.answeredAt, e.call.completedAt, e.call.createdAt, e.external, e.conversationExternalId])
  const legacyDone = inAnswered.of('legacy:call.completed', inAnswered.legacy), outLegacy = outgoing.of('legacy:call.completed', outgoing.legacy)
  t('legacy.sameCallRow', {
    types:  inAnswered.legacy.map(e => e.type),
    same:   sides(legacyDone) === sides(inAnswered.of('call.completed')) && sides(outLegacy) === sides(outgoing.of('call.completed')),
    status: { legacy: legacyDone?.call?.status, dated: inAnswered.of('call.completed')?.call?.status },
    columns: columns(legacyDone),
  })

  // A voicemail whose call Quo could not resolve has no call to key a row on; its own id is an activity, not the call.
  const vm = parseQuoEvent({ id: 'EVvm', apiVersion: '2026-03-30', createdAt: 'x', type: 'call.voicemail.completed', data: {
    resource: { id: 'ACvoicemail', voicemailId: 'VM1', callId: null, direction: 'incoming', from: THEM, to: OURS, recordingUrl: 'https://files.quo.test/vm.mp3' }, context: { participants: { workspace: [], external: [], resolution: 'unavailable' } } } }, 'standard')
  t('events.allListedUnresolvedVoicemail', { count: QUO_EVENT_TYPES.length, unique: new Set(QUO_EVENT_TYPES).size, voicemailCall: vm.payload.call, url: vm.payload.data.resource.recordingUrl })

  // A rotation is effective at once: the app that did not store the new key refuses every delivery after it.
  const hookId = made.webhook!.id
  const rotated = await rotateWebhookKey(quo, hookId)
  await ctl.reset(); answered.length = 0
  // Both bounds are exclusive, so the first delivery must not share the bound's millisecond.
  const beforeRotate = new Date().toISOString(); await new Promise(r => setTimeout(r, 5))
  await fetch(`${sink.url}/_sink/inbound`, { method: 'POST', body: JSON.stringify({ from: THEM, to: OURS, text: 'one' }) })
  stored.key = rotated.key ?? ''
  await fetch(`${sink.url}/_sink/inbound`, { method: 'POST', body: JSON.stringify({ from: THEM, to: OURS, text: 'two' }) })
  await settle()
  t('rotate.oldKeyStopsAtOnce', { newKey: /^whsec_/.test(rotated.key ?? '') && rotated.key !== made.key, beforeStoring: answered.filter(a => a.path === '/webhooks/quo')[0]?.status, afterStoring: answered.filter(a => a.path === '/webhooks/quo')[1]?.result })

  // Quo's log of what it sent this hook, joined to the receiver's by the webhook-id header.
  const heard = answered.filter(a => a.path === '/webhooks/quo')
  const all = (await listDeliveries(quo, hookId, { limit: 50 })).deliveries ?? []
  // Refused is not yet failed: Quo keeps retrying for about a day, and only then gives up.
  const withStatus = async (status: 'sending' | 'failed') => (await listDeliveries(quo, hookId, { status })).deliveries?.map(d => ({ isTheOneWeRefused: d.id === heard[0]?.webhookId, nextAttemptAt: typeof d.nextAttemptAt }))
  const whileRetrying = { sending: await withStatus('sending'), failed: await withStatus('failed') }
  await fetch(`${sink.url}/_sink/exhaust`, { method: 'POST' })
  t('deliveries.refusedIsSendingThenFailed', {
    whileRetrying,
    givenUp:     { sending: await withStatus('sending'), failed: await withStatus('failed') },
    newestFirst: all[0]?.id === heard[1]?.webhookId && all[1]?.id === heard[0]?.webhookId,
  })

  const oneMessage = await listDeliveries(quo, hookId, { resourceId: transient })
  const failures = await listDeliveries(quo, hookId, { eventType: ['message.failed', 'message.undelivered'], limit: 50 })
  const after = await listDeliveries(quo, hookId, { createdAt: { gt: beforeRotate } })
  const before = await listDeliveries(quo, hookId, { createdAt: { lt: beforeRotate }, limit: 50 })
  const asked = (await seen()).requests.filter(r => r.path.endsWith('/events')).map(r => [...new URLSearchParams(r.query).keys()].join('&'))
  t('deliveries.filtered', {
    oneMessage:  oneMessage.deliveries?.map(d => d.eventType),
    oneType:     (await listDeliveries(quo, hookId, { resourceId: transient, eventType: 'message.failed' })).deliveries?.map(d => d.eventType),
    failures:    failures.deliveries?.map(d => d.eventType),
    window:      { after: after.deliveries?.length, beforeHasNone: !before.deliveries?.some(d => after.deliveries?.some(a => a.id === d.id)), adds: (before.deliveries?.length ?? 0) + (after.deliveries?.length ?? 0) === all.length },
    asked:       asked.slice(-6),
  })

  const paged: string[] = []
  let cursor: string | null | undefined, pages = 0
  do {
    const p = await listDeliveries(quo, hookId, { limit: 3, ...(cursor ? { after: cursor } : {}) })
    paged.push(...(p.deliveries ?? []).map(d => d.id)); cursor = p.nextCursor; pages++
  } while (cursor && pages < 30)
  t('deliveries.pagedByCursor', { sameAsOnePage: JSON.stringify(paged) === JSON.stringify(all.map(d => d.id)), pages: pages === Math.ceil(all.length / 3), more: all.length > 3 })

  // A Quo retry is another attempt on the SAME delivery, not a second one.
  const refusedDetail = await getDelivery(quo, hookId, heard[0]?.webhookId ?? '')
  const twice = (await listDeliveries(quo, hookId, { resourceId: stop.id })).deliveries ?? []
  const twiceDetail = await getDelivery(quo, hookId, twice[0]?.id ?? '')
  const attempt = (a?: { status: string; responseStatusCode: number; triggerType: string }) => a && { status: a.status, responseStatusCode: a.responseStatusCode, triggerType: a.triggerType }
  t('delivery.detailHasAttempts', {
    refused:  { eventType: refusedDetail.delivery?.eventType, bodyIsTheEvent: (refusedDetail.delivery?.requestBody as { id?: string })?.id === refusedDetail.delivery?.eventId, attempts: refusedDetail.delivery?.attempts.map(attempt) },
    twice:    { deliveries: twice.length, attempts: twiceDetail.delivery?.attempts.length },
    unknown:  (await getDelivery(quo, hookId, 'msg_nosuchdelivery')).error?.kind,
  })

  // Refused at the rotation and given up on; with the key stored, one manual attempt applies it.
  const refusedId = heard[0]?.webhookId ?? ''
  const retriesAsked = async () => (await seen()).requests.filter(r => r.path.endsWith('/retry'))
  await ctl.reset(); answered.length = 0; inbox.length = 0
  const retriedOne = await retryDelivery(quo, hookId, refusedId)
  await until(() => answered.length > 0); await settle()
  t('delivery.retryAppliesWhatWasRefused', {
    error:       retriedOne.error ?? null,
    wire:        (await retriesAsked()).map(r => ({ path: r.path.replace(/msg_\w+/, 'msg_…'), version: r.version })),
    receiver:    answered.filter(a => a.webhookId === refusedId).map(a => a.result),
    applied:     inbox.filter(e => e.type === 'message.received').map(e => e.message?.text),
    attempts:    (await getDelivery(quo, hookId, refusedId)).delivery?.attempts.map(attempt),
    stillFailed: (await listDeliveries(quo, hookId, { status: 'failed' })).deliveries?.some(d => d.id === refusedId),
    unknown:     (await retryDelivery(quo, hookId, 'msg_nosuchdelivery')).error?.kind,
  })

  // The retry's answer is lost and conduit asks again: the second attempt carries the same webhook-id, so it is a duplicate.
  await ctl.reset(); answered.length = 0; inbox.length = 0
  await ctl.arm({ lost: true })
  const lostDelivery = await retryDelivery(quo, hookId, refusedId)
  await until(() => answered.length > 1); await settle()
  t('delivery.lostRetryIsReplayedHarmlessly', {
    error:    lostDelivery.error?.kind ?? null,
    asked:    (await retriesAsked()).length,
    receiver: answered.map(a => a.result),
    applied:  inbox.length,
  })

  // An outage: the app reads a stale key for a while. One refusal Quo has given up on, more than a page it is still
  // retrying, and one from before the window; one pass heals the window, oldest first.
  const texted = (text: string) => fetch(`${sink.url}/_sink/inbound`, { method: 'POST', body: JSON.stringify({ from: THEM, to: OURS, text }) })
  const exhaust = () => fetch(`${sink.url}/_sink/exhaust`, { method: 'POST' })
  const goodKey = stored.key
  stored.key = made.key!
  // A gap on each side of `outage`: the window's bounds are exclusive, and a millisecond tie falls outside both.
  await texted('before the window'); await exhaust(); await new Promise(r => setTimeout(r, 5))
  const outage = new Date().toISOString(); await new Promise(r => setTimeout(r, 5))
  // The failed one is older than the sending ones: across two statuses a tie has no order to keep.
  await texted('outage 0'); await exhaust(); await new Promise(r => setTimeout(r, 5))
  for (let i = 1; i <= QUO_MAX_PAGE + 1; i++) await texted(`outage ${i}`)
  stored.key = goodKey
  const log = (await seen()).deliveries.filter(d => d.hook === hookId && d.createdAt > outage)
  const owedBefore = { failed: log.filter(d => d.status === 'failed').length, sending: log.filter(d => d.status === 'sending').length }
  await ctl.reset(); answered.length = 0; inbox.length = 0
  const healed = await healDeliveries(quo, hookId, { since: outage })
  await until(() => answered.length >= log.length); await settle()
  const healAsked = (await seen()).requests
  const firstRetry = healAsked.findIndex(r => r.path.endsWith('/retry'))
  const owedAfter = async (status: 'sending' | 'failed') => (await listDeliveries(quo, hookId, { status, createdAt: { gt: outage } })).deliveries?.length
  const beforeWindow = (await listDeliveries(quo, hookId, { status: 'failed', createdAt: { lt: outage } })).deliveries ?? []
  t('deliveries.healedOldestFirstPastAPage', {
    owedBefore,
    retried:     healed.retried.length,
    unretried:   healed.unretried,
    listed:      healAsked.slice(0, firstRetry).map(r => { const q = new URLSearchParams(r.query); return `${q.get('status')}${q.has('after') ? '+after' : ''}` }),
    oldestFirst: JSON.stringify(healAsked.filter(r => r.path.endsWith('/retry')).map(r => r.path.split('/')[4])) === JSON.stringify(log.map(d => d.id)),
    applied:     JSON.stringify(inbox.map(e => e.message?.text)) === JSON.stringify(Array.from({ length: log.length }, (_, i) => `outage ${i}`)),
    owedAfter:   { sending: await owedAfter('sending'), failed: await owedAfter('failed') },
    beforeWindowLeft: beforeWindow.length,
  })

  // Quo's sample, to prove the receiver before live traffic: answered at once, delivered after, logged with no event or resource id.
  await ctl.reset(); answered.length = 0; inbox.length = 0
  const sinceTests = new Date().toISOString(); await new Promise(r => setTimeout(r, 5))
  const tested = await sendTestEvent(quo, hookId, 'call.completed')
  await until(() => answered.length > 0); await settle()
  const testLog = (await listDeliveries(quo, hookId, { eventType: 'call.completed', createdAt: { gt: sinceTests } })).deliveries ?? []
  const testsAsked = async () => (await seen()).requests.filter(r => r.path.endsWith('/events/test'))
  t('test.previewThenDelivered', {
    error:    tested.error ?? null,
    preview:  tested.event && { type: tested.event.type, apiVersion: tested.event.apiVersion, org: tested.event.data.context?.orgId },
    wire:     (await testsAsked()).map(r => ({ path: r.path, version: r.version, body: (r as { body?: string }).body })),
    // A sample verifies and is answered `ignored`: it has no row to write.
    receiver: answered.map(a => a.result), landed: inbox.length,
    logged:   testLog.map(d => ({ isTheOneHeard: d.id === answered[0]?.webhookId, eventId: d.eventId, resourceId: d.resourceId, status: d.status })),
    unknown:  (await sendTestEvent(quo, '999', 'call.completed')).error?.kind,
  })

  // Every test carries the same envelope id; deduping on it would swallow each test after the first.
  await ctl.reset(); answered.length = 0; inbox.length = 0
  const twoTests = [await sendTestEvent(quo, hookId, 'message.received'), await sendTestEvent(quo, hookId, 'message.received')]
  await until(() => answered.length > 1); await settle()
  t('test.eachDispatchIsItsOwnDelivery', {
    sameEnvelopeId: twoTests[0]!.event?.id === twoTests[1]!.event?.id && twoTests[0]!.event?.id === tested.event?.id,
    webhookIds:     new Set(answered.map(a => a.webhookId)).size,
    receiver:       answered.map(a => a.result),
    applied:        inbox.map(e => e.message?.text),
  })

  // The answer is lost and conduit asks again: a second sample, harmless.
  await ctl.reset(); answered.length = 0
  await ctl.arm({ lost: true })
  const lostTest = await sendTestEvent(quo, hookId, 'message.received')
  await until(() => answered.length > 1); await settle()
  t('test.lostAnswerIsReplayed', { error: lostTest.error?.kind ?? null, preview: lostTest.event?.type, asked: (await testsAsked()).length, receiver: answered.map(a => a.result) })

  // One webhook is its row in the list, and no more: the key is still create's alone.
  await ctl.reset()
  const one = await getWebhook(quo, hookId)
  const inList = (await listWebhooks(quo)).webhooks?.find(w => w.id === hookId)
  t('webhook.getIsTheListRow', {
    same:    JSON.stringify(one.webhook) === JSON.stringify(inList),
    hasKey:  'key' in (one.webhook ?? {}),
    wire:    (await seen()).requests.filter(r => r.path === `/webhooks/${hookId}`).map(r => ({ method: r.method, version: r.version })),
    unknown: (await getWebhook(quo, '999')).error?.kind,
  })

  // A PATCH: undefined is not sent, null is and clears, events replace the list, and the key stays.
  await ctl.reset()
  const keyBefore = sink.keyOf(hookId), hookBefore = one.webhook!
  await new Promise(r => setTimeout(r, 5))
  const relabeled = await updateWebhook(quo, hookId, { label: 'renamed', url: undefined })
  const unlabeled = await updateWebhook(quo, hookId, { label: null })
  const narrowed  = await updateWebhook(quo, hookId, { events: ['message.received'] })
  const patches   = (await seen()).requests.filter(r => r.method === 'PATCH').map(r => ({ path: r.path, version: r.version, body: (r as { body?: string }).body }))
  const restored  = await updateWebhook(quo, hookId, { events: hookBefore.events })
  t('webhook.updateChangesOnlyWhatIsGiven', {
    relabeled: { label: relabeled.webhook?.label, urlKept: relabeled.webhook?.url === hookBefore.url, eventsKept: relabeled.webhook?.events.length, updatedAtMoved: relabeled.webhook!.updatedAt > hookBefore.updatedAt },
    unlabeled: unlabeled.webhook?.label,
    narrowed:  narrowed.webhook?.events,
    wire:      patches,
    keyKept:   sink.keyOf(hookId) === keyBefore,
    restored:  restored.webhook?.events.length,
    unknown:   (await updateWebhook(quo, '999', { status: 'enabled' })).error?.kind,
  })

  // An empty number list is every number, not none; hearing nothing is disabled.
  await ctl.reset(); answered.length = 0; inbox.length = 0
  const hears = async (text: string) => {
    const n = answered.filter(a => a.path === '/webhooks/quo').length
    await fetch(`${sink.url}/_sink/inbound`, { method: 'POST', body: JSON.stringify({ from: THEM, to: OURS, text }) }); await settle()
    return answered.filter(a => a.path === '/webhooks/quo').length > n
  }
  await updateWebhook(quo, hookId, { resourceIds: ['PNelsewhere'] })
  const otherNumber = await hears('another number')
  const emptied = await updateWebhook(quo, hookId, { resourceIds: [] })
  const afterEmpty = await hears('every number')
  await updateWebhook(quo, hookId, { status: 'disabled' })
  const disabled = await hears('disabled')
  await updateWebhook(quo, hookId, { status: 'enabled', resourceIds: null })
  t('webhook.emptyNumbersIsEveryNumber', { otherNumber, emptied: emptied.webhook?.resourceIds, afterEmpty, disabled, enabledAgain: await hears('enabled') })

  // The answer is lost and conduit asks again: the same values, set twice.
  await ctl.reset(); await ctl.arm({ lost: true })
  const lostUpdate = await updateWebhook(quo, hookId, { label: 'drive' })
  t('webhook.lostUpdateIsReplayed', { error: lostUpdate.error?.kind ?? null, label: lostUpdate.webhook?.label, asked: (await seen()).requests.filter(r => r.method === 'PATCH').length })

  // The verifier alone: clock, tamper, a sender mid-rotation, the other generation's headers.
  const secret = stored.key, now = 1_700_000_000, body = JSON.stringify({ id: 'EV1', apiVersion: '2026-03-30', createdAt: 'x', type: 'message.received', data: { resource: { id: 'AC1' }, context: {} } })
  const escaped = body.replace('"AC1"', '"AC1", "text": "caf\\u00e9"')
  const v = (o: { ts?: number; sig?: string; raw?: string; key?: string }) => verifyQuoSignature({ rawBody: o.raw ?? body, headers: { 'webhook-id': 'msg_1', 'webhook-timestamp': String(o.ts ?? now), 'webhook-signature': o.sig ?? signQuo(secret, 'msg_1', o.ts ?? now, body) }, secret: o.key ?? secret, now }).ok
  t('verify.clockTamperRotation', {
    fresh:     v({}),
    stale:     v({ ts: now - 400 }),
    tampered:  v({ raw: body.replace('AC1', 'AC2') }),
    wrongKey:  v({ key: made.key }),
    rotating:  v({ sig: `${signQuo(made.key!, 'msg_1', now, body)} ${signQuo(secret, 'msg_1', now, body)}` }),
    // Bytes a re-serialization rewrites: an escape JSON.stringify would not write back.
    rawBytes:  v({ raw: escaped, sig: signQuo(secret, 'msg_1', now, escaped) }),
    legacyHeaderOnStandardPath: verifyQuoSignature({ rawBody: body, headers: {}, secret, now }).ok,
  })

  // ─── Mirror rows ───
  const models = Object.entries(mirror.models)
  t('mirror.claimShape', {
    provider: mirror.provider, models: models.map(([n]) => n),
    keys: models.every(([, m]) => m.key === 'externalId'), targets: models.every(([, m]) => m.target === QUO_TARGET),
    verbs: models.flatMap(([n, m]) => (['create', 'update', 'delete'] as const).filter(k => m[k]).map(k => `${n}.${k}`)),
  })

  const readRow = messageModel.parse(read.message!)
  t('mirror.messageRowFromTheRead', {
    key: readRow?.externalId === read.message?.id, conversation: /^CN/.test(readRow?.conversationExternalId ?? ''),
    phoneNumber: readRow?.phoneNumberExternalId === read.message?.phoneNumberId, user: readRow?.userExternalId,
    from: readRow?.from, to: readRow?.to, text: readRow?.text, media: readRow?.media,
    createdAt: readRow?.createdAt instanceof Date && readRow.createdAt.toISOString() === new Date(read.message!.createdAt).toISOString(),
    noQuoNames: ['conversationId', 'phoneNumberId', 'userId'].filter(k => readRow && k in readRow),
  })

  // The spec's own examples, since the sink lists no call, conversation or contact until 3.2.
  const quoCall: QuoCall = {
    id: 'AC123abc', phoneNumberId: 'PN123abc', actorId: 'US123abc', direction: 'incoming', status: 'completed',
    participants: [{ phoneNumber: '+15555555555', actorId: 'US123abc' }, { phoneNumber: '+15555555555', actorId: 'US456def' }, { phoneNumber: '+15555555556', actorId: null }],
    answeredAt: '2022-01-01T00:00:05Z', answeredBy: 'US123abc', initiatedBy: null, completedAt: '2022-01-01T00:01:00Z',
    createdAt: '2022-01-01T00:00:00Z', updatedAt: null, callRoute: 'phone-menu', duration: 55, forwardedFrom: null, forwardedTo: null, aiHandled: null,
  }
  t('mirror.callRow', shown(callModel.parse(quoCall)))
  const conversation: QuoConversation = {
    id: 'CN123abc', phoneNumberId: 'PN123abc', name: null, participants: ['+15555555556'], lastActivityId: 'AC123abc',
    lastActivityAt: '2022-01-01T00:01:00Z', mutedUntil: null, snoozedUntil: '2022-01-02T09:00:00Z', createdAt: '2021-12-31T00:00:00Z', updatedAt: '2022-01-01T00:01:00Z', deletedAt: null,
  }
  t('mirror.conversationRow', shown(conversationModel.parse(conversation)))
  const contact: QuoContact = {
    id: '6a145ff26212a192852c856e', externalId: '1234567890', source: 'public-api', sourceUrl: 'https://example.com/contacts/001',
    firstName: 'John', lastName: 'Doe', company: 'Quo', role: 'admin', actorId: 'US123abc', createdAt: '2021-01-01T00:00:00Z', updatedAt: '2021-01-01T00:00:00Z',
  }
  t('mirror.contactRow', shown(contactModel.parse(contact)))

  const blankMessage: QuoMessage = { ...read.message!, text: '', conversationId: '', phoneNumberId: null, userId: '', media: [{ url: 'https://files.quo.test/a.jpg', type: '' }, { url: '' }] }
  const blank = {
    message:      messageModel.parse(blankMessage),
    call:         callModel.parse({ ...quoCall, status: '', callRoute: '', forwardedTo: '', answeredAt: '', participants: [{ phoneNumber: '', actorId: null }, { phoneNumber: '+15555555556', actorId: '' }] }),
    conversation: conversationModel.parse({ ...conversation, name: '', lastActivityId: '', participants: ['', '+15555555556'] }),
    contact:      contactModel.parse({ ...contact, externalId: '', source: null, sourceUrl: '', firstName: '', lastName: undefined, company: '', role: '' }),
  }
  t('mirror.emptyIsNull', {
    message:      { text: blank.message?.text, conversation: blank.message?.conversationExternalId, phoneNumber: blank.message?.phoneNumberExternalId, user: blank.message?.userExternalId, media: blank.message?.media },
    call:         { status: blank.call?.status, callRoute: blank.call?.callRoute, forwardedTo: blank.call?.forwardedTo, answeredAt: blank.call?.answeredAt, participants: blank.call?.participants },
    conversation: { name: blank.conversation?.name, lastActivity: blank.conversation?.lastActivityExternalId, participants: blank.conversation?.participants },
    contact:      { sourceId: blank.contact?.sourceId, source: blank.contact?.source, sourceUrl: blank.contact?.sourceUrl, firstName: blank.contact?.firstName, lastName: blank.contact?.lastName, company: blank.contact?.company, role: blank.contact?.role },
  })

  // A message and a call are both `AC…`; only their shape says which.
  t('mirror.wrongNounIsNull', {
    messageOfCall:         messageModel.parse(quoCall as never),
    callOfMessage:         callModel.parse(read.message! as never),
    callOfConversation:    callModel.parse(conversation as never),
    conversationOfCall:    conversationModel.parse(quoCall as never),
    messageWithoutId:      messageModel.parse({ ...read.message!, id: '' }),
    contactWithoutId:      contactModel.parse({ ...contact, id: '' }),
    nothing:               [messageModel, callModel, conversationModel, contactModel].map(m => m.parse(null as never)),
    unreadableTime:        callModel.parse({ ...quoCall, completedAt: 'yesterday' })?.completedAt,
  })

  // ─── Backfill ───
  // Seeded rows are dated January 2026, before anything the drive made live.
  const seed = (rows: object) => fetch(`${sink.url}/_sink/seed`, { method: 'POST', body: JSON.stringify(rows) })
  const jan = (hour: number) => new Date(Date.UTC(2026, 0, 1, hour)).toISOString()
  const queried = async (path: string) => (await seen()).requests.filter(r => r.path === path).map(r => decodeURIComponent(r.query).replace(/after=[^&]+/, 'after=…'))
  const idsOf = (b: { rows: { externalId: string }[] }) => b.rows.map(r => r.externalId)

  await ctl.reset()
  await seed({ messages: [{ id: 'ACbefore', createdAt: jan(0) }, { id: 'ACat', createdAt: jan(1) }, { id: 'ACafter', createdAt: jan(2) }] })
  const msgs = await backfillMessages(quo, { since: jan(1) }), msgIds = idsOf(msgs)
  t('backfill.messagesSinceIsInclusive', {
    before: msgIds.includes('ACbefore'), at: msgIds.includes('ACat'), after: msgIds.includes('ACafter'),
    newestFirst: msgIds.indexOf('ACafter') < msgIds.indexOf('ACat'), rows: msgs.rows.every(r => r.createdAt instanceof Date),
    // The drive's live texts run past one page, so only the first is shown.
    truncated: msgs.truncated, resume: msgs.after, error: msgs.error ?? null, wire: (await queried('/messages'))[0],
  })

  await ctl.reset()
  await seed({ calls: [{ id: 'ACcallBefore', createdAt: jan(0) }, { id: 'ACcallAt', createdAt: jan(1) }] })
  const placed = await fetch(`${sink.url}/_sink/call`, { method: 'POST', body: JSON.stringify({ ours: OURS, theirs: THEM, direction: 'incoming', answered: true }) }).then(r => r.json()) as { id: string }
  const callPass = await backfillCalls(quo, { since: jan(1) }), callIds = idsOf(callPass)
  const placedRow = callPass.rows.find(r => r.externalId === placed.id)
  t('backfill.callsFromTheRead', {
    before: callIds.includes('ACcallBefore'), at: callIds.includes('ACcallAt'),
    placed: placedRow && { status: placedRow.status, answeredBy: placedRow.answeredByExternalId, participants: placedRow.participants.map(p => p.phoneNumber), answeredAt: placedRow.answeredAt instanceof Date },
    error: callPass.error ?? null, wire: await queried('/calls'),
  })

  await ctl.reset()
  const MOVED = '+14155550177', IDLE = '+14155550188'
  await seed({ conversations: [{ id: 'CNidle', participants: [IDLE], createdAt: jan(0) }, { id: 'CNmoved', participants: [MOVED], createdAt: jan(0) }] })
  const moved = await fetch(`${sink.url}/_sink/inbound`, { method: 'POST', body: JSON.stringify({ from: MOVED, to: OURS, text: 'still there?' }) }).then(r => r.json()) as { id: string }
  const convs = await backfillConversations(quo, { since: jan(1) })
  const times = convs.rows.map(r => r.updatedAt!.getTime())
  t('backfill.conversationsByChange', {
    idle: idsOf(convs).includes('CNidle'),
    moved: convs.rows.find(r => r.externalId === 'CNmoved')?.lastActivityExternalId === moved.id,
    oldestChangeFirst: times.every((x, i) => i === 0 || times[i - 1]! <= x),
    error: convs.error ?? null, wire: await queried('/conversations'),
  })

  await ctl.reset()
  await seed({ contacts: Array.from({ length: 120 }, (_, i) => ({ id: `ct${String(i).padStart(3, '0')}`, firstName: `Person ${i}` })) })
  const book = await backfillContacts(quo)
  t('backfill.contactsAreTheWholeBook', {
    rows: book.rows.length, distinct: new Set(idsOf(book)).size, truncated: book.truncated, resume: book.after,
    wire: await queried('/contacts'), properties: (await seen()).requests.filter(r => r.path.includes('/properties')).length,
    // The REST contact carries no lists, so its row leaves them out rather than clearing them.
    lists: book.rows.filter(r => 'phoneNumbers' in r || 'emails' in r).length,
  })


  await ctl.reset()
  const first = await backfillContacts(quo, { pages: 1 })
  const rest = await backfillContacts(quo, { after: first.after! })
  t('backfill.truncatedThenResumed', {
    first: { rows: first.rows.length, truncated: first.truncated, resume: typeof first.after },
    rest:  { rows: rest.rows.length, truncated: rest.truncated, resume: rest.after },
    whole: new Set([...idsOf(first), ...idsOf(rest)]).size, overlap: idsOf(rest).filter(id => idsOf(first).includes(id)).length,
  })

  await ctl.reset(); await ctl.arm({ lost: true })
  const lostPage = await backfillContacts(quo, { pages: 1 })
  t('backfill.lostPageIsReplayed', { error: lostPage.error?.kind ?? null, rows: lostPage.rows.length, asked: (await queried('/contacts')).length })

  await ctl.reset(); await ctl.arm({ forbidAfter: 1 })
  const broken = await backfillContacts(quo)
  const afterBreak = await backfillContacts(quo, { after: broken.after! })
  t('backfill.failureKeepsWhatWasRead', {
    error: broken.error?.kind, rows: broken.rows.length, truncated: broken.truncated, resume: typeof broken.after,
    resumed: { error: afterBreak.error ?? null, rows: afterBreak.rows.length, whole: new Set([...idsOf(broken), ...idsOf(afterBreak)]).size },
  })

  // ─── Contact properties ───
  // 54 properties, so the second phone number and the email are on the second page.
  await ctl.reset()
  await seed({ contacts: [{ id: 'ctprops', firstName: 'Paged', properties: [
    ...Array.from({ length: 49 }, (_, i) => ({ type: 'string', name: `Note ${i}`, value: `note ${i}` })),
    { type: 'phone-number', name: 'Mobile', value: THEM },
    { type: 'email', name: 'Work', value: 'paged@example.test' },
    { type: 'phone-number', name: 'Work', value: OTHER },
    { type: 'boolean', name: 'VIP', value: true },
    { type: 'phone-number', name: 'Old', value: '' },
  ] }] })
  const props = await getContactProperties(quo, 'ctprops')
  t('properties.everyPageInOneRow', { row: props.row ?? null, error: props.error ?? null, wire: await queried('/contacts/ctprops/properties') })

  await ctl.reset(); await ctl.arm({ forbidAfter: 1 })
  const half = await getContactProperties(quo, 'ctprops')
  const nobody = await getContactProperties(quo, 'ctnobody')
  t('properties.allOrNothing', { row: half.row ?? null, error: half.error?.kind, missing: nobody.error?.kind, missingRow: nobody.row ?? null })

  // ─── Mirror verbs ───
  // Bound as an app binds the claim and run through conduit's forward, which
  // throws a failure carrying the status junction answers.
  conduit.mirror(mirror)
  const people = conduit.mirrored('contact')!
  const failure = async (fn: () => Promise<unknown>) => { try { await fn(); return null } catch (e) { return { status: (e as { status?: number }).status ?? 'none', message: (e as Error).message } } }
  const status = async (fn: () => Promise<unknown>) => (await failure(fn))?.status ?? null
  const contactWrites = async () => (await seen()).requests.filter(r => r.path.startsWith('/contacts/') || (r.path === '/contacts' && r.method === 'POST'))
    .map(r => ({ method: r.method, path: r.path.replace(/^\/contacts\/.+$/, '/contacts/…'), version: r.version, body: r.body || null }))
  const inQuo = async (sourceId: string) => (await seen()).contacts.filter(c => c.externalId === sourceId).length

  await ctl.reset()
  const ada = await people.create!({ firstName: 'Ada', lastName: 'Lovelace', sourceId: 'crm-1', source: 'crm', sourceUrl: 'https://crm.test/1', actorExternalId: 'USdev' })
  const patched = await people.update!(String(ada?.externalId), { company: 'Analytical', lastName: null, role: undefined, starred: true })
  const removed = await people.remove!(String(ada?.externalId))
  t('mirror.contactCreatePatchDelete', {
    made: ada && { key: /^[0-9a-f]{24}$/.test(String(ada.externalId)), sourceId: ada.sourceId, source: ada.source, sourceUrl: ada.sourceUrl, actor: ada.actorExternalId, firstName: ada.firstName, lastName: ada.lastName, createdAt: ada.createdAt instanceof Date },
    patched: patched && { sameKey: patched.externalId === ada?.externalId, company: patched.company, lastName: patched.lastName, firstName: patched.firstName },
    removed, left: await inQuo('crm-1'), wire: await contactWrites(),
  })

  await ctl.reset()
  const grace = await people.create!({ firstName: 'Grace', sourceId: 'crm-2', source: 'crm' })
  const otherSource = await people.create!({ firstName: 'Grace', sourceId: 'crm-2', source: 'sheet' })
  t('mirror.contactSourcePairIsUnique', {
    twin: await status(() => people.create!({ firstName: 'Grace again', sourceId: 'crm-2', source: 'crm' })),
    otherSource: otherSource?.source, moveOntoTwin: await status(() => people.update!(String(otherSource?.externalId), { source: 'crm' })),
    graces: await inQuo('crm-2'), first: grace?.firstName,
  })

  await ctl.reset(); await ctl.arm({ lost: true })
  const lostCreate = await failure(() => people.create!({ firstName: 'Lin', sourceId: 'crm-3', source: 'crm' }))
  const createsSent = (await contactWrites()).length
  t('mirror.contactLostCreateIsNotReplayed', {
    status: lostCreate?.status, mayHaveLanded: /may have been applied/.test(lostCreate?.message ?? ''), sent: createsSent,
    retry: await status(() => people.create!({ firstName: 'Lin', sourceId: 'crm-3', source: 'crm' })), lins: await inQuo('crm-3'),
  })

  await ctl.reset(); await ctl.arm({ lost: true })
  const lostPatch = await people.update!(String(grace?.externalId), { role: 'admiral' }).catch(e => (e as Error).message)
  t('mirror.contactLostPatchIsReplayed', { role: typeof lostPatch === 'object' ? lostPatch?.role : lostPatch, sent: (await contactWrites()).length })

  await ctl.reset(); await ctl.arm({ lost: true })
  const lostDelete = await status(() => people.remove!(String(grace?.externalId)))
  t('mirror.contactLostDeleteIsDone', { status: lostDelete, sent: (await contactWrites()).map(w => w.method), gone: (await seen()).contacts.every(c => c.id !== grace?.externalId) })

  await ctl.reset()
  t('mirror.contactRefusedBeforeSending', {
    noFirstName:   await status(() => people.create!({ lastName: 'Nobody' })),
    nullFirstName: await status(() => people.create!({ firstName: null })),
    notAUser:      await status(() => people.create!({ firstName: 'A', actorExternalId: 'PNour0001' })),
    notAUri:       await status(() => people.create!({ firstName: 'A', sourceUrl: 'crm record 1' })),
    longUri:       await status(() => people.update!(String(otherSource?.externalId), { sourceUrl: `https://crm.test/${'a'.repeat(200)}` })),
    notAString:    await status(() => people.update!(String(otherSource?.externalId), { company: 5 })),
    noKeyUpdate:   await status(() => people.update!('', { company: 'x' })),
    noKeyDelete:   await status(() => people.remove!('')),
    reached: (await seen()).requests.length,
  })

  // ─── Receive writes rows ───
  // Two subscriptions share one event id and each delivery has its own
  // webhook-id, so each applies; deduping on the event id applies the first alone.
  await updateWebhook(quo, hookId, { resourceIds: ['*'], status: 'enabled' })
  const second = await createWebhook(quo, { url: hookUrl.replace(/quo$/, 'quo-2'), events: ['message.received'] })
  stored2.key = second.key ?? ''
  await ctl.reset(); answered.length = 0; inbox.length = 0
  await fetch(`${sink.url}/_sink/inbound`, { method: 'POST', body: JSON.stringify({ from: THEM, to: OURS, text: 'twice over' }) })
  await settle()
  t('receive.eachSubscriptionApplies', {
    receiver: answered.filter(a => a.path !== '/webhooks/quo-legacy').map(a => `${a.path} ${a.result}`).sort(),
    oneMessage: new Set(inbox.filter(e => e.message).map(e => e.message!.externalId)).size,
  })
  await deleteWebhook(quo, second.webhook!.id)

  // Contact events are workspace-wide: a hook narrowed to another number still hears them.
  await updateWebhook(quo, hookId, { events: ['message.received', 'contact.updated', 'contact.deleted'], resourceIds: ['PNelsewhere0001'] })
  await ctl.reset(); answered.length = 0; inbox.length = 0
  const hopper = await people.create!({ firstName: 'Grace', lastName: 'Hopper', sourceId: 'crm-9', source: 'crm', sourceUrl: 'https://crm.test/9', actorExternalId: 'USdev' })
  // A person adds her number in Quo; the connector has no property verb.
  await fetch(`${sink.url}/contacts/${hopper?.externalId}/properties`, { method: 'POST', headers: { authorization: KEY, 'quo-api-version': '2026-03-30', 'content-type': 'application/json' }, body: JSON.stringify({ type: 'phone-number', name: 'Mobile', value: '+14155550123' }) })
  await people.update!(String(hopper?.externalId), { lastName: null, company: 'Navy' })
  await people.remove!(String(hopper?.externalId))
  await settle()
  const [made9, numbered9, patched9, gone9] = inbox.map(e => e.contact)
  t('receive.contactEventsAreRows', {
    types:   inbox.map(e => e.type),
    sameKey: inbox.every(e => e.contact?.externalId === hopper?.externalId),
    // The webhook's contact has no actor and no source URL, so its row leaves both to the read.
    columns: made9 && Object.keys(made9).sort(),
    made:    made9 && { sourceId: made9.sourceId, source: made9.source, lastName: made9.lastName, createdAt: made9.createdAt instanceof Date, phoneNumbers: made9.phoneNumbers, emails: made9.emails },
    numbered: numbered9?.phoneNumbers,
    // A contact resource is whole, so a null it carries clears.
    patched: patched9 && { lastName: patched9.lastName, company: patched9.company, firstName: patched9.firstName },
    gone:    gone9 && { company: gone9.company, phoneNumbers: gone9.phoneNumbers },
    beside:  inbox.map(e => [e.external, e.conversationExternalId, e.message, e.call, e.contactExternalIds]).flat().every(x => x === null),
  })

  // `message.failed` names no media, so its row leaves the read's media alone. The spec's own example.
  const failed = parseQuoEvent({ id: 'EVfailed', apiVersion: '2026-03-30', createdAt: '2026-04-13T12:00:00.000Z', type: 'message.failed', data: {
    resource: { id: 'AC-message', direction: 'outgoing', text: 'hello', status: 'failed', errorCode: '30006', createdAt: '2026-04-13T12:00:00.000Z' },
    context: { orgId: 'OR123', phoneNumberId: 'PN123', conversationId: 'CN123', userId: 'US123', contacts: { ids: ['CT123'], lookupStatus: 'matched' }, senderIdentifier: '+15550002222', recipientIdentifiers: ['+15550001111'] } } }, 'standard')
  t('receive.failedMessageCarriesNoMedia', {
    columns: failed.payload.message && Object.keys(failed.payload.message).sort(),
    errorCode: failed.payload.errorCode, external: failed.payload.external, conversation: failed.payload.conversationExternalId,
    contacts: failed.payload.contactExternalIds,
  })

  // Quo's own match of the other side's number, beside the row. `ringing` is
  // sent before the lookup and legacy makes none, so both are null, unknown.
  await updateWebhook(quo, hookId, { events: ['message.received', 'call.ringing', 'call.completed'], resourceIds: ['*'] })
  await seed({ contacts: [{ id: 'ctthem', firstName: 'Them', properties: [{ type: 'phone-number', value: '+14155550177' }] }] })
  await ctl.reset(); answered.length = 0; inbox.length = 0
  for (const from of ['+14155550177', '+14155550178']) await fetch(`${sink.url}/_sink/inbound`, { method: 'POST', body: JSON.stringify({ from, to: OURS, text: 'who is this' }) })
  for (const unresolved of [false, true]) await fetch(`${sink.url}/_sink/call`, { method: 'POST', body: JSON.stringify({ ours: OURS, theirs: '+14155550177', direction: 'incoming', answered: true, unresolved }) })
  await settle()
  const ids = (type: string) => inbox.filter(e => e.type === type).map(e => e.contactExternalIds)
  const unknown = parseQuoEvent({ id: 'EVunknown', apiVersion: '2026-03-30', createdAt: '2026-04-13T12:00:00.000Z', type: 'message.received', data: {
    resource: { id: 'AC-unknown', direction: 'incoming', text: 'hi', status: 'received', createdAt: '2026-04-13T12:00:00.000Z' },
    context: { orgId: 'OR123', phoneNumberId: 'PN123', conversationId: 'CN123', userId: 'US123', contacts: { ids: [], lookupStatus: 'unavailable' }, senderIdentifier: '+15550002222', recipientIdentifiers: ['+15550001111'] } } }, 'standard')
  t('receive.contactIdsBesideTheRow', {
    texts: ids('message.received'), legacyTexts: ids('legacy:message.received'),
    ringing: ids('call.ringing'), completed: ids('call.completed'), unavailable: unknown.payload.contactExternalIds,
  })

  // ─── Call artifacts ───
  // A recorded call in two pieces, and a missed one with a voicemail. Every
  // event names the call by `callId`; the read answers the same files.
  await updateWebhook(quo, hookId, { events: ['call.completed', 'call.recording.completed', 'call.transcript.completed', 'call.summary.completed', 'call.voicemail.completed'], resourceIds: ['*'] })
  type Files = { files: Record<string, string>; fileHits: { name: string; auth: string | null; version: string | null; status: number }[] }
  const store = async () => (await seen()) as unknown as Files
  const nameOf = (url: string | null | undefined) => new URL(String(url)).pathname.split('/').pop()!
  const sameBytes = async (url: string | null | undefined) => {
    const got = await fileBytes(quo, String(url))
    return !!got.bytes && Buffer.from(got.bytes).toString('base64') === (await store()).files[nameOf(url)]
  }
  const recorded = await call({ direction: 'incoming', answered: true, segments: 2 })
  const recEvent = recorded.of('call.recording.completed')
  t('artifacts.recordingEventRows', {
    call:     recEvent?.call?.externalId === recorded.id,
    count:    recEvent?.recordings?.length,
    keyed:    recEvent?.recordings?.every(r => r.callExternalId === recorded.id && /^CR./.test(r.externalId)),
    columns:  recEvent?.recordings?.[0] && Object.keys(recEvent.recordings[0]).sort(),
    startTime: recEvent?.recordings?.every(r => r.startTime instanceof Date),
    elsewhere: inbox.filter(e => e.type !== 'call.recording.completed').every(e => e.recordings === null),
  })

  await ctl.reset()
  const recs = await getCallRecordings(quo, recorded.id)
  t('artifacts.recordingsFromTheRead', {
    sameAsTheEvent: JSON.stringify(recs.rows.map(r => r.externalId)) === JSON.stringify(recEvent?.recordings?.map(r => r.externalId)),
    oldestFirst:  recs.rows.length === 2 && recs.rows[0]!.startTime!.getTime() < recs.rows[1]!.startTime!.getTime(),
    status:       recs.rows.map(r => r.status), columns: recs.rows[0] && Object.keys(recs.rows[0]).sort(), error: recs.error ?? null,
    wire:         (await seen()).requests.map(r => ({ path: r.path.replace(recorded.id, 'AC…'), query: decodeURIComponent(r.query), version: r.version })),
  })

  await ctl.reset()
  const audio = await fileBytes(quo, recs.rows[0]!.url!)
  const both = [audio.bytes && Buffer.from(audio.bytes).toString('base64') === (await store()).files[nameOf(recs.rows[0]!.url)], await sameBytes(recs.rows[1]!.url)]
  const hits = (await store()).fileHits
  t('artifacts.bytesMatch', { same: both, type: audio.type, key: hits.map(h => h.auth), version: hits.map(h => h.version), toTheApi: (await seen()).requests.length })

  await ctl.reset(); await ctl.arm({ expireFiles: true })
  const expired = await fileBytes(quo, recs.rows[0]!.url!)
  const fresh = (await getCallRecordings(quo, recorded.id)).rows[0]
  t('artifacts.expiredUrlIsGone', { kind: expired.error?.kind, retryable: expired.error?.retryable, again: await sameBytes(fresh?.url), fetches: (await store()).fileHits.map(h => h.status) })

  const smEvent = recorded.of('call.summary.completed'), smLegacy = recorded.of('legacy:call.summary.completed', recorded.legacy)
  const readCall = await getCall(quo, recorded.id)
  const pick = (row: object | null | undefined, keys: string[]) => row && Object.fromEntries(keys.map(k => [k, (row as Record<string, unknown>)[k]]))
  const SUMMARY = ['summaryStatus', 'summaryType', 'summary', 'nextSteps', 'summaryTitle', 'summaryJobs']
  t('artifacts.summaryOnTheCallRow', {
    event:   { keyed: smEvent?.call?.externalId === recorded.id, columns: smEvent?.call && Object.keys(smEvent.call).sort(), jobs: smEvent?.call?.summaryJobs, external: smEvent?.external },
    read:    pick(readCall.row, SUMMARY),
    noVoicemail: pick(readCall.row, ['voicemailExternalId', 'voicemailUrl']),
    legacy:  { keyed: smLegacy?.call?.externalId === recorded.id, columns: smLegacy?.call && Object.keys(smLegacy.call).sort() },
  })

  const trEvent = recorded.of('call.transcript.completed'), trLegacy = recorded.of('legacy:call.transcript.completed', recorded.legacy)
  const trRead = await getCallTranscripts(quo, recorded.id)
  t('artifacts.transcriptBesideTheEvent', {
    event:   { call: trEvent?.call ?? null, callId: trEvent?.transcript?.callExternalId === recorded.id, segment: trEvent?.transcript && 'recordingExternalId' in trEvent.transcript, lines: trEvent?.transcript?.dialogue?.length, first: trEvent?.transcript?.dialogue?.[0], status: trEvent?.transcript?.status },
    read:    { segments: trRead.transcripts?.map(x => x.recordingExternalId) .join() === recs.rows.map(r => r.externalId).join(), lines: trRead.transcripts?.map(x => x.dialogue?.length), theirs: trRead.transcripts?.[0]?.dialogue?.[1], startTime: trRead.transcripts?.every(x => x.startTime instanceof Date) },
    legacySame: JSON.stringify(trLegacy?.transcript?.dialogue) === JSON.stringify(trEvent?.transcript?.dialogue),
  })

  await ctl.reset(); await ctl.arm({ forbidAfter: 0 })
  const trFailed = await getCallTranscripts(quo, recorded.id)
  t('artifacts.transcriptsAllOrNothing', { transcripts: trFailed.transcripts ?? null, kind: trFailed.error?.kind })

  const left = await call({ direction: 'incoming', answered: false, voicemail: true })
  const vmEvent = left.of('call.voicemail.completed'), vmLegacy = left.of('legacy:call.completed', left.legacy)
  const vmRead = await getCall(quo, left.id)
  t('artifacts.voicemailOnTheCallRow', {
    event:  { keyed: vmEvent?.call?.externalId === left.id, columns: vmEvent?.call && Object.keys(vmEvent.call).sort(), duration: vmEvent?.call?.voicemailDuration, external: vmEvent?.external, conversation: /^CN/.test(vmEvent?.conversationExternalId ?? '') },
    read:   { status: vmRead.row?.voicemailStatus, sameVoicemail: vmRead.row?.voicemailExternalId === vmEvent?.call?.voicemailExternalId && /^VM/.test(vmRead.row?.voicemailExternalId ?? ''), sameUrl: vmRead.row?.voicemailUrl === vmEvent?.call?.voicemailUrl, transcript: vmRead.row?.voicemailTranscript },
    bytes:  await sameBytes(vmRead.row?.voicemailUrl),
    legacy: { url: vmLegacy?.call?.voicemailUrl === vmEvent?.call?.voicemailUrl, duration: vmLegacy?.call?.voicemailDuration, ringing: left.of('legacy:call.ringing', left.legacy)?.call && 'voicemailUrl' in left.of('legacy:call.ringing', left.legacy)!.call! },
  })

  // A read that asked and found no voicemail says so; one that did not ask says nothing.
  const pass = await backfillCalls(quo, { since: new Date(Date.now() - 60_000).toISOString() })
  const withSections = pass.rows.find(r => r.externalId === recorded.id)
  t('artifacts.absentUnlessAsked', {
    asked:    { voicemailUrl: withSections && 'voicemailUrl' in withSections ? withSections.voicemailUrl : 'absent', summaryStatus: withSections?.summaryStatus },
    voicemail: pass.rows.find(r => r.externalId === left.id)?.voicemailStatus,
    notAsked: Object.keys(callModel.parse({ ...quoCall }) ?? {}).filter(k => /voicemail|summary|nextSteps/i.test(k)),
  })

  // Inbox state: set by a mark, shown on no answer, so the sink's own record is the witness.
  type Inbox = Record<string, { unread: boolean; status: string }>
  const stateOf = async (id: string) => ((await seen()) as unknown as { inbox: Inbox }).inbox[id] ?? null
  const textIn = async (from: string) => {
    const { id } = await fetch(`${sink.url}/_sink/inbound`, { method: 'POST', body: JSON.stringify({ from, to: OURS, text: 'are you open?' }) }).then(r => r.json()) as { id: string }
    return ((await seen()) as unknown as { messages: QuoMessage[] }).messages.find(m => m.id === id)!.conversationId
  }
  await ctl.reset()
  const convId = await textIn('+14155550166')
  const arrived = await stateOf(convId)
  const marked = await markRead(quo, convId), afterRead = await stateOf(convId)
  const done = await markDone(quo, convId), afterDone = await stateOf(convId)
  const open = await markOpen(quo, convId), afterOpen = await stateOf(convId)
  const marks = (await seen()).requests.filter(r => r.path.includes('/mark-as-'))
  t('inbox.marksSetWhatTheyName', {
    arrived, afterRead, afterDone, afterOpen,
    answers: [marked, done, open].map(r => r.row?.externalId === convId && !r.error),
    stateless: [marked, done, open].every(r => r.row && Object.keys(r.row).every(k => !/unread|read|done|open|inbox/i.test(k))),
    wire: marks.map(r => ({ method: r.method, path: r.path.replace(convId, 'CN…'), version: r.version, body: r.body })),
  })

  await ctl.reset()
  const filed = await sendMessage(quo, { from: OURS, to: '+14155550166', text: 'filed', setInboxStatus: 'done' })
  t('inbox.sendFilesDone', { sent: filed.message?.conversationId === convId, state: await stateOf(convId) })

  // The answer is lost and conduit asks again: the same state, set twice.
  await markOpen(quo, convId)
  await ctl.reset(); await ctl.arm({ lost: true })
  const lostMark = await markDone(quo, convId)
  t('inbox.lostMarkIsReplayed', { error: lostMark.error?.kind ?? null, row: lostMark.row?.externalId === convId, state: await stateOf(convId), asked: (await seen()).requests.filter(r => r.path.includes('/mark-as-')).length })

  const nowhere = await markRead(quo, 'CNnowhere')
  t('inbox.unknownConversationIsGone', { kind: nowhere.error?.kind, row: nowhere.row ?? null })

  // ─── Tasks ───
  // Every task write answers `{ taskId, revision }` alone, and its event lands
  // before the answer does: each row holds what it knows, so neither clears the other.
  const taskHook = await createWebhook(quo, { url: hookUrl.replace(/quo$/, 'quo-tasks'), events: QUO_EVENT_TYPES.filter(e => e.startsWith('task.')) })
  stored3.key = taskHook.key ?? ''
  const taskConv = await textIn('+14155550177'), otherConv = await textIn('+14155550178')
  const todo = conduit.mirrored('task')!
  const taskIds: Record<string, string> = {}
  // Ids and times as names, so a row reads the same on every run.
  const mask = (v: unknown): unknown => v === undefined ? null : JSON.parse(Object.entries({ ...taskIds, [taskConv]: 'CN·task', [otherConv]: 'CN·other' })
    .reduce((s, [id, name]) => s.replaceAll(id, name), JSON.stringify(v, function (this: Record<string, unknown>, k, x) { return this[k] instanceof Date ? `Date ${(this[k] as Date).toISOString()}` : x })))
  const taskEvents = () => mask(inbox.filter(e => e.type.startsWith('task:')).map(e => ({ type: e.type.slice('task:'.length), conversation: e.conversationExternalId, row: e.task })))
  const taskWire = async () => mask((await seen()).requests.filter(r => r.path.startsWith('/tasks')).map(r => ({ method: r.method, path: r.path, body: r.body ? JSON.parse(r.body) : null })))
  const DUE = '2026-11-02T17:00:00.000Z'

  await ctl.reset(); inbox.length = 0
  const task1 = await todo.create!({ title: 'Call back', description: 'About pricing', conversationExternalId: taskConv, dueDate: new Date(DUE), assignedToExternalId: 'USdev' })
  taskIds[String(task1?.externalId)] = 'TK·1'
  const createdEvent = inbox.find(e => e.type === 'task:task.created')?.task
  t('tasks.createLandsWhatItSent', {
    answer: mask(task1), event: taskEvents(), wire: await taskWire(),
    // Upserted in either order, the two agree on every column both name.
    agree: Object.keys(task1 ?? {}).filter(k => createdEvent && k in createdEvent).every(k => JSON.stringify(mask((task1 as Record<string, unknown>)[k])) === JSON.stringify(mask((createdEvent as Record<string, unknown>)[k]))),
  })

  await ctl.reset()
  const task1Read = await getTask(quo, String(task1?.externalId))
  t('tasks.readIsWhole', { row: mask(task1Read.row && { ...task1Read.row, createdAt: typeof task1Read.row.createdAt?.toISOString() }), columns: Object.keys(task1Read.row ?? {}).length, wire: await taskWire() })

  await ctl.reset(); inbox.length = 0
  const renamedAnswer = await todo.update!(String(task1?.externalId), { title: 'Call back today', description: 'About pricing', starred: true })
  t('tasks.updateSendsBoth', { answer: mask(renamedAnswer), event: taskEvents(), wire: await taskWire() })

  await ctl.reset()
  const taskKey = String(task1?.externalId)
  t('tasks.refusedBeforeSending', {
    titleAlone:      await status(() => todo.update!(taskKey, { title: 'x' })),
    statusInPatch:   (await failure(() => todo.update!(taskKey, { title: 'x', description: 'y', status: 'completed' })))?.message.includes('setTaskStatus'),
    noDescription:   await status(() => todo.create!({ title: 'x', conversationExternalId: taskConv })),
    notAConversation: await status(() => todo.create!({ title: 'x', description: '', conversationExternalId: 'PNour0001' })),
    systemAssignee:  await status(() => todo.create!({ title: 'x', description: '', conversationExternalId: taskConv, assignedToExternalId: 'SYU1' })),
    notATaskKey:     await status(() => todo.remove!('AC123')),
    badStatus:       await setTaskStatus(quo, taskKey, 'done' as never).then(() => false, e => /not a task status/.test(e.message)),
    notATask:        await getTask(quo, 'TK').then(() => false, e => /not a task id/.test(e.message)),
    badDue:          await setTaskDueDate(quo, taskKey, 'next week').then(() => false, e => /not a time/.test(e.message)),
    assignNotUser:   await assignTask(quo, taskKey, 'SYU1').then(() => false, e => /not a user id/.test(e.message)),
    linkNotConversation: await linkTask(quo, taskKey, 'AC1').then(() => false, e => /not a conversation id/.test(e.message)),
    reached: (await seen()).requests.length,
  })

  await ctl.reset(); inbox.length = 0
  const completedAnswer = await setTaskStatus(quo, taskKey, 'completed'), reopenedAnswer = await setTaskStatus(quo, taskKey, 'open')
  const removed1 = await todo.remove!(taskKey), removed2 = await todo.remove!(taskKey)
  t('tasks.statusAndDelete', {
    answers: mask([completedAnswer.row, reopenedAnswer.row, removed1, removed2]), event: taskEvents(),
    stillRead: (await getTask(quo, taskKey)).row?.status, wire: await taskWire(),
  })

  await ctl.reset(); inbox.length = 0
  const task2 = await todo.create!({ title: 'Send quote', description: '', conversationExternalId: taskConv })
  taskIds[String(task2?.externalId)] = 'TK·2'
  const k2 = String(task2?.externalId)
  inbox.length = 0; await ctl.reset()
  const taskSteps = [
    await linkTask(quo, k2, otherConv), await unlinkTask(quo, k2, otherConv),
    await assignTask(quo, k2, 'USamy'), await unassignTask(quo, k2, 'USamy'),
    await setTaskDueDate(quo, k2, DUE), await setTaskDueDate(quo, k2, null),
  ]
  t('tasks.eachCallAndItsEvent', { answers: mask(taskSteps.map(r => r.error ?? r.row)), events: taskEvents(), wire: await taskWire() })

  await linkTask(quo, k2, otherConv)
  await ctl.reset(); await ctl.arm({ lost: true })
  const lostUnlink = await unlinkTask(quo, k2, otherConv)
  const unlinksSent = (await seen()).requests.filter(r => r.method === 'DELETE').length
  await ctl.reset(); await ctl.arm({ lost: true })
  const lostAssign = await assignTask(quo, k2, 'USamy')
  const assignsSent = (await seen()).requests.length
  await ctl.reset(); await ctl.arm({ lost: true })
  const lostRename = await todo.update!(k2, { title: 'Send the quote', description: '' }).catch(e => (e as Error).message)
  const renamesSent = (await seen()).requests.length
  // No key: a replayed create that landed is a second task, so a lost one is left open.
  await ctl.reset(); await ctl.arm({ lost: true })
  const lostTaskCreate = await failure(() => todo.create!({ title: 'Lost', description: '', conversationExternalId: taskConv }))
  const taskCreatesSent = (await seen()).requests.length
  for (const x of ((await seen()) as unknown as { tasks: { taskId: string; title: string }[] }).tasks) if (x.title === 'Lost') taskIds[x.taskId] = 'TK·lost'
  t('tasks.lostWriteIsReplayed', {
    unlink: { error: lostUnlink.error?.kind ?? null, row: mask(lostUnlink.row), sent: unlinksSent },
    assign: { error: lostAssign.error?.kind ?? null, row: mask(lostAssign.row), sent: assignsSent },
    update: { title: typeof lostRename === 'object' ? lostRename?.title : lostRename, sent: renamesSent },
    create: { status: lostTaskCreate?.status, open: /may have been applied/.test(lostTaskCreate?.message ?? ''), sent: taskCreatesSent },
    held: mask((await getTask(quo, k2)).row && { conversation: (await getTask(quo, k2)).row!.conversationExternalId, assignee: (await getTask(quo, k2)).row!.assignedToExternalId }),
  })

  await setTaskStatus(quo, k2, 'completed')
  await ctl.reset(); await ctl.arm({ openTasksFull: true })
  const reopenFull = await setTaskStatus(quo, k2, 'open')
  // Through a claim verb the Provider's own reason still reaches the caller: conduit's forward appends the 4xx body to its status line (FJS-3411).
  const fullCreate = await failure(() => todo.create!({ title: 'One too many', description: '', conversationExternalId: taskConv }))
  t('tasks.openLimitIsQuota', { reopen: { kind: reopenFull.error?.kind, retryable: reopenFull.error?.retryable, row: reopenFull.row ?? null }, create: { status: fullCreate?.status, named: /Open Tasks Limit/.test(fullCreate?.message ?? '') } })

  await ctl.reset(); inbox.length = 0
  const lateTask = await todo.create!({ title: 'Overdue', description: '', conversationExternalId: otherConv, dueDate: '2026-01-05T09:00:00.000Z' })
  taskIds[String(lateTask?.externalId)] = 'TK·3'
  inbox.length = 0
  await fetch(`${sink.url}/_sink/overdue`, { method: 'POST' })
  const taskBook = await backfillTasks(quo)
  t('tasks.overdueAndTheWholeBook', {
    event: taskEvents(),
    book: { error: taskBook.error ?? null, truncated: taskBook.truncated, rows: mask(taskBook.rows.map(r => [r.externalId, r.status, Object.keys(r).length])) },
  })

  // ─── Phone numbers ───
  // No event reports a number: every row is a read's, and each read fills only the columns it carries.
  const PN = 'PNour0001'
  const numberWire = async () => (await seen()).requests.filter(r => r.path.startsWith('/phone-numbers'))
    .map(r => ({ method: r.method, path: r.path, query: decodeURIComponent(r.query), body: r.body ? JSON.parse(r.body) : null }))
  const line = conduit.mirrored('phoneNumber')!

  await ctl.reset()
  const numberRead = await getPhoneNumber(quo, PN)
  t('numbers.readIsWhole', { row: shown(numberRead.row), wire: await numberWire() })

  await ctl.reset()
  // conduit's forward throws a local refusal before any promise exists, so `.then` is what catches it.
  const renamedLine = await Promise.resolve().then(() => line.update!(PN, { name: 'Front desk', businessHours: { enabled: true, timezone: 'America/New_York', schedule: { monday: { start: '0900', end: '1700' }, sunday: null } }, starred: true })).catch(e => ({ name: (e as Error).message })) as unknown as PhoneNumberRow
  const clearedLine = await Promise.resolve().then(() => line.update!(PN, { businessHours: { schedule: null } })).catch(e => ({ businessHours: (e as Error).message })) as unknown as PhoneNumberRow
  t('numbers.updateThroughTheClaim', {
    renamed: { name: renamedLine?.name, businessHours: renamedLine?.businessHours, restrictions: !!renamedLine && 'restrictions' in renamedLine, moved: renamedLine?.updatedAt instanceof Date && !!numberRead.row?.updatedAt && renamedLine.updatedAt > numberRead.row.updatedAt },
    cleared: clearedLine?.businessHours, wire: await numberWire(),
  })

  await ctl.reset()
  t('numbers.refusedBeforeSending', {
    notANumber:      await getPhoneNumber(quo, 'available').then(() => false, e => /not a phone number id/.test(e.message)),
    empty:           await status(() => line.update!(PN, { starred: true })),
    nameCleared:     await status(() => line.update!(PN, { name: null })),
    nameTooLong:     await status(() => line.update!(PN, { name: 'x'.repeat(501) })),
    hoursEmpty:      await status(() => line.update!(PN, { businessHours: {} })),
    scheduleEmpty:   await status(() => line.update!(PN, { businessHours: { schedule: {} } })),
    notADay:         (await failure(() => line.update!(PN, { businessHours: { schedule: { mon: null } } })))?.message.includes('not a weekday'),
    badWindow:       await status(() => line.update!(PN, { businessHours: { schedule: { monday: { start: '9:00', end: '1700' } } } })),
    notIana:         (await failure(() => line.update!(PN, { businessHours: { timezone: '+05:00' } })))?.message.includes('IANA'),
    settingInPatch:  (await failure(() => line.update!(PN, { name: 'x', autoRecord: true })))?.message.includes('updatePhoneNumberSettings'),
    quoSetsIt:       (await failure(() => line.update!(PN, { forward: '+14155550100' })))?.message.includes('does not write it'),
    settingsEmpty:   await updatePhoneNumberSettings(quo, PN, {}).then(() => false, e => /names autoRecord or callDisclosure/.test(e.message)),
    disclosureEmpty: await updatePhoneNumberSettings(quo, PN, { callDisclosure: {} }).then(() => false, e => /inbound or outbound/.test(e.message)),
    badDisclosure:   await updatePhoneNumberSettings(quo, PN, { callDisclosure: { inbound: 'beep' as never } }).then(() => false, e => /not a call disclosure/.test(e.message)),
    membersNotANumber: await getPhoneNumberMembers(quo, 'US1').then(() => false, e => /not a phone number id/.test(e.message)),
    tooMany:         await availablePhoneNumbers(quo, { limit: 101 }).then(() => false, e => /1–100/.test(e.message)),
    reached: (await seen()).requests.length,
  })

  await ctl.reset()
  const settingsBefore = await getPhoneNumberSettings(quo, PN)
  const settingsAfter = await updatePhoneNumberSettings(quo, PN, { autoRecord: true, callDisclosure: { inbound: 'voice', outbound: undefined } })
  t('numbers.settingsAreTheirOwnRead', { before: settingsBefore.row ?? settingsBefore.error, after: settingsAfter.row ?? settingsAfter.error, wire: await numberWire() })

  await ctl.reset(); await ctl.arm({ lost: true })
  const lostLineName = await line.update!(PN, { name: 'Front desk' }).catch(e => (e as Error).message) as PhoneNumberRow | string
  const lineNamesSent = (await seen()).requests.length
  await ctl.reset(); await ctl.arm({ lost: true })
  const lostSettings = await updatePhoneNumberSettings(quo, PN, { autoRecord: false })
  const settingsSent = (await seen()).requests.length
  t('numbers.lostWriteIsReplayed', {
    rename: { name: typeof lostLineName === 'object' ? lostLineName?.name : lostLineName, sent: lineNamesSent },
    settings: { error: lostSettings.error?.kind ?? null, autoRecord: lostSettings.row?.autoRecord, sent: settingsSent },
  })

  // 53 more numbers, one with 52 members, so the list and the members are each two pages.
  await fetch(`${sink.url}/_sink/seed`, { method: 'POST', body: JSON.stringify({ phoneNumbers: [
    { id: 'PNbig', phoneNumber: '+15550002222', name: 'Sales', members: 52 },
    ...Array.from({ length: 52 }, (_, i) => ({ id: `PNseed${String(i).padStart(2, '0')}`, phoneNumber: `+1555001${String(i).padStart(4, '0')}` })),
  ] }) })
  await ctl.reset()
  const numberBook = await backfillPhoneNumbers(quo)
  t('numbers.backfillIsTheBook', {
    error: numberBook.error ?? null, truncated: numberBook.truncated, rows: numberBook.rows.length,
    restrictions: numberBook.rows.every(r => r.restrictions?.calling.Intl === 'restricted'), businessHours: numberBook.rows.filter(r => 'businessHours' in r).length,
    ours: numberBook.rows.find(r => r.externalId === PN)?.name,
    wire: (await numberWire()).map(w => w.query.replace(/after=[^&]+/, 'after=…')),
  })

  await ctl.reset()
  const ourMembers = await getPhoneNumberMembers(quo, PN), bigMembers = await getPhoneNumberMembers(quo, 'PNbig')
  const membersRead = (await seen()).requests.length
  await ctl.reset(); await ctl.arm({ forbidAfter: 1 })
  const halfMembers = await getPhoneNumberMembers(quo, 'PNbig')
  t('numbers.membersAllOrNothing', {
    ours: ourMembers.row, roles: ourMembers.users?.map(m => m.role),
    big: { count: bigMembers.row?.memberExternalIds.length, byId: JSON.stringify(bigMembers.row?.memberExternalIds) === JSON.stringify([...bigMembers.row?.memberExternalIds ?? []].sort()) },
    reads: membersRead, partial: { row: halfMembers.row ?? null, kind: halfMembers.error?.kind },
  })

  await ctl.reset()
  t('numbers.availableIsALook', {
    area:     (await availablePhoneNumbers(quo, { areaCode: '415', limit: 2 })).numbers,
    tollFree: (await availablePhoneNumbers(quo, { tollFree: true })).numbers,
    canada:   (await availablePhoneNumbers(quo, { countryCode: 'CA', inLocality: 'Vancouver' })).numbers,
    wire:     (await numberWire()).map(w => w.query),
  })

  t('numbers.unknownIsGone', {
    read: (await getPhoneNumber(quo, 'PNnope')).error?.kind, settings: (await getPhoneNumberSettings(quo, 'PNnope')).error?.kind,
    update: await status(() => line.update!('PNnope', { name: 'x' })),
  })

  // ─── Users and the organization ───
  // No event reports either: every row is a read's. The member read is a user without its picture or times.
  const userWire = async () => (await seen()).requests.filter(r => r.path.startsWith('/users') || r.path === '/organization')
    .map(r => ({ method: r.method, path: r.path, query: decodeURIComponent(r.query).replace(/after=[^&]+/, 'after=…') }))

  await ctl.reset()
  const olive = await getUser(quo, 'USowner')
  t('users.readIsWhole', { row: shown(olive.row), wire: await userWire() })

  const oliveMember = (await getPhoneNumberMembers(quo, PN)).users?.find(u => u.externalId === 'USowner')
  t('users.memberRowLeavesOut', {
    columns: oliveMember && Object.keys(oliveMember).sort(),
    upserted: olive.row && oliveMember && shown({ ...olive.row, ...oliveMember }),
    // A message's `userId` can be a system actor, which no user read lists.
    systemActor: userModel.parse({ id: 'SYU123', email: 'system@quo.test', firstName: null, lastName: null, role: 'member', groupId: 'GR1' }),
  })

  await ctl.reset()
  const userBook = await backfillUsers(quo)
  t('users.backfillIsTheBook', {
    error: userBook.error ?? null, truncated: userBook.truncated, rows: userBook.rows.length,
    whole: userBook.rows.every(r => r.createdAt instanceof Date && 'pictureUrl' in r),
    byId: JSON.stringify(userBook.rows.map(r => r.externalId)) === JSON.stringify(userBook.rows.map(r => r.externalId).sort()),
    wire: await userWire(),
  })

  // Amy on 51 more numbers, so her list is two pages.
  await seed({ phoneNumbers: Array.from({ length: 51 }, (_, i) => ({ id: `PNamy${String(i).padStart(2, '0')}`, phoneNumber: `+1555002${String(i).padStart(4, '0')}`, memberIds: ['USamy'] })) })
  await ctl.reset()
  const devNumbers = await getUserPhoneNumbers(quo, 'USdev'), amyNumbers = await getUserPhoneNumbers(quo, 'USamy'), nobodyNumbers = await getUserPhoneNumbers(quo, 'USnobody')
  const numbersWire = await userWire()
  await ctl.reset(); await ctl.arm({ forbidAfter: 1 })
  const halfAmy = await getUserPhoneNumbers(quo, 'USamy')
  t('users.numbersOfAUser', {
    dev: devNumbers.rows.map(r => [r.externalId, !!r.restrictions, 'businessHours' in r, 'memberExternalIds' in r]),
    amy: { rows: amyNumbers.rows.length, error: amyNumbers.error ?? null },
    nobody: { rows: nobodyNumbers.rows, error: nobodyNumbers.error ?? null },
    partial: { rows: halfAmy.rows.length, kind: halfAmy.error?.kind },
    wire: numbersWire,
  })

  await ctl.reset()
  const workspace = await getOrganization(quo)
  await seed({ organization: { subscriptionStatus: 'expired', name: '' } })
  const lapsed = await getOrganization(quo)
  t('organization.read', { row: shown(workspace.row), notAnOrg: organizationModel.parse({ ...workspace.row, id: 'USowner' } as never), lapsed: lapsed.row && { status: lapsed.row.subscriptionStatus, name: lapsed.row.name }, wire: await userWire() })

  await ctl.reset()
  t('users.refusedBeforeSending', {
    notAUser:    await getUser(quo, 'PNour0001').then(() => false, e => /not a user id/.test(e.message)),
    barePrefix:  await getUser(quo, 'US').then(() => false, e => /not a user id/.test(e.message)),
    numbersNone: await getUserPhoneNumbers(quo, '').then(() => false, e => /not a user id/.test(e.message)),
    reached: (await seen()).requests.length,
  })
  t('users.unknownIsGone', { read: (await getUser(quo, 'USnobody')).error?.kind })

  // ─── A2P registration ───
  // A plain answer, no row. One per workspace; a create or a patch naming the business starts autofill, and a submit bills.
  const a2pWire = async () => (await seen()).requests.filter(r => r.path.startsWith('/a2p-registration') || r.path.startsWith('/v1/a2p'))
    .map(r => ({ method: r.method, path: r.path, version: r.version }))
  const sinkA2P = async () => ((await ctl.seen()) as unknown as { a2p: { payments: number } }).a2p
  const verdict = (v: object | null) => fetch(`${sink.url}/_sink/a2p`, { method: 'POST', body: JSON.stringify(v) })
  const autofilled = () => new Promise(r => setTimeout(r, 120))
  const DRAFT: QuoA2PDraft = {
    name: 'Knight Works LLC', alternateName: null, businessType: 'Limited Liability Corporation', companyType: 'Private', industry: 'Technology',
    employeeCount: 8, avgDailyCallVolume: 40, regionsOfOperation: ['USA and Canada'], websiteUrl: 'https://knight.example',
    idType: 'USA: Employer Identification Number (EIN)', idNumber: '12-3456789', ticker: null, exchange: null,
    address: { line1: '1 Main St', line2: null, city: 'Portland', region: 'OR', postalCode: '97201', country: 'US' },
    personOfContact: { firstName: 'Olive', lastName: 'Owner', jobTitle: 'Founder', jobPosition: 'CEO', email: 'olive@knight.example', phoneNumber: '+15035550100' },
    messageTypes: ['customer_support', 'appointments_scheduling'],
  }

  await ctl.reset()
  const none = await getA2PRegistration(quo)
  t('a2p.noneIsNull', { registration: none.registration, error: none.error ?? null, notARegistration: a2pRegistration({ id: 'PNour0001' }), wire: await a2pWire() })

  // The workspace lapsed in 5.3's rows: Quo will not register it, and refuses a malformed EIN.
  await ctl.reset()
  const lapsedCreate = await createA2PRegistration(quo, DRAFT)
  await seed({ organization: { subscriptionStatus: 'active' } })
  const badEin = await createA2PRegistration(quo, { ...DRAFT, idNumber: '1234-5678' })
  t('a2p.quoRefusals', {
    lapsed: { kind: lapsedCreate.error?.kind, retryable: lapsedCreate.error?.retryable },
    ein: { kind: badEin.error?.kind, nine: /nine digits/.test(badEin.error?.message ?? '') },
    wire: await a2pWire(),
  })

  await ctl.reset()
  const created = await createA2PRegistration(quo, DRAFT)
  const sentCreate = JSON.parse((await seen()).requests.find(r => r.path === '/a2p-registration')!.body)
  const reg = created.registration
  t('a2p.createIsADraft', {
    error: created.error ?? null, id: /^RG./.test(reg?.id ?? ''), draft: reg?.draft, status: reg?.status, type: reg?.type,
    times: [reg?.createdAt instanceof Date, reg?.updatedAt instanceof Date, reg?.firstSubmittedAt],
    name: reg?.businessInfo.name, line2: reg?.businessInfo.address.line2, messaging: reg?.messaging,
    sent: Object.keys(sentCreate).sort(), messageTypesKept: !!reg && 'messageTypes' in reg.businessInfo,
  })

  // A lost create landed: the replay would be the 409, so there is none, and the read finds it.
  await verdict(null); await ctl.reset(); await ctl.arm({ lost: true })
  const lostA2PCreate = await createA2PRegistration(quo, DRAFT)
  const posts = (await seen()).requests.filter(r => r.method === 'POST' && r.path === '/a2p-registration').length
  await ctl.reset()
  const a2pFound = await getA2PRegistration(quo)
  const again = await createA2PRegistration(quo, DRAFT)
  t('a2p.createNotReplayed', {
    kind: lostA2PCreate.error?.kind, indeterminate: lostA2PCreate.error?.indeterminate, posts,
    found: a2pFound.registration?.draft, again: { kind: again.error?.kind, one: /already has/.test(again.error?.message ?? '') },
  })

  await autofilled(); await ctl.reset()
  const merged = await updateA2PRegistration(quo, { address: { city: 'Oakland' }, ticker: null, employeeCount: 9 })
  const sentPatch = JSON.parse((await seen()).requests.find(r => r.method === 'PATCH')!.body)
  await ctl.reset(); await ctl.arm({ lost: true })
  const lostA2PPatch = await updateA2PRegistration(quo, { employeeCount: 12 })
  t('a2p.updateMerges', {
    sent: sentPatch, address: merged.registration?.businessInfo.address, ticker: merged.registration?.businessInfo.ticker,
    messaging: !!merged.registration?.messaging.useCase,
    lost: { error: lostA2PPatch.error ?? null, employees: lostA2PPatch.registration?.businessInfo.employeeCount, patches: (await seen()).requests.filter(r => r.method === 'PATCH').length },
  })

  // Renaming restarts autofill, and a submit inside it waits.
  await ctl.reset()
  await updateA2PRegistration(quo, { name: 'Knight Works', messageTypes: ['customer_support'] })
  const earlySubmit = await submitA2PRegistration(quo, { forbiddenMessageTopicsAcknowledged: true })
  await autofilled()
  const submitted = await submitA2PRegistration(quo, { forbiddenMessageTopicsAcknowledged: true })
  const s1 = submitted.registration
  t('a2p.submitWaitsForAutofill', {
    early: { kind: earlySubmit.error?.kind, retryable: earlySubmit.error?.retryable, autofill: /Autofill/.test(earlySubmit.error?.message ?? '') },
    after: { error: submitted.error ?? null, draft: s1?.draft, status: s1?.status, first: s1?.firstSubmittedAt instanceof Date, useCase: s1?.messaging.useCase },
    payments: (await sinkA2P()).payments,
    wire: await a2pWire(),
  })

  await ctl.reset()
  t('a2p.updateAfterSubmitRefused', await updateA2PRegistration(quo, { employeeCount: 3 }).then(r => ({ kind: r.error?.kind, draft: /draft status/.test(r.error?.message ?? '') })))

  // The carrier's verdict reaches the app on the next read alone.
  await verdict({ status: 'rejected', statusMessages: [{ errorCode: 504, errorReason: 'The EIN does not match the name', fields: ['idNumber', 'name'] }] })
  const rejected = await getA2PRegistration(quo)
  t('a2p.verdictIsRead', { status: rejected.registration?.status, draft: rejected.registration?.draft, messages: rejected.registration?.statusMessages })

  // A conflict on a rejected one is not the submit done.
  await ctl.reset(); await ctl.arm({ autofilling: true })
  const conflicted = await submitA2PRegistration(quo, { forbiddenMessageTopicsAcknowledged: true })
  await ctl.arm({ paymentFails: true })
  const unpaid = await submitA2PRegistration(quo, { forbiddenMessageTopicsAcknowledged: true })
  t('a2p.rejectedConflictIsNotDone', {
    conflict: { kind: conflicted.error?.kind, retryable: conflicted.error?.retryable },
    unpaid: { kind: unpaid.error?.kind, retryable: unpaid.error?.retryable },
    payments: (await sinkA2P()).payments, status: (await getA2PRegistration(quo)).registration?.status,
  })

  // A lost resubmit billed. Not replayed; the caller's second submit is a 409, which the read says is done.
  await ctl.reset(); await ctl.arm({ lost: true })
  const lostSubmit = await submitA2PRegistration(quo, { forbiddenMessageTopicsAcknowledged: true })
  const submits = (await seen()).requests.filter(r => r.path === '/a2p-registration/submit').length
  await ctl.reset()
  const resubmitted = await submitA2PRegistration(quo, { forbiddenMessageTopicsAcknowledged: true })
  t('a2p.lostSubmitIsRead', {
    kind: lostSubmit.error?.kind, indeterminate: lostSubmit.error?.indeterminate, submits,
    retried: { error: resubmitted.error ?? null, status: resubmitted.registration?.status, draft: resubmitted.registration?.draft },
    payments: (await sinkA2P()).payments, wire: await a2pWire(),
  })

  await ctl.reset()
  const refusedLocally = async (fn: () => Promise<unknown>, says: RegExp) => { try { await fn(); return false } catch (e) { return e instanceof TypeError && says.test(e.message) } }
  const { idNumber: _ein, ...noEin } = DRAFT
  t('a2p.refusedBeforeSending', {
    missing:     await refusedLocally(() => createA2PRegistration(quo, noEin as QuoA2PDraft), /names idNumber/),
    nestedGone:  await refusedLocally(() => createA2PRegistration(quo, { ...DRAFT, address: { ...DRAFT.address, city: undefined as never } }), /names address\.city/),
    industry:    await refusedLocally(() => createA2PRegistration(quo, { ...DRAFT, industry: 'Mining' as never }), /industry is one of/),
    phone:       await refusedLocally(() => createA2PRegistration(quo, { ...DRAFT, personOfContact: { ...DRAFT.personOfContact, phoneNumber: '503-555-0100' } }), /phoneNumber is an E\.164/),
    email:       await refusedLocally(() => createA2PRegistration(quo, { ...DRAFT, personOfContact: { ...DRAFT.personOfContact, email: 'olive' } }), /email is an email/),
    noRegions:   await refusedLocally(() => createA2PRegistration(quo, { ...DRAFT, regionsOfOperation: [] }), /regionsOfOperation is a list of 1–5/),
    sixRegions:  await refusedLocally(() => createA2PRegistration(quo, { ...DRAFT, regionsOfOperation: Array(6).fill('Asia') }), /regionsOfOperation is a list/),
    url:         await refusedLocally(() => createA2PRegistration(quo, { ...DRAFT, websiteUrl: 'knight' }), /websiteUrl is a URL/),
    noTypes:     await refusedLocally(() => createA2PRegistration(quo, { ...DRAFT, messageTypes: [] }), /messageTypes is a list/),
    count:       await refusedLocally(() => updateA2PRegistration(quo, { employeeCount: 8.5 }), /employeeCount is an integer/),
    empty:       await refusedLocally(() => updateA2PRegistration(quo, {}), /at least one field/),
    emptyPart:   await refusedLocally(() => updateA2PRegistration(quo, { address: {} }), /address names at least one field/),
    unknown:     await refusedLocally(() => updateA2PRegistration(quo, { ein: '1' } as never), /'ein' is not a field/),
    nullName:    await refusedLocally(() => updateA2PRegistration(quo, { name: null as never, messageTypes: ['customer_support'] }), /name is a string/),
    autofill:    await refusedLocally(() => updateA2PRegistration(quo, { websiteUrl: 'https://k.example' }), /needs messageTypes/),
    contactName: await refusedLocally(() => updateA2PRegistration(quo, { personOfContact: { lastName: 'Knight' } }), /needs messageTypes/),
    noAck:       await refusedLocally(() => submitA2PRegistration(quo, { forbiddenMessageTopicsAcknowledged: false as never }), /acknowledges/),
    reached: (await seen()).requests.length,
  })

  const del1 = await deleteWebhook(quo, hookId), del2 = await deleteWebhook(quo, hookId)
  t('delete.thenGone', { first: del1.error ?? null, second: del2.error?.kind })

  const wrong = createConduit({ credentials: createStaticResolver({ QUO_API_KEY: 'not-the-key' }), ...DRIVE_RESILIENCE })
  await wrong.register(targets.dated)
  const denied = await listWebhooks(bindQuo(wrong, targets))
  await wrong.destroy()
  t('auth.wrongKey', { kind: denied.error?.kind })
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message)
} finally { sink.stop(); receiver.stop(true); await conduit.destroy() }

const OLIVE = { externalId: 'USowner', email: 'owner@example.com', firstName: 'Olive', lastName: 'Owner', role: 'owner', pictureUrl: 'https://files.quo.test/olive.png', createdAt: 'Date 2025-05-01T12:00:00.000Z', updatedAt: 'Date 2025-05-01T12:00:00.000Z' }

process.exit(report(got, {
  'e164.normalizes':                 { paren: '+14155550100', intl: '+442079460958', zeros: '+442079460958' },
  'local.refusedBeforeSending':      { noCountry: true, blank: true, tooLong: true, tooMany: true, noEvents: true, notMessageId: true, notWebhookId: true, pageTooBig: true, retryNotWebhookId: true, retryNoDelivery: true, testNotWebhookId: true, testUnknownType: true, getNotWebhookId: true, updateNotWebhookId: true, updateNothing: true, updateNoEvents: true, updateUnknownEvent: true, backfillNoPages: true, backfillBadSince: true, propertiesNoContact: true, markNotConversationId: true, markBarePrefix: true, callNotCallId: true, recordingsNotCallId: true, transcriptsBarePrefix: true, fileNotAUrl: true, reached: 0 },
  'webhook.keyOnlyOnCreate':         { key: true, listed: 1, listHasKey: false, pinned: '2026-03-30' },
  'wire.eachCallOnItsGeneration':    { send: [{ path: '/v1/messages', version: null, auth: 'quo_dev_key' }], read: [{ path: '/messages/AC…', version: '2026-03-30' }], readOk: true },
  'send.queuedThenDeliveredLater':   { atSend: 'queued', laterEvent: 'delivered' },
  'receipt.mayArriveBeforeSendAnswers': { sendSays: 'queued', receiptAlreadyIn: true },
  'refusals.domainWords': {
    unregistered:      { kind: 'unregistered', retryable: false, code: '0206400', attempts: 1 },
    dailyCap:          { kind: 'quota',        retryable: false, code: '0204403', attempts: 1 },
    conversationLimit: { kind: 'quota',        retryable: false, code: '0200429', attempts: 1 },
    subscription:      { kind: 'billing',      retryable: false, code: '0201402', attempts: 1 },
    notMember:         { kind: 'forbidden',    retryable: false, code: '0202403', attempts: 1 },
    international:     { kind: 'forbidden',    retryable: false, code: '0203403', attempts: 1 },
  },
  'refusal.namesTheField':           { kind: 'refused', fields: ['/body/to'], trace: 'string' },
  'rateLimited.handedToCaller':      { kind: 'rate_limited', retryable: true, retryAfterMs: 1000, attempts: 1 },
  'lostSend.indeterminateThenFound': { kind: 'timeout', indeterminate: true, retryable: false, attempts: 1, foundTheOne: true },
  'findSent.matchesOnlyThisAttempt': { elsewhere: null, otherWords: null, byPnId: true },
  'retry.failedThenDelivered':       { failed: { status: 'failed', errorCode: null }, error: null, wire: [{ path: '/messages/AC…/retry', version: '2026-03-30' }], delivered: true },
  'retry.onlyATransientFailure': {
    permanent:   { kind: 'refused', retryable: false, attempts: 1 },
    undelivered: { kind: 'refused', retryable: false, attempts: 1 },
    delivered:   { kind: 'refused', retryable: false, attempts: 1 },
    unknown:     { kind: 'gone',    retryable: false, attempts: 1 },
  },
  'retry.lostIsReadNotReplayed':     { kind: 'timeout', indeterminate: true, attempts: 1, afterRead: 'delivered' },
  'inbound.verifiedOnceAsARow': {
    standard: ['applied', 'duplicate'], legacy: ['applied', 'duplicate'], applied: 1,
    columns:  ['conversationExternalId', 'createdAt', 'direction', 'externalId', 'from', 'media', 'phoneNumberExternalId', 'status', 'text', 'to'],
    message:  { key: true, from: '+14155550100', to: ['+15550001111'], text: ' Stop ', phoneNumber: 'PNour0001', direction: 'incoming', createdAt: true },
    beside:   { external: ['+14155550100'], conversation: true, errorCode: null },
  },
  'legacy.sameMessageRow':           { same: true, legacyOnly: ['userExternalId'] },
  'call.incomingAnswered': {
    types:     ['call.ringing', 'call.answered', 'call.completed'],
    sameId:    true,
    conversation: true,
    ringing:   ['createdAt', 'direction', 'externalId', 'phoneNumberExternalId', 'updatedAt'],
    answered:  ['answeredAt', 'answeredByExternalId', 'createdAt', 'direction', 'externalId', 'phoneNumberExternalId', 'updatedAt'],
    completed: ['answeredAt', 'completedAt', 'createdAt', 'direction', 'duration', 'externalId', 'phoneNumberExternalId', 'status', 'updatedAt'],
    values:    { answeredBy: 'USdev', status: 'answered', duration: 55, phoneNumber: 'PNour0001', external: ['+14155550100'] },
  },
  'call.missedIsIncoming': {
    types:     ['call.ringing', 'call.missed', 'call.completed'],
    missed:    { columns: ['createdAt', 'direction', 'externalId', 'phoneNumberExternalId', 'updatedAt'], direction: 'incoming' },
    completed: { status: 'unanswered', answeredAt: null, duration: null },
  },
  'call.outgoingExternalIsTheirs':   { direction: 'outgoing', external: ['+14155550100'] },
  'call.unavailableIsNull':          { external: null, phoneNumber: 'PNour0001' },
  'legacy.sameCallRow': {
    types:   ['legacy:call.ringing', 'legacy:call.completed'], same: true, status: { legacy: 'completed', dated: 'answered' },
    columns: ['answeredAt', 'completedAt', 'createdAt', 'direction', 'externalId', 'phoneNumberExternalId', 'status'],
  },
  'events.allListedUnresolvedVoicemail': { count: 31, unique: 31, voicemailCall: null, url: 'https://files.quo.test/vm.mp3' },
  'rotate.oldKeyStopsAtOnce':        { newKey: true, beforeStoring: 401, afterStoring: 'applied' },
  'deliveries.refusedIsSendingThenFailed': {
    whileRetrying: { sending: [{ isTheOneWeRefused: true, nextAttemptAt: 'string' }], failed: [] },
    givenUp:       { sending: [], failed: [{ isTheOneWeRefused: true, nextAttemptAt: 'object' }] },
    newestFirst:   true,
  },
  'deliveries.filtered': {
    oneMessage: ['message.delivered', 'message.failed'],
    oneType:    ['message.failed'],
    failures:   ['message.failed', 'message.undelivered', 'message.failed', 'message.failed'],
    window:     { after: 2, beforeHasNone: true, adds: true },
    asked:      ['status', 'status', 'resourceId', 'eventType[in]&limit', 'createdAt[gt]', 'createdAt[lt]&limit'],
  },
  'deliveries.pagedByCursor':        { sameAsOnePage: true, pages: true, more: true },
  'delivery.detailHasAttempts': {
    refused: { eventType: 'message.received', bodyIsTheEvent: true, attempts: [{ status: 'failed', responseStatusCode: 401, triggerType: 'scheduled' }] },
    twice:   { deliveries: 1, attempts: 2 },
    unknown: 'gone',
  },
  'delivery.retryAppliesWhatWasRefused': {
    error:       null,
    wire:        [{ path: '/webhooks/1/events/msg_…/retry', version: '2026-03-30' }],
    receiver:    ['applied'],
    applied:     ['one'],
    attempts:    [{ status: 'success', responseStatusCode: 200, triggerType: 'manual' }, { status: 'failed', responseStatusCode: 401, triggerType: 'scheduled' }],
    stillFailed: false,
    unknown:     'gone',
  },
  'delivery.lostRetryIsReplayedHarmlessly': { error: null, asked: 2, receiver: ['duplicate', 'duplicate'], applied: 0 },
  'deliveries.healedOldestFirstPastAPage': {
    owedBefore:  { failed: 1, sending: 51 },
    retried:     52,
    unretried:   [],
    listed:      ['sending', 'sending+after', 'failed'],
    oldestFirst: true,
    applied:     true,
    owedAfter:   { sending: 0, failed: 0 },
    beforeWindowLeft: 1,
  },
  'test.previewThenDelivered': {
    error:    null,
    preview:  { type: 'call.completed', apiVersion: '2026-03-30', org: 'ORsampleorg000000000000' },
    wire:     [{ path: '/webhooks/1/events/test', version: '2026-03-30', body: '{"eventType":"call.completed"}' }],
    receiver: ['ignored'], landed: 0,
    logged:   [{ isTheOneHeard: true, eventId: null, resourceId: null, status: 'success' }],
    unknown:  'gone',
  },
  'test.eachDispatchIsItsOwnDelivery': { sameEnvelopeId: true, webhookIds: 2, receiver: ['ignored', 'ignored'], applied: [] },
  'test.lostAnswerIsReplayed':       { error: null, preview: 'message.received', asked: 2, receiver: ['ignored', 'ignored'] },
  'webhook.getIsTheListRow':         { same: true, hasKey: false, wire: [{ method: 'GET', version: '2026-03-30' }], unknown: 'gone' },
  'webhook.updateChangesOnlyWhatIsGiven': {
    relabeled: { label: 'renamed', urlKept: true, eventsKept: 8, updatedAtMoved: true },
    unlabeled: null,
    narrowed:  ['message.received'],
    wire: [
      { path: '/webhooks/1', version: '2026-03-30', body: '{"label":"renamed"}' },
      { path: '/webhooks/1', version: '2026-03-30', body: '{"label":null}' },
      { path: '/webhooks/1', version: '2026-03-30', body: '{"events":["message.received"]}' },
    ],
    keyKept:   true,
    restored:  8,
    unknown:   'gone',
  },
  'webhook.emptyNumbersIsEveryNumber': { otherNumber: false, emptied: ['*'], afterEmpty: true, disabled: false, enabledAgain: true },
  'webhook.lostUpdateIsReplayed':    { error: null, label: 'drive', asked: 2 },
  'verify.clockTamperRotation':      { fresh: true, stale: false, tampered: false, wrongKey: false, rotating: true, rawBytes: true, legacyHeaderOnStandardPath: false },
  'mirror.claimShape':               { provider: 'quo', models: ['Message', 'Conversation', 'Contact', 'Call', 'Recording', 'Task', 'PhoneNumber', 'User', 'Organization'], keys: true, targets: true, verbs: ['Contact.create', 'Contact.update', 'Contact.delete', 'Task.create', 'Task.update', 'Task.delete', 'PhoneNumber.update'] },
  'mirror.messageRowFromTheRead': {
    key: true, conversation: true, phoneNumber: true, user: 'USdev',
    from: '+15550001111', to: ['+14155550100'], text: 'hello', media: [],
    createdAt: true, noQuoNames: [],
  },
  'mirror.callRow': {
    externalId: 'AC123abc', phoneNumberExternalId: 'PN123abc', actorExternalId: 'US123abc', answeredByExternalId: 'US123abc', initiatedByExternalId: null,
    direction: 'incoming', status: 'completed',
    participants: [{ phoneNumber: '+15555555555', actorExternalId: 'US123abc' }, { phoneNumber: '+15555555555', actorExternalId: 'US456def' }, { phoneNumber: '+15555555556', actorExternalId: null }],
    duration: 55, callRoute: 'phone-menu', forwardedFrom: null, forwardedTo: null, aiHandled: null,
    answeredAt: 'Date 2022-01-01T00:00:05.000Z', completedAt: 'Date 2022-01-01T00:01:00.000Z', createdAt: 'Date 2022-01-01T00:00:00.000Z', updatedAt: null,
  },
  'mirror.conversationRow': {
    externalId: 'CN123abc', phoneNumberExternalId: 'PN123abc', lastActivityExternalId: 'AC123abc', name: null, participants: ['+15555555556'],
    lastActivityAt: 'Date 2022-01-01T00:01:00.000Z', mutedUntil: null, snoozedUntil: 'Date 2022-01-02T09:00:00.000Z',
    createdAt: 'Date 2021-12-31T00:00:00.000Z', updatedAt: 'Date 2022-01-01T00:01:00.000Z', deletedAt: null,
  },
  'mirror.contactRow': {
    externalId: '6a145ff26212a192852c856e', actorExternalId: 'US123abc', sourceId: '1234567890', source: 'public-api', sourceUrl: 'https://example.com/contacts/001',
    firstName: 'John', lastName: 'Doe', company: 'Quo', role: 'admin', createdAt: 'Date 2021-01-01T00:00:00.000Z', updatedAt: 'Date 2021-01-01T00:00:00.000Z',
  },
  'mirror.emptyIsNull': {
    message:      { text: null, conversation: null, phoneNumber: null, user: null, media: [{ url: 'https://files.quo.test/a.jpg', type: null }] },
    call:         { status: null, callRoute: null, forwardedTo: null, answeredAt: null, participants: [{ phoneNumber: '+15555555556', actorExternalId: null }] },
    conversation: { name: null, lastActivity: null, participants: ['+15555555556'] },
    contact:      { sourceId: null, source: null, sourceUrl: null, firstName: null, lastName: null, company: null, role: null },
  },
  'mirror.wrongNounIsNull': {
    messageOfCall: null, callOfMessage: null, callOfConversation: null, conversationOfCall: null,
    messageWithoutId: null, contactWithoutId: null, nothing: [null, null, null, null], unreadableTime: null,
  },
  'backfill.messagesSinceIsInclusive': {
    before: false, at: true, after: true, newestFirst: true, rows: true, truncated: false, resume: null, error: null,
    wire: '?createdAt[gt]=2026-01-01T00:59:59.999Z&limit=50',
  },
  'backfill.callsFromTheRead': {
    before: false, at: true,
    placed: { status: 'completed', answeredBy: 'USdev', participants: ['+15550001111', '+14155550100'], answeredAt: true },
    error: null, wire: ['?createdAt[gte]=2026-01-01T01:00:00.000Z&include=summary,voicemail&limit=50'],
  },
  'backfill.conversationsByChange': {
    idle: false, moved: true, oldestChangeFirst: true, error: null,
    wire: ['?updatedAt[gte]=2026-01-01T01:00:00.000Z&sort=updatedAt:asc&limit=50'],
  },
  'backfill.contactsAreTheWholeBook': {
    rows: 120, distinct: 120, truncated: false, resume: null, properties: 0, lists: 0,
    wire: ['?limit=50', '?limit=50&after=…', '?limit=50&after=…'],
  },
  'properties.everyPageInOneRow': {
    row: { externalId: 'ctprops', phoneNumbers: ['+14155550100', '+14155550199'], emails: ['paged@example.test'] },
    error: null, wire: ['?limit=50', '?limit=50&after=…'],
  },
  'properties.allOrNothing': { row: null, error: 'forbidden', missing: 'gone', missingRow: null },
  'backfill.truncatedThenResumed': {
    first: { rows: 50, truncated: true, resume: 'string' },
    rest:  { rows: 70, truncated: false, resume: null },
    whole: 120, overlap: 0,
  },
  'backfill.lostPageIsReplayed':     { error: null, rows: 50, asked: 2 },
  'backfill.failureKeepsWhatWasRead': {
    error: 'forbidden', rows: 50, truncated: false, resume: 'string',
    resumed: { error: null, rows: 70, whole: 120 },
  },
  'mirror.contactCreatePatchDelete': {
    made:    { key: true, sourceId: 'crm-1', source: 'crm', sourceUrl: 'https://crm.test/1', actor: 'USdev', firstName: 'Ada', lastName: 'Lovelace', createdAt: true },
    patched: { sameKey: true, company: 'Analytical', lastName: null, firstName: 'Ada' },
    removed: null, left: 0,
    wire: [
      { method: 'POST',   path: '/contacts',   version: '2026-03-30', body: '{"firstName":"Ada","lastName":"Lovelace","externalId":"crm-1","source":"crm","sourceUrl":"https://crm.test/1","actorId":"USdev"}' },
      { method: 'PATCH',  path: '/contacts/…', version: '2026-03-30', body: '{"lastName":null,"company":"Analytical"}' },
      { method: 'DELETE', path: '/contacts/…', version: '2026-03-30', body: null },
    ],
  },
  'mirror.contactSourcePairIsUnique':     { twin: 409, otherSource: 'sheet', moveOntoTwin: 409, graces: 2, first: 'Grace' },
  'mirror.contactLostCreateIsNotReplayed': { status: 504, mayHaveLanded: true, sent: 1, retry: 409, lins: 1 },
  'mirror.contactLostPatchIsReplayed':    { role: 'admiral', sent: 2 },
  'mirror.contactLostDeleteIsDone': { status: null, sent: ['DELETE', 'DELETE'], gone: true },
  'mirror.contactRefusedBeforeSending': {
    noFirstName: 400, nullFirstName: 400, notAUser: 400, notAUri: 400, longUri: 400, notAString: 400, noKeyUpdate: 400, noKeyDelete: 400, reached: 0,
  },
  'receive.eachSubscriptionApplies': { receiver: ['/webhooks/quo applied', '/webhooks/quo-2 applied'], oneMessage: 1 },
  'receive.contactEventsAreRows': {
    types:   ['contact.updated', 'contact.updated', 'contact.updated', 'contact.deleted'], sameKey: true,
    columns: ['company', 'createdAt', 'emails', 'externalId', 'firstName', 'lastName', 'phoneNumbers', 'role', 'source', 'sourceId', 'updatedAt'],
    made:    { sourceId: 'crm-9', source: 'crm', lastName: 'Hopper', createdAt: true, phoneNumbers: [], emails: [] },
    numbered: ['+14155550123'],
    patched: { lastName: null, company: 'Navy', firstName: 'Grace' },
    gone:    { company: 'Navy', phoneNumbers: ['+14155550123'] },
    beside:  true,
  },
  'receive.failedMessageCarriesNoMedia': {
    columns:   ['conversationExternalId', 'createdAt', 'direction', 'externalId', 'from', 'phoneNumberExternalId', 'status', 'text', 'to'],
    errorCode: '30006', external: ['+15550001111'], conversation: 'CN123', contacts: ['CT123'],
  },
  'receive.contactIdsBesideTheRow': {
    texts: [['ctthem'], []], legacyTexts: [null, null],
    ringing: [null, null], completed: [['ctthem'], null], unavailable: null,
  },
  'artifacts.recordingEventRows': {
    call: true, count: 2, keyed: true, columns: ['callExternalId', 'duration', 'externalId', 'startTime', 'type', 'url'], startTime: true, elsewhere: true,
  },
  'artifacts.recordingsFromTheRead': {
    sameAsTheEvent: true, oldestFirst: true, status: ['completed', 'completed'],
    columns: ['callExternalId', 'duration', 'externalId', 'startTime', 'status', 'type', 'url'], error: null,
    wire: [{ path: '/calls/AC…/recordings', query: '?limit=50', version: '2026-03-30' }],
  },
  'artifacts.bytesMatch':          { same: [true, true], type: 'audio/mpeg', key: [null, null], version: [null, null], toTheApi: 0 },
  'artifacts.expiredUrlIsGone':    { kind: 'gone', retryable: false, again: true, fetches: [403, 200] },
  'artifacts.summaryOnTheCallRow': {
    event:  { keyed: true, columns: ['answeredByExternalId', 'externalId', 'nextSteps', 'summary', 'summaryJobs', 'summaryStatus'], jobs: null, external: ['+14155550100'] },
    read:   { summaryStatus: 'completed', summaryType: 'human', summary: ['They asked about pricing.'], nextSteps: ['Send the price sheet.'], summaryTitle: null, summaryJobs: null },
    noVoicemail: { voicemailExternalId: null, voicemailUrl: null },
    legacy: { keyed: true, columns: ['externalId', 'nextSteps', 'summary', 'summaryStatus'] },
  },
  'artifacts.transcriptBesideTheEvent': {
    event:  { call: null, callId: true, segment: false, lines: 4, first: { actorExternalId: 'USdev', identifier: '+15550001111', content: 'part 1, ours', start: 0, end: 3 }, status: 'completed' },
    read:   { segments: true, lines: [2, 2], theirs: { actorExternalId: null, identifier: '+14155550100', content: 'part 1, theirs', start: 3, end: 7 }, startTime: true },
    legacySame: true,
  },
  'artifacts.transcriptsAllOrNothing': { transcripts: null, kind: 'forbidden' },
  'artifacts.voicemailOnTheCallRow': {
    event:  { keyed: true, columns: ['externalId', 'voicemailDuration', 'voicemailExternalId', 'voicemailTranscript', 'voicemailUrl'], duration: 18, external: ['+14155550100'], conversation: true },
    read:   { status: 'completed', sameVoicemail: true, sameUrl: true, transcript: 'Hi, call me back about the proposal.' },
    bytes:  true,
    legacy: { url: true, duration: 18, ringing: false },
  },
  'artifacts.absentUnlessAsked': { asked: { voicemailUrl: null, summaryStatus: 'completed' }, voicemail: 'completed', notAsked: [] },
  'inbox.marksSetWhatTheyName': {
    arrived:   { unread: true, status: 'open' },
    afterRead: { unread: false, status: 'open' },
    afterDone: { unread: false, status: 'done' },
    afterOpen: { unread: false, status: 'open' },
    answers: [true, true, true], stateless: true,
    wire: ['read', 'done', 'open'].map(s => ({ method: 'POST', path: `/conversations/CN…/mark-as-${s}`, version: '2026-03-30', body: '' })),
  },
  'inbox.sendFilesDone':             { sent: true, state: { unread: false, status: 'done' } },
  'inbox.lostMarkIsReplayed':        { error: null, row: true, state: { unread: false, status: 'done' }, asked: 2 },
  'inbox.unknownConversationIsGone': { kind: 'gone', row: null },
  'delete.thenGone':                 { first: null, second: 'gone' },
  'tasks.createLandsWhatItSent': {
    answer: { externalId: 'TK·1', conversationExternalId: 'CN·task', title: 'Call back', description: 'About pricing', status: 'open', dueDate: 'Date 2026-11-02T17:00:00.000Z', assignedToExternalId: 'USdev', revision: 1 },
    event: [{ type: 'task.created', conversation: 'CN·task', row: {
      externalId: 'TK·1', conversationExternalId: 'CN·task', phoneNumberExternalId: 'PNour0001', activityExternalId: null, phoneNumberGroupExternalId: null,
      title: 'Call back', description: 'About pricing', status: 'open', dueDate: 'Date 2026-11-02T17:00:00.000Z', createdByExternalId: 'USowner' } }],
    wire: [{ method: 'POST', path: '/tasks', body: { title: 'Call back', description: 'About pricing', conversationId: 'CN·task', dueDate: '2026-11-02T17:00:00.000Z', assignedTo: 'USdev' } }],
    agree: true,
  },
  'tasks.readIsWhole': {
    row: { externalId: 'TK·1', conversationExternalId: 'CN·task', phoneNumberExternalId: 'PNour0001', activityExternalId: null, phoneNumberGroupExternalId: null,
      title: 'Call back', description: 'About pricing', status: 'open', dueDate: 'Date 2026-11-02T17:00:00.000Z',
      assignedToExternalId: 'USdev', assignedByExternalId: 'USowner', createdByExternalId: 'USowner', createdAt: 'string', revision: 1 },
    columns: 14, wire: [{ method: 'GET', path: '/tasks/TK·1', body: null }],
  },
  'tasks.updateSendsBoth': {
    answer: { externalId: 'TK·1', title: 'Call back today', description: 'About pricing', revision: 2 },
    event:  [{ type: 'task.updated', conversation: 'CN·task', row: { externalId: 'TK·1', title: 'Call back today' } }],
    wire:   [{ method: 'PATCH', path: '/tasks/TK·1', body: { title: 'Call back today', description: 'About pricing' } }],
  },
  'tasks.refusedBeforeSending': {
    titleAlone: 400, statusInPatch: true, noDescription: 400, notAConversation: 400, systemAssignee: 400, notATaskKey: 400,
    badStatus: true, notATask: true, badDue: true, assignNotUser: true, linkNotConversation: true, reached: 0,
  },
  'tasks.statusAndDelete': {
    answers: [
      { externalId: 'TK·1', status: 'completed', revision: 3 }, { externalId: 'TK·1', status: 'open', revision: 4 },
      { externalId: 'TK·1', status: 'deleted' }, { externalId: 'TK·1', status: 'deleted' },
    ],
    event: ['completed', 'open', 'deleted'].map((status, i) => ({ type: `task.${['completed', 'reopened', 'deleted'][i]}`, conversation: 'CN·task', row: { externalId: 'TK·1', status } })),
    stillRead: 'deleted',
    wire: [
      { method: 'PATCH', path: '/tasks/TK·1/status', body: { status: 'completed' } }, { method: 'PATCH', path: '/tasks/TK·1/status', body: { status: 'open' } },
      { method: 'DELETE', path: '/tasks/TK·1', body: null }, { method: 'DELETE', path: '/tasks/TK·1', body: null }, { method: 'GET', path: '/tasks/TK·1', body: null },
    ],
  },
  'tasks.eachCallAndItsEvent': {
    answers: [
      { externalId: 'TK·2', conversationExternalId: 'CN·other', revision: 2 }, { externalId: 'TK·2', conversationExternalId: null, revision: 3 },
      { externalId: 'TK·2', assignedToExternalId: 'USamy', revision: 4 }, { externalId: 'TK·2', assignedToExternalId: null, revision: 5 },
      { externalId: 'TK·2', dueDate: 'Date 2026-11-02T17:00:00.000Z', revision: 6 }, { externalId: 'TK·2', dueDate: null, revision: 7 },
    ],
    events: [
      { type: 'task.linked', conversation: 'CN·other', row: { externalId: 'TK·2', conversationExternalId: 'CN·other', phoneNumberExternalId: 'PNour0001', activityExternalId: null, phoneNumberGroupExternalId: null } },
      { type: 'task.unlinked', conversation: 'CN·other', row: { externalId: 'TK·2', conversationExternalId: null } },
      { type: 'task.assigned', conversation: null, row: { externalId: 'TK·2', assignedToExternalId: 'USamy', assignedByExternalId: 'USowner' } },
      { type: 'task.unassigned', conversation: null, row: { externalId: 'TK·2', assignedToExternalId: null } },
      { type: 'task.duedate.updated', conversation: null, row: { externalId: 'TK·2', dueDate: 'Date 2026-11-02T17:00:00.000Z' } },
      { type: 'task.duedate.removed', conversation: null, row: { externalId: 'TK·2', dueDate: null } },
    ],
    wire: [
      { method: 'POST', path: '/tasks/TK·2/conversations', body: { conversationId: 'CN·other' } }, { method: 'DELETE', path: '/tasks/TK·2/conversations', body: { conversationId: 'CN·other' } },
      { method: 'POST', path: '/tasks/TK·2/users', body: { userId: 'USamy' } }, { method: 'DELETE', path: '/tasks/TK·2/users', body: { userId: 'USamy' } },
      { method: 'PATCH', path: '/tasks/TK·2/due-date', body: { dueDate: '2026-11-02T17:00:00.000Z' } }, { method: 'DELETE', path: '/tasks/TK·2/due-date', body: null },
    ],
  },
  'tasks.lostWriteIsReplayed': {
    unlink: { error: null, row: { externalId: 'TK·2', conversationExternalId: null }, sent: 2 },
    assign: { error: null, row: { externalId: 'TK·2', assignedToExternalId: 'USamy', revision: 10 }, sent: 2 },
    update: { title: 'Send the quote', sent: 2 },
    create: { status: 504, open: true, sent: 1 },
    held:   { conversation: null, assignee: 'USamy' },
  },
  'tasks.openLimitIsQuota': { reopen: { kind: 'quota', retryable: false, row: null }, create: { status: 422, named: true } },
  'tasks.overdueAndTheWholeBook': {
    event: [{ type: 'task.overdue', conversation: 'CN·other', row: { externalId: 'TK·3', dueDate: 'Date 2026-01-05T09:00:00.000Z' } }],
    book:  { error: null, truncated: false, rows: [['TK·3', 'open', 14], ['TK·lost', 'open', 14], ['TK·2', 'completed', 14], ['TK·1', 'deleted', 14]] },
  },

  'numbers.readIsWhole': {
    row: {
      externalId: 'PNour0001', groupExternalId: 'GRour0001', name: 'Main line', phoneNumber: '+15550001111', formattedNumber: '(555) 000-1111', forward: null,
      portRequestExternalId: null, portingStatus: null, symbol: null, createdAt: 'Date 2025-06-01T12:00:00.000Z', updatedAt: 'Date 2025-06-01T12:00:00.000Z',
      restrictions: { calling: { CA: 'unrestricted', Intl: 'restricted', US: 'unrestricted' }, messaging: { CA: 'unrestricted', Intl: 'restricted', US: 'unrestricted' } },
      businessHours: { enabled: false, timezone: 'America/Los_Angeles', schedule: null },
    },
    wire: [{ method: 'GET', path: '/phone-numbers/PNour0001', query: '?include=restrictions,businessHours', body: null }],
  },
  'numbers.updateThroughTheClaim': {
    renamed: {
      name: 'Front desk', restrictions: false, moved: true,
      businessHours: { enabled: true, timezone: 'America/New_York', schedule: { monday: { start: '0900', end: '1700' }, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null, sunday: null } },
    },
    cleared: { enabled: true, timezone: 'America/New_York', schedule: null },
    wire: [
      { method: 'PATCH', path: '/phone-numbers/PNour0001', query: '', body: { name: 'Front desk', businessHours: { enabled: true, timezone: 'America/New_York', schedule: { monday: { start: '0900', end: '1700' }, sunday: null } } } },
      { method: 'PATCH', path: '/phone-numbers/PNour0001', query: '', body: { businessHours: { schedule: null } } },
    ],
  },
  'numbers.refusedBeforeSending': {
    notANumber: true, empty: 400, nameCleared: 400, nameTooLong: 400, hoursEmpty: 400, scheduleEmpty: 400, notADay: true, badWindow: 400, notIana: true,
    settingInPatch: true, quoSetsIt: true, settingsEmpty: true, disclosureEmpty: true, badDisclosure: true, membersNotANumber: true, tooMany: true, reached: 0,
  },
  'numbers.settingsAreTheirOwnRead': {
    before: { externalId: 'PNour0001', autoRecord: false, callDisclosure: { inbound: 'disabled', outbound: 'disabled' } },
    after:  { externalId: 'PNour0001', autoRecord: true, callDisclosure: { inbound: 'voice', outbound: 'disabled' } },
    wire: [
      { method: 'GET', path: '/phone-numbers/PNour0001/settings', query: '', body: null },
      { method: 'PATCH', path: '/phone-numbers/PNour0001/settings', query: '', body: { autoRecord: true, callDisclosure: { inbound: 'voice' } } },
    ],
  },
  'numbers.lostWriteIsReplayed': { rename: { name: 'Front desk', sent: 2 }, settings: { error: null, autoRecord: false, sent: 2 } },
  'numbers.backfillIsTheBook': {
    error: null, truncated: false, rows: 54, restrictions: true, businessHours: 0, ours: 'Front desk',
    wire: ['?include=restrictions&limit=50', '?include=restrictions&limit=50&after=…'],
  },
  'numbers.membersAllOrNothing': {
    ours: { externalId: 'PNour0001', memberExternalIds: ['USamy', 'USdev', 'USowner'] }, roles: ['member', 'admin', 'owner'],
    big: { count: 52, byId: true }, reads: 3, partial: { row: null, kind: 'forbidden' },
  },
  'numbers.availableIsALook': {
    area: ['+14155550301', '+14155550302'], tollFree: ['+18885550304', '+18335550305'], canada: ['+16045550306'],
    wire: ['?areaCode=415&limit=2', '?tollFree=true', '?countryCode=CA&inLocality=Vancouver'],
  },
  'numbers.unknownIsGone': { read: 'gone', settings: 'gone', update: 404 },

  'users.readIsWhole': {
    row: OLIVE,
    wire: [{ method: 'GET', path: '/users/USowner', query: '' }],
  },
  'users.memberRowLeavesOut': {
    columns: ['email', 'externalId', 'firstName', 'lastName', 'role'],
    upserted: OLIVE, systemActor: null,
  },
  'users.backfillIsTheBook': {
    error: null, truncated: false, rows: 55, whole: true, byId: true,
    wire: [{ method: 'GET', path: '/users', query: '?limit=50' }, { method: 'GET', path: '/users', query: '?limit=50&after=…' }],
  },
  'users.numbersOfAUser': {
    dev: [['PNour0001', true, false, false]], amy: { rows: 52, error: null }, nobody: { rows: [], error: null }, partial: { rows: 50, kind: 'forbidden' },
    wire: [
      { method: 'GET', path: '/users/USdev/phone-numbers', query: '?include=restrictions&limit=50' },
      { method: 'GET', path: '/users/USamy/phone-numbers', query: '?include=restrictions&limit=50' },
      { method: 'GET', path: '/users/USamy/phone-numbers', query: '?include=restrictions&limit=50&after=…' },
      { method: 'GET', path: '/users/USnobody/phone-numbers', query: '?include=restrictions&limit=50' },
    ],
  },
  'organization.read': {
    row: { externalId: 'ORdev', name: 'Dev Workspace', subscriptionStatus: 'active', createdAt: 'Date 2025-04-01T12:00:00.000Z', updatedAt: 'Date 2025-04-01T12:00:00.000Z' },
    notAnOrg: null, lapsed: { status: 'expired', name: null },
    wire: [{ method: 'GET', path: '/organization', query: '' }, { method: 'GET', path: '/organization', query: '' }],
  },
  'users.refusedBeforeSending': { notAUser: true, barePrefix: true, numbersNone: true, reached: 0 },
  'users.unknownIsGone': { read: 'gone' },

  'a2p.noneIsNull': { registration: null, error: null, notARegistration: null, wire: [{ method: 'GET', path: '/a2p-registration', version: '2026-03-30' }] },
  'a2p.quoRefusals': {
    lapsed: { kind: 'billing', retryable: false }, ein: { kind: 'refused', nine: true },
    wire: [{ method: 'POST', path: '/a2p-registration', version: '2026-03-30' }, { method: 'POST', path: '/a2p-registration', version: '2026-03-30' }],
  },
  'a2p.createIsADraft': {
    error: null, id: true, draft: true, status: 'pending', type: null, times: [true, true, null],
    name: 'Knight Works LLC', line2: null, messaging: { useCase: null, personalUse: null, consent: null },
    sent: ['address', 'alternateName', 'avgDailyCallVolume', 'businessType', 'companyType', 'employeeCount', 'exchange', 'idNumber', 'idType', 'industry', 'messageTypes', 'name', 'personOfContact', 'regionsOfOperation', 'ticker', 'websiteUrl'],
    messageTypesKept: false,
  },
  'a2p.createNotReplayed': { kind: 'timeout', indeterminate: true, posts: 1, found: true, again: { kind: 'refused', one: true } },
  'a2p.updateMerges': {
    sent: { address: { city: 'Oakland' }, ticker: null, employeeCount: 9 },
    address: { line1: '1 Main St', line2: null, city: 'Oakland', region: 'OR', postalCode: '97201', country: 'US' }, ticker: null, messaging: true,
    lost: { error: null, employees: 12, patches: 2 },
  },
  'a2p.submitWaitsForAutofill': {
    early: { kind: 'refused', retryable: true, autofill: true },
    after: { error: null, draft: false, status: 'pending', first: true, useCase: 'customer_support' },
    payments: 1,
    wire: [
      { method: 'PATCH', path: '/a2p-registration', version: '2026-03-30' },
      { method: 'POST', path: '/a2p-registration/submit', version: '2026-03-30' },
      { method: 'GET', path: '/a2p-registration', version: '2026-03-30' },
      { method: 'POST', path: '/a2p-registration/submit', version: '2026-03-30' },
    ],
  },
  'a2p.updateAfterSubmitRefused': { kind: 'refused', draft: true },
  'a2p.verdictIsRead': { status: 'rejected', draft: false, messages: [{ errorCode: 504, errorReason: 'The EIN does not match the name', fields: ['idNumber', 'name'] }] },
  'a2p.rejectedConflictIsNotDone': { conflict: { kind: 'refused', retryable: false }, unpaid: { kind: 'billing', retryable: false }, payments: 1, status: 'rejected' },
  'a2p.lostSubmitIsRead': {
    kind: 'timeout', indeterminate: true, submits: 1,
    retried: { error: null, status: 'pending', draft: false }, payments: 2,
    wire: [{ method: 'POST', path: '/a2p-registration/submit', version: '2026-03-30' }, { method: 'GET', path: '/a2p-registration', version: '2026-03-30' }],
  },
  'a2p.refusedBeforeSending': {
    missing: true, nestedGone: true, industry: true, phone: true, email: true, noRegions: true, sixRegions: true, url: true, noTypes: true, count: true,
    empty: true, emptyPart: true, unknown: true, nullName: true, autofill: true, contactName: true, noAck: true, reached: 0,
  },

  'auth.wrongKey':                   { kind: 'auth_failed' },
}))
