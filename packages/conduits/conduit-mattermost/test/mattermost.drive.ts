// test/mattermost.drive.ts — the connector against the sink. No fixture.
// What only this drive asks: a human's post leaves with THAT human's token
// and never the service's; a post with the caller's `pendingPostId` is
// replayed by conduit after a lost answer and the channel holds one message,
// while one without it is `indeterminate` and conduit sends nothing twice; a
// 403 is `forbidden` and not a bad key; the mirror claim parses every noun to
// a row keyed once and its composite keys read back through `delete`. And
// what Mattermost DELIVERS: a post with a trigger word arrives as a `webhook`
// event, form or JSON alike, verified by the hook's own token from body or
// header, applied once when delivered twice; a slash command arrives as a
// `command` event and is answered through its `response_url`, never through
// conduit's answer body; a token the app never registered is one 401. And
// what Mattermost PUSHES: the socket is a broker target conduit dials, the
// framing proves the token by header or by challenge, and a post, its edit
// and its delete land in order as rows through conduit's receipt order; a
// frame sent twice applies once, an unreadable one is counted, a reconnect
// is a new connection whose `seq` cannot collide with the old one's, and a
// token Mattermost refuses never reads as connected. And what a mirror's sync
// reads: each person's own socket carries what only they may see, a new
// connection calls `opened` before its first frame, and the backfill pages
// `since` past its cap, lists direct and archived channels, and reads a post's
// reactions off its metadata.

import { createConduit } from '@frontierjs/conduit'
import type { ConduitError, CredentialResolver, Delivery } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '@frontierjs/conduit/testing'
import { startMattermostSink } from '../sink.ts'
import {
  mattermostTargets, bindMattermost, uploadFile, fileBytes, postMessage, listPosts, listChannels, listTeams, listMembers, listProfiles, postsSince, me, translate,
  viewChannel, listThreads, getThread, markThreadRead,
  mirror, postModel, channelModel, channelMemberModel, reactionModel, threadModel, teamModel, profileModel, fileInfoModel, memberKey, reactionKey, threadKey,
  mattermostWebhookDialect, mattermostCommandDialect, verifyMattermostToken, respond,
  mattermostSocketTarget, mattermostSocketDialect, MATTERMOST_SOCKET_TARGET, type SocketEvent,
  MATTERMOST_TARGET, MATTERMOST_USER_TARGET, MATTERMOST_UPLOAD_TARGET, type MattermostSend, type WebhookEventPayload, type CommandEventPayload,
} from '../src/index.ts'

const { got, t } = results()
const sink = startMattermostSink(), ctl = control(sink.url), ids = sink.ids

// The service token is the process's; a user's token is read for the caller
// the send names, which under junction is the principal of the call in progress.
const credentials: CredentialResolver = {
  async get(ref) { return ref === 'MATTERMOST_TOKEN' ? sink.tokens.service : null },
  async getFor(ref, who) {
    if (ref !== 'MATTERMOST_USER_TOKEN') return null
    return who.principal === ids.alice ? sink.tokens.alice : who.principal === ids.bob ? sink.tokens.bob : null
  },
}
const conduit = createConduit({ credentials, ...DRIVE_RESILIENCE })
const targets = mattermostTargets({ address: sink.url })
for (const target of Object.values(targets)) await conduit.register(target)
const service = bindMattermost(conduit, targets, { as: 'service' })
// Junction writes `who` from the call in progress; here each person's bundle is
// bound over a conduit that names them on every send.
const as = (principal: string) => bindMattermost({ send: req => conduit.send({ ...req, who: { tenant: null, principal, grant: null } }) }, targets, { as: 'user' })
const alice = as(ids.alice), bob = as(ids.bob)
type Seen = {
  requests: { method: string; path: string; headers: Record<string, string>; body: string; status: number }[]; posts: number; reactions: number; members: number
  deliveries: { kind: string; url: string; contentType: string; headers: Record<string, string>; body: string; status: number | null; answered: { outcome?: string } | null }[]
  replies: { via: string; kind: string; response_type: string; text: string; user_id?: string; channel_id: string }[]
  allPosts: { id: string; user_id: string; root_id: string; message: string }[]
  sockets: { connectionId: string; user: string | null; authBy: string | null; frames: number; pings: number; open: boolean }[]
}
const seen = () => ctl.seen() as unknown as Promise<Seen>
const ID = /^[a-z0-9]{26}$/
const fail = (kind: ConduitError['kind'], raw: unknown, extra: Partial<ConduitError> = {}): ConduitError => ({ kind, target: MATTERMOST_TARGET, protocol: 'http', message: kind, retryable: false, raw, ...extra })

// What the junction plugin does at `app.post(receiver.path)`, without junction:
// the request becomes a Delivery and conduit's order answers it. The app's
// side of each receiver: a hook's key is chosen by its trigger word and a
// command's by its trigger, before the body is believed (FJS-1804's shape),
// so a token the app never registered selects no key and is refused.
const hookTokens: Record<string, string> = {}, commandTokens: Record<string, string> = {}
const field = (d: Delivery, k: string) => String((d.body as Record<string, unknown> | null)?.[k] ?? '')
const landed = { webhook: [] as WebhookEventPayload[], command: [] as CommandEventPayload[] }
const responded: string[] = []
conduit.receive({
  provider: 'mattermost', path: '/hooks/mattermost', dialect: mattermostWebhookDialect,
  credential: d => hookTokens[field(d, 'trigger_word')] ?? null,
  async apply(ev) {
    landed.webhook.push(ev.payload)
    if (ev.payload.triggerWord === 'weather') await postMessage(service, { channelExternalId: ev.payload.channelExternalId, message: `Forecast for ${ev.payload.userName}: sun`, rootExternalId: ev.payload.postExternalId })
    return 'applied' as const
  },
})
conduit.receive({
  provider: 'mattermost', path: '/commands/mattermost', dialect: mattermostCommandDialect,
  credential: d => commandTokens[field(d, 'command')] ?? null,
  async apply(ev) {
    landed.command.push(ev.payload)
    const r = await respond(service, ev.payload.responseUrl, { text: `${ev.payload.userName} rolled ${ev.payload.text}: 7` })
    responded.push(r.error?.kind ?? 'ok')
    return 'applied' as const
  },
})
const bridge = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url), rawBody = await req.text()
    const body = (req.headers.get('content-type') ?? '').includes('json') ? JSON.parse(rawBody) : Object.fromEntries(new URLSearchParams(rawBody))
    const received = await conduit.accept(url.pathname, { method: req.method, path: url.pathname, query: url.search, route: {}, headers: Object.fromEntries(req.headers), rawBody, body }, Math.floor(Date.now() / 1000))
    return Response.json(received.body, { status: received.status })
  },
})
const api = <T = Record<string, string>>(token: string, path: string, body: unknown) =>
  fetch(`${sink.url}/api/v4${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json() as Promise<T>)

try {
  let threw = ''
  try { mattermostTargets({} as never) } catch (e) { threw = (e as Error).message }
  t('target.refusesNoAddress', { threw: threw.includes('self-hosted') })

  // The bind is where whose token a call spends is chosen; an upload is a
  // person's, so the bot's bundle refuses one before it reaches the wire.
  const renamedIds = mattermostTargets({ address: sink.url, id: 'provider:chat' })
  let noAs = ''
  try { bindMattermost(conduit, targets, {} as never) } catch (e) { noAs = (e as Error).message }
  const boundBefore = (await seen()).requests.length
  let serviceUpload = ''
  try { await uploadFile(service, { channelExternalId: ids.open, name: 'x.png', bytes: new Uint8Array([1]) }) } catch (e) { serviceUpload = (e as Error).message }
  t('bind.asPicksTheCredential', {
    ids: [targets.service.id, targets.user.id, targets.upload.id].join() === [MATTERMOST_TARGET, MATTERMOST_USER_TARGET, MATTERMOST_UPLOAD_TARGET].join(),
    renamedIds: Object.values(renamedIds).map(x => x.id),
    perCaller: [targets.service, targets.user, targets.upload].map(x => !!(x.auth as { per_caller?: boolean }).per_caller),
    binary: targets.upload.encoding,
    noAs: noAs.includes('as:'), serviceUpload: serviceUpload.includes('a person'), unsent: (await seen()).requests.length - boundBefore,
  })

  const first = await postMessage(alice, { channelExternalId: ids.open, message: 'hello from the terminal' })
  const wire = (await seen()).requests.at(-1)!
  t('post.leavesAsItsAuthor', {
    ok: !first.error, bearer: wire.headers.authorization, path: wire.path, body: JSON.parse(wire.body),
    row: { id: ID.test(first.row?.externalId ?? ''), user: first.row?.profileExternalId === ids.alice, channel: first.row?.channelExternalId === ids.open, root: first.row?.rootExternalId, message: first.row?.message, edited: first.row?.editedAt, deleted: first.row?.deletedAt, created: first.row?.createdAt instanceof Date },
  })

  const forbidden = await postMessage(bob, { channelExternalId: ids.secret, message: 'let me in' })
  t('post.notAMemberIsForbidden', { kind: forbidden.error?.kind, code: forbidden.error?.code, retryable: forbidden.error?.retryable })

  const before = (await seen()).requests.length
  let local = ''
  try { await postMessage(alice, { channelExternalId: ids.open, message: '   ' }) } catch (e) { local = (e as Error).message }
  let badId = ''
  try { await postMessage(alice, { channelExternalId: 'general', message: 'x' }) } catch (e) { badId = (e as Error).message }
  t('post.refusedLocallyBeforeTheWire', { emptyMessage: local, badId, sent: (await seen()).requests.length - before })

  await ctl.reset(); await ctl.arm({ lost: true })
  const postsBefore = (await seen()).posts
  const keyed = await postMessage(alice, { channelExternalId: ids.open, message: 'once', pendingPostId: 'tui-0001' })
  const afterKeyed = await seen()
  t('post.lostWithPendingIdReplayedOnce', { ok: !keyed.error, attempts: afterKeyed.requests.length, postsAdded: afterKeyed.posts - postsBefore, pendingEchoed: JSON.parse(afterKeyed.requests[0].body).pending_post_id })

  await ctl.reset(); await ctl.arm({ lost: true })
  const unkeyed = await postMessage(alice, { channelExternalId: ids.open, message: 'maybe' })
  const afterUnkeyed = await seen()
  t('post.lostWithoutPendingIdIsIndeterminate', { kind: unkeyed.error?.kind, retryable: unkeyed.error?.retryable, attempts: afterUnkeyed.requests.length, postsAdded: afterUnkeyed.posts - afterKeyed.posts })

  await ctl.reset(); await ctl.arm({ rateLimit: { reset: 2 } })
  const rl = await postMessage(alice, { channelExternalId: ids.open, message: 'again' })
  t('post.rateLimitedWaitReadOffReset', { kind: rl.error?.kind, retryAfterMs: rl.error?.retryAfterMs, attempts: (await seen()).requests.length })

  await ctl.reset()
  const id = first.row!.externalId
  const pinned = await alice.api<unknown>(postModel.update!(id, { isPinned: true }))
  const pinnedRow = postModel.parse(pinned.data as never)
  const patchWire = (await seen()).requests.at(-1)!
  t('post.patchTouchesOnlyWhatIsPresent', { path: patchWire.path.endsWith(`/posts/${id}/patch`), body: JSON.parse(patchWire.body), isPinned: pinnedRow?.isPinned, message: pinnedRow?.message, editedAt: pinnedRow?.editedAt })

  const bobEdits = await bob.api<unknown>(postModel.update!(id, { message: 'mine now' }))
  const deleted = await alice.api<unknown>(postModel.delete!(id))
  const afterDelete = await alice.api<unknown>(postModel.update!(id, { message: 'too late' }))
  t('post.deleteThenGone', { othersEdit: translate(bobEdits.error!, bobEdits.meta.status).kind, deleted: !deleted.error, then: translate(afterDelete.error!, afterDelete.meta.status).kind })

  const target = (await postMessage(alice, { channelExternalId: ids.open, message: 'react to me' })).row!
  const reacted = await alice.api<unknown>(reactionModel.create!({ postExternalId: target.externalId, profileExternalId: ids.alice, emojiName: 'thumbsup' }))
  const reaction = reactionModel.parse(reacted.data as never)!
  const unreacted = await alice.api<unknown>(reactionModel.delete!(reaction.externalId))
  const unreactWire = (await seen()).requests.at(-1)!
  let badEmoji = ''
  try { reactionModel.create!({ postExternalId: target.externalId, profileExternalId: ids.alice, emojiName: ':thumbsup:' }) } catch (e) { badEmoji = (e as Error).message }
  t('reaction.keyReadsBackThroughDelete', { key: reaction.externalId === reactionKey(target.externalId, ids.alice, 'thumbsup'), deleted: !unreacted.error, path: unreactWire.path === `/api/v4/users/${ids.alice}/posts/${target.externalId}/reactions/thumbsup`, badEmoji: badEmoji.includes('without colons'), left: (await seen()).reactions })

  const joined = await alice.api<unknown>(channelMemberModel.create!({ channelExternalId: ids.secret, profileExternalId: ids.bob }))
  const member = channelMemberModel.parse(joined.data as never)!
  const bobSees = await listPosts(bob, ids.secret)
  const left = await alice.api<unknown>(channelMemberModel.delete!(member.externalId))
  const bobBlind = await listPosts(bob, ids.secret)
  t('member.keyReadsBackThroughDelete', { key: member.externalId === memberKey(ids.secret, ids.bob), joinedCanList: !bobSees.error, left: !left.error, leftCannot: bobBlind.error?.kind })

  const made = await alice.api<unknown>(channelModel.create!({ teamExternalId: ids.team, name: 'design', displayName: 'Design', type: 'private', purpose: 'pixels' }))
  const design = channelModel.parse(made.data as never)!
  const renamed = await alice.api<unknown>(channelModel.update!(design.externalId, { displayName: 'Design & Brand' }))
  const renameWire = (await seen()).requests.at(-1)!
  const dup = await alice.api<unknown>(channelModel.create!({ teamExternalId: ids.team, name: 'design', displayName: 'Again', type: 'open' }))
  const listed = await listChannels(alice, ids.alice, ids.team)
  const gone = await alice.api<unknown>(channelModel.delete!(design.externalId))
  const listedAfter = await listChannels(alice, ids.alice, ids.team)
  let direct = ''
  try { channelModel.create!({ teamExternalId: ids.team, name: 'dm', displayName: 'dm', type: 'direct' as never }) } catch (e) { direct = (e as Error).message }
  t('channel.createPatchDelete', {
    type: design.type, purpose: design.purpose, creator: design.creatorExternalId === ids.alice, patchBody: JSON.parse(renameWire.body),
    renamed: channelModel.parse(renamed.data as never)?.displayName, dup: translate(dup.error!, dup.meta.status).kind, dupCode: translate(dup.error!, dup.meta.status).code,
    listedBefore: listed.rows?.map(c => c.name).sort(), deleted: !gone.error, listedAfter: listedAfter.rows?.map(c => c.name).sort(), directRefused: direct.includes('made by its members'),
  })

  const cursor = Date.now() - 60_000
  const changed = await listPosts(service, ids.open, { since: cursor })
  const page = await listPosts(service, ids.open, { perPage: 2 })
  let twoCursors = ''
  try { await listPosts(service, ids.open, { since: 1, before: 'x' }) } catch (e) { twoCursors = (e as Error).message }
  t('backfill.sinceListsDeletionsToo', {
    sinceHasDeleted: changed.rows?.some(p => p.externalId === id && p.deletedAt instanceof Date),
    sinceHasPinned: changed.rows?.some(p => p.externalId === id && p.isPinned),
    newestFirst: (changed.rows ?? []).every((p, i, xs) => i === 0 || xs[i - 1].createdAt!.getTime() >= p.createdAt!.getTime()),
    pageSize: page.rows?.length, pageExcludesDeleted: !page.rows?.some(p => p.deletedAt), twoCursors: twoCursors.includes('one of'),
  })

  await ctl.reset(); await ctl.arm({ lost: true })
  const teams = await listTeams(service, ids.bot)
  const who = await me(alice)
  const roster = await listMembers(service, ids.open)
  t('backfill.readsAreReplayedByConduit', { attempts: (await seen()).requests.filter(r => r.path.endsWith('/teams')).length, teams: teams.rows?.map(x => [x.name, x.type]), me: who.row?.username, roster: roster.rows?.map(m => m.profileExternalId).sort(), isAdmin: roster.rows?.every(m => m.isAdmin === false) })

  const models = Object.entries(mirror.models)
  const verbs = models.flatMap(([name, m]) => (['create', 'update', 'delete'] as const).filter(v => m[v]).map(v => `${name}.${v}`))
  const human = models.filter(([, m]) => m.create || m.update || m.delete).every(([, m]) => m.target === MATTERMOST_USER_TARGET)
  const sample = postModel.create!({ channelExternalId: ids.open, message: 'x' })
  t('mirror.claimShape', {
    provider: mirror.provider, models: models.map(([n]) => n), keys: models.every(([, m]) => m.key === 'externalId'), verbs, humanVerbsSpendTheUser: human,
    verbNamesNoTarget: !('target' in sample), parseRefusesGarbage: models.every(([, m]) => { try { return m.parse({}, { profileExternalId: ids.alice }) === null } catch { return false } }),
  })

  // The claim bound the way an app binds it, and run through conduit's forward:
  // the junction plugin writes `who` from the call in progress, emulated here
  // as `bridge` emulates its route, and junction lands the row it answers.
  const bound = createConduit({ credentials, ...DRIVE_RESILIENCE })
  await bound.register(mattermostTargets({ address: sink.url }).user)
  let caller = ids.alice
  const rawSend = bound.send
  bound.send = (req => rawSend({ ...req, who: { tenant: null, principal: caller, grant: null } })) as typeof bound.send
  bound.mirror(mirror)
  const fwd = bound.mirrored('post')!
  await ctl.reset()
  const fwdMade = await fwd.create!({ channelExternalId: ids.open, message: 'through the claim' })
  const fwdWire = (await seen()).requests.at(-1)!
  t('mirror.forwardCreatesAsTheCaller', { bearer: fwdWire.headers.authorization, path: fwdWire.path, key: ID.test(String(fwdMade?.externalId)), user: fwdMade?.profileExternalId === ids.alice, message: fwdMade?.message })
  const edited = await fwd.update!(String(fwdMade!.externalId), { message: 'edited through the claim' })
  const removed = await fwd.remove!(String(fwdMade!.externalId))
  const status = async (fn: () => Promise<unknown>) => { try { await fn(); return null } catch (e) { return (e as { status?: number }).status ?? 'none' } }
  const editAfter = await status(() => fwd.update!(String(fwdMade!.externalId), { message: 'too late' }))
  t('mirror.forwardPatchAnswersTheRowDeleteAnswersNone', { edited: edited?.message, sameKey: edited?.externalId === fwdMade?.externalId, removed, editAfter })
  caller = ids.bob
  const fwdBefore = (await seen()).requests.length
  const unbuilt = await status(() => fwd.create!({ channelExternalId: ids.open, message: '  ' }))
  const unsent  = (await seen()).requests.length - fwdBefore
  const notMember = await status(() => fwd.create!({ channelExternalId: ids.secret, message: 'let me in' }))
  t('mirror.forwardRefusalCarriesAStatus', { unbuilt, unsent, notMember, team: Object.keys(bound.mirrored('team')!).filter(k => ['create', 'update', 'remove'].includes(k)), unclaimed: bound.mirrored('lead') })
  await bound.destroy()

  let noScope = ''
  try { threadModel.parse({ id: ids.open, reply_count: 1, last_reply_at: 1, last_viewed_at: 0, unread_replies: 1, unread_mentions: 0 }) } catch (e) { noScope = (e as Error).message }
  const thread = threadModel.parse({ id: target.externalId, reply_count: 2, last_reply_at: 5, last_viewed_at: 0, unread_replies: 2, unread_mentions: 1 }, { profileExternalId: ids.bob })!
  t('thread.isOneUsersView', { noScope: noScope.includes('scope.profileExternalId'), key: thread.externalId === threadKey(ids.bob, target.externalId), root: thread.rootExternalId === target.externalId, unread: thread.unreadReplies })

  const team = teamModel.parse({ id: ids.team, create_at: 1, update_at: 1, delete_at: 0, display_name: 'Town', name: 'town', description: '', type: 'I', allow_open_invite: false })!
  const user = profileModel.parse({ id: ids.alice, create_at: 1, update_at: 1, delete_at: 0, username: 'alice', roles: 'system_user system_admin', email: '' })!
  const file = fileInfoModel.parse({ id: ids.open, user_id: ids.alice, post_id: '', create_at: 1, update_at: 1, delete_at: 0, name: 'a.png', extension: 'png', size: 2, mime_type: 'image/png', width: 1, height: 1, has_preview_image: true })!
  t('mirror.timesAndCodesAreWords', { teamType: team.type, deleted: team.deletedAt, created: team.createdAt?.toISOString(), roles: user.roles, emailWithheld: !('email' in user), filePost: file.postExternalId, mime: file.mimeType })

  const body = (id: string) => JSON.stringify({ id, message: 'm', status_code: 0 })
  t('translate.statusIsTheKind', {
    forbidden: translate(fail('auth_failed', body('api.context.permissions.app_error')), 403).kind,
    gone:      translate(fail('client_error', body('app.post.get.app_error')), 404).kind,
    refused:   translate(fail('client_error', body('model.post.is_valid.app_error')), 400).code,
    reset:     translate(fail('rate_limited', 'You have reached the maximum number of requests.', { retryable: true }), 429, { 'x-ratelimit-reset': '7' }).retryAfterMs,
    server:    translate(fail('server_error', body('api.context.500.app_error'), { retryable: true }), 500).kind,
    unauth:    translate(fail('auth_failed', body('api.context.session_expired.app_error')), 401).kind,
  })

  // ─── What Mattermost delivers (2.2) ─────────────────────────
  // Registering a hook and a command is the admin's, done here by hand against the sink: the connector has no verb for it.
  const hookUrl = `http://127.0.0.1:${bridge.port}/hooks/mattermost`, commandUrl = `http://127.0.0.1:${bridge.port}/commands/mattermost`
  const formHook = await api(sink.tokens.service, '/hooks/outgoing', { channel_id: ids.open, trigger_words: ['weather'], callback_urls: [hookUrl], content_type: 'application/x-www-form-urlencoded', display_name: 'Weather' })
  const jsonHook = await api(sink.tokens.service, '/hooks/outgoing', { channel_id: ids.open, trigger_words: ['!ping'], callback_urls: [hookUrl], content_type: 'application/json', display_name: 'Ping' })
  const roll = await api(sink.tokens.service, '/commands', { team_id: ids.team, trigger: 'roll', method: 'P', url: commandUrl, display_name: 'Roll' })
  await api(sink.tokens.service, '/commands', { team_id: ids.team, trigger: 'evil', method: 'P', url: commandUrl })
  hookTokens.weather = formHook.token; hookTokens['!ping'] = jsonHook.token; commandTokens['/roll'] = roll.token
  await ctl.reset()

  const asked = await postMessage(alice, { channelExternalId: ids.open, message: 'weather tomorrow?' })
  const s1 = await seen()
  const d1 = s1.deliveries[0], w1 = landed.webhook.at(-1)!
  t('webhook.firesAsFormWithTokenTwice', {
    contentType: d1.contentType, header: d1.headers.authorization === `Token ${formHook.token}`, bodyToken: new URLSearchParams(d1.body).get('token') === formHook.token, status: d1.status, outcome: d1.answered?.outcome,
    event: { post: w1.postExternalId === asked.row!.externalId, user: w1.profileExternalId === ids.alice, userName: w1.userName, channel: w1.channelExternalId === ids.open, channelName: w1.channelName, team: w1.teamExternalId === ids.team, teamDomain: w1.teamDomain, trigger: w1.triggerWord, text: w1.text, at: w1.at?.getTime() === asked.row!.createdAt?.getTime(), files: w1.fileExternalIds },
  })
  const threadReply = s1.allPosts.find(p => p.root_id === asked.row!.externalId)
  t('webhook.replyIsTheBotsPostInThread', { byBot: threadReply?.user_id === ids.bot, message: threadReply?.message, bodyRepliesUsed: s1.replies.length, deliveries: s1.deliveries.length })

  const pinged = await postMessage(bob, { channelExternalId: ids.open, message: '!ping now' })
  const s2 = await seen()
  const d2 = s2.deliveries.at(-1)!, w2 = landed.webhook.at(-1)!
  t('webhook.jsonEncodingParsesTheSame', { contentType: d2.contentType, timestampIsNumber: typeof JSON.parse(d2.body).timestamp, status: d2.status, post: w2.postExternalId === pinged.row!.externalId, user: w2.profileExternalId === ids.bob, trigger: w2.triggerWord, text: w2.text, at: w2.at?.getTime() === pinged.row!.createdAt?.getTime() })

  await ctl.reset(); await ctl.arm({ deliverTwice: true })
  const appliedBefore = landed.webhook.length
  await postMessage(alice, { channelExternalId: ids.open, message: 'weather again' })
  const s3 = await seen()
  t('webhook.deliveredTwiceAppliedOnce', { deliveries: s3.deliveries.length, statuses: s3.deliveries.map(d => d.status), outcomes: s3.deliveries.map(d => d.answered?.outcome), applied: landed.webhook.length - appliedBefore, threadReplies: s3.allPosts.filter(p => p.root_id && p.message.startsWith('Forecast')).length })

  await ctl.reset()
  await postMessage(alice, { channelExternalId: ids.open, message: 'nice weather' })
  t('webhook.firstWordOnly', { delivered: (await seen()).deliveries.length })

  await ctl.reset()
  const exec = await api<{ text?: string }>(sink.tokens.bob, '/commands/execute', { channel_id: ids.open, command: '/roll 2d6' })
  const s4 = await seen()
  const d4 = s4.deliveries[0], c4 = landed.command.at(-1)!
  t('command.arrivesWithHeaderToken', {
    contentType: d4.contentType, header: d4.headers.authorization === `Token ${roll.token}`, status: d4.status,
    event: { command: c4.command, text: c4.text, user: c4.profileExternalId === ids.bob, userName: c4.userName, channel: c4.channelExternalId === ids.open, channelName: c4.channelName, teamDomain: c4.teamDomain, triggerId: c4.triggerId.startsWith('trig'), responseUrl: c4.responseUrl.startsWith(`${sink.url}/hooks/commands/`) },
  })
  const r4 = s4.replies.at(-1)
  t('command.replyGoesThroughResponseUrl', { via: r4?.via, responseType: r4?.response_type, text: r4?.text, toUser: r4?.user_id === ids.bob, answerBodyHadNoText: exec.text === undefined, responded })

  await ctl.reset()
  const bad = await api<{ id?: string }>(sink.tokens.bob, '/commands/execute', { channel_id: ids.open, command: '/evil rm -rf' })
  const s5 = await seen()
  t('command.unregisteredTokenIsOne401', { status: s5.deliveries[0].status, mattermostSaid: bad.id, landed: landed.command.length, replies: s5.replies.length })

  const v = (token: string | null, authorization: string | null) => verifyMattermostToken({ token, authorization, credential: 'secret-1' }).ok
  t('verify.everyTokenPresentMustMatch', { body: v('secret-1', null), header: v(null, 'Token secret-1'), both: v('secret-1', 'Token secret-1'), bodyWrong: v('nope', 'Token secret-1'), headerWrong: v('secret-1', 'Token nope'), bearer: v(null, 'Bearer secret-1'), none: v(null, null), noCredential: verifyMattermostToken({ token: 'x', credential: undefined }).ok })

  const dl = (path: string, body: Record<string, unknown>): Delivery => ({ method: 'POST', path, query: '', route: {}, headers: {}, rawBody: JSON.stringify(body), body })
  const nowS = Math.floor(Date.now() / 1000), webhookBody = { trigger_word: 'weather', post_id: ids.open, channel_id: ids.open, user_id: ids.alice, team_id: ids.team, text: 'weather' }
  const landedBefore = landed.webhook.length + landed.command.length
  const noTrigger  = await conduit.accept('/commands/mattermost', dl('/commands/mattermost', { token: roll.token, command: '/roll', text: '', channel_id: ids.open, user_id: ids.bob, team_id: ids.team }), nowS)
  const garbage    = await conduit.accept('/hooks/mattermost', dl('/hooks/mattermost', { token: formHook.token, trigger_word: 'weather', hello: 'world' }), nowS)
  const forged     = await conduit.accept('/hooks/mattermost', dl('/hooks/mattermost', { ...webhookBody, token: 'forged' }), nowS)
  const otherHook  = await conduit.accept('/hooks/mattermost', dl('/hooks/mattermost', { ...webhookBody, trigger_word: 'other', token: formHook.token }), nowS)
  t('dialect.conduitOrder', { noTriggerId: noTrigger.result, garbage: garbage.result, forged: forged.status, unknownHook: otherHook.status, landed: landed.webhook.length + landed.command.length - landedBefore })

  const sentBefore = (await seen()).requests.length
  let badUrl = '', noText = ''
  try { await respond(service, 'ftp://chat.example/x', { text: 'x' }) } catch (e) { badUrl = (e as Error).message }
  try { await respond(service, `${sink.url}/hooks/commands/${ids.open}`, {}) } catch (e) { noText = (e as Error).message }
  const expired = await respond(service, `${sink.url}/hooks/commands/${ids.open}`, { text: 'late' })
  t('respond.refusedLocallyAndExpiredIsGone', { badUrl: badUrl.includes('response_url'), noText: noText.includes('text or attachments'), sent: (await seen()).requests.length - sentBefore, expired: expired.error?.kind })

  // ─── The socket ──────────────────────────────────────────────
  const until = async (cond: () => boolean | Promise<boolean>, ms = 4000) => { const end = Date.now() + ms; while (!(await cond()) && Date.now() < end) await new Promise(r => setTimeout(r, 20)); return cond() }
  const frames: SocketEvent[] = []
  let throwOnce = false
  const socketReceiver = {
    provider: 'mattermost', target: MATTERMOST_SOCKET_TARGET, dialect: mattermostSocketDialect,
    // A create writes more than an edit, so it is the slower apply: a handoff that does not wait would land the edit first.
    async apply(ev: SocketEvent) {
      if (throwOnce) { throwOnce = false; throw new Error('database is locked') }
      if (ev.type === 'posted') await new Promise(r => setTimeout(r, 40))
      frames.push(ev); return 'applied' as const
    },
  }
  await conduit.register(mattermostSocketTarget({ address: sink.url }))
  const refusal = (r: unknown) => (conduit.receive(r as never) as unknown as Promise<void>).then(() => 'accepted', (e: Error) => e.message)
  const refusals = {
    path:       await refusal({ ...socketReceiver, path: '/socket' }),
    credential: await refusal({ ...socketReceiver, credential: 'MATTERMOST_TOKEN' }),
    verify:     await refusal({ ...socketReceiver, dialect: { ...mattermostSocketDialect, verify: () => ({ ok: true }) } }),
  }
  await ctl.reset()
  await conduit.receive(socketReceiver)
  const second = await refusal(socketReceiver)
  t('socket.receiverRefusesWhatARouteHas', { path: refusals.path.includes('no path'), credential: refusals.credential.includes('no credential'), verify: refusals.verify.includes('nothing to verify'), second: second.includes('already declared'), routes: (await seen()).requests.length })

  const health = () => conduit.stats().subscriptions[MATTERMOST_SOCKET_TARGET]!
  const counts = () => conduit.stats().received[MATTERMOST_SOCKET_TARGET]!
  const firstConn = (await seen()).sockets.at(-1)!
  t('socket.dialAuthenticatesByHeader', { connected: health().connected, user: firstConn.user === ids.bot, authBy: firstConn.authBy, helloOnly: firstConn.frames })

  const live = await postMessage(alice, { channelExternalId: ids.open, message: 'over the socket' })
  await until(() => frames.length >= 1)
  const p0 = frames[0]
  t('socket.postLandsAsRow', { type: p0?.type, same: p0?.type === 'posted' && p0.payload.post.externalId === live.row?.externalId, user: p0?.type === 'posted' && p0.payload.post.profileExternalId === ids.alice, message: p0?.type === 'posted' && p0.payload.post.message, keyed: p0?.id.startsWith(`${firstConn.connectionId}:`), applied: counts().applied })

  // Back to back, so the three frames are in flight together.
  const quick = await postMessage(alice, { channelExternalId: ids.open, message: 'quick' })
  await fetch(`${sink.url}/api/v4/posts/${quick.row!.externalId}/patch`, { method: 'PUT', headers: { authorization: `Bearer ${sink.tokens.alice}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'edited' }) })
  await fetch(`${sink.url}/api/v4/posts/${quick.row!.externalId}`, { method: 'DELETE', headers: { authorization: `Bearer ${sink.tokens.alice}` } })
  await until(() => frames.length >= 4)
  const trio = frames.slice(1, 4)
  t('socket.editThenDeleteInOrder', { types: trio.map(f => f.type), edited: trio[1]?.type === 'post_edited' && trio[1].payload.post.message, deleted: trio[2]?.type === 'post_deleted' && trio[2].payload.post.deletedAt instanceof Date })

  const room0 = await api<{ id: string }>(sink.tokens.alice, '/channels', { team_id: ids.team, name: 'sockets', display_name: 'Sockets', type: 'O' })
  await api(sink.tokens.alice, `/channels/${room0.id}/members`, { user_id: ids.bot })
  await fetch(`${sink.url}/api/v4/channels/${room0.id}/patch`, { method: 'PUT', headers: { authorization: `Bearer ${sink.tokens.alice}`, 'content-type': 'application/json' }, body: JSON.stringify({ display_name: 'Socket Room' }) })
  await fetch(`${sink.url}/api/v4/channels/${room0.id}/members/${ids.bot}`, { method: 'DELETE', headers: { authorization: `Bearer ${sink.tokens.alice}` } })
  await until(() => frames.length >= 7)
  const room = frames.slice(4)
  t('socket.membershipAndChannel', {
    types: room.map(f => f.type),
    added: room[0]?.type === 'user_added' && room[0].payload.channelExternalId === room0.id && room[0].payload.profileExternalId === ids.bot,
    renamed: room[1]?.type === 'channel_updated' && room[1].payload.channel.displayName,
    removedNamesTheChannel: room[2]?.type === 'user_removed' && room[2].payload.channelExternalId === room0.id,
  })

  const before6 = { frames: frames.length, ignored: counts().ignored, dropped: health().dropped }
  await fetch(`${sink.url}/_sink/socket`, { method: 'POST', body: JSON.stringify({ event: 'typing', data: { parent_id: '', user_id: ids.alice }, broadcast: { channel_id: ids.open } }) })
  await fetch(`${sink.url}/_sink/socket`, { method: 'POST', body: JSON.stringify({ raw: 'not a frame' }) })
  await until(() => counts().ignored > before6.ignored && health().dropped > before6.dropped)
  t('socket.typingIgnoredGarbageCounted', { landed: frames.length - before6.frames, ignored: counts().ignored - before6.ignored, dropped: health().dropped - before6.dropped })

  await ctl.arm({ frameTwice: true })
  const twice = await postMessage(alice, { channelExternalId: ids.open, message: 'twice' })
  await until(() => counts().duplicate >= 1)
  t('socket.frameTwiceAppliedOnce', { landed: frames.filter(f => f.type === 'posted' && f.payload.post.externalId === twice.row?.externalId).length, duplicate: counts().duplicate })

  throwOnce = true
  const lost = await postMessage(alice, { channelExternalId: ids.open, message: 'lost to a lock' })
  const errors = console.error; console.error = () => {}
  try { await until(() => counts().failed >= 1) } finally { console.error = errors }
  const after = await postMessage(alice, { channelExternalId: ids.open, message: 'after the lock' })
  await until(() => frames.some(f => f.type === 'posted' && f.payload.post.externalId === after.row?.externalId))
  t('socket.applyThrowsNothingRedelivers', { failed: counts().failed, lostLanded: frames.some(f => f.type === 'posted' && f.payload.post.externalId === lost.row?.externalId), nextLanded: true })

  await ctl.arm({ dropSockets: true })
  await until(() => !health().connected, 2000)
  const wentDown = !health().connected
  await until(() => health().connected, 5000)
  const again = await postMessage(alice, { channelExternalId: ids.open, message: 'after the redial' })
  await until(() => frames.some(f => f.type === 'posted' && f.payload.post.externalId === again.row?.externalId))
  const conns = (await seen()).sockets.filter(c => c.user === ids.bot && c.authBy === 'header')
  const redialed = frames.find(f => f.type === 'posted' && f.payload.post.externalId === again.row?.externalId)
  t('socket.reconnectIsANewConnection', { wentDown, back: health().connected, connections: conns.length, distinct: new Set(conns.map(c => c.connectionId)).size, keyedToTheNew: redialed?.id.startsWith(`${conns.at(-1)!.connectionId}:`) })

  // A server that reads no header: the challenge alone authenticates.
  await ctl.arm({ socketHeader: false })
  const c2 = createConduit({ credentials, ...DRIVE_RESILIENCE }), c2frames: SocketEvent[] = []
  await c2.register(mattermostSocketTarget({ address: sink.url }))
  await c2.receive({ ...socketReceiver, apply(ev: SocketEvent) { c2frames.push(ev); return 'applied' as const } })
  const viaChallenge = (await seen()).sockets.at(-1)!
  await postMessage(alice, { channelExternalId: ids.open, message: 'challenged' })
  await until(() => c2frames.length >= 1)
  t('socket.challengeWhenTheHeaderIsIgnored', { authBy: viaChallenge.authBy, user: viaChallenge.user === ids.bot, connected: c2.stats().subscriptions[MATTERMOST_SOCKET_TARGET]!.connected, landed: c2frames[0]?.type })
  await c2.destroy()

  // A token Mattermost refuses: FAIL to the challenge, never connected, nothing received.
  const c3 = createConduit({ credentials: { async get() { return 'wrong-token' } }, ...DRIVE_RESILIENCE })
  await c3.register(mattermostSocketTarget({ address: sink.url }))
  console.error = () => {}
  try { await c3.receive({ ...socketReceiver }) } finally { console.error = errors }
  const refused = c3.stats().subscriptions[MATTERMOST_SOCKET_TARGET]!
  t('socket.refusedTokenNeverConnected', { connected: refused.connected, received: refused.received, sinkSawNoUser: (await seen()).sockets.at(-1)!.user })
  await c3.destroy()

  // A link that dies without a close looks open forever: the ping keeps one
  // that answers, and silence past dead_ms cuts it and dials again.
  const cdead = createConduit({ credentials, ...DRIVE_RESILIENCE }), dfr: SocketEvent[] = []
  const framing = mattermostSocketDialect.framing!
  await cdead.register(mattermostSocketTarget({ address: sink.url }))
  await cdead.receive({ ...socketReceiver, dialect: { ...mattermostSocketDialect, framing: { ...framing, keepalive: { ...framing.keepalive!, every_ms: 50, dead_ms: 250 } } }, apply(ev: SocketEvent) { dfr.push(ev); return 'applied' as const } })
  const h4 = () => cdead.stats().subscriptions[MATTERMOST_SOCKET_TARGET]!
  const dying = (await seen()).sockets.at(-1)!
  await new Promise(r => setTimeout(r, 500))
  const kept = { connected: h4().connected, answered: ((await seen()).sockets.find(s => s.connectionId === dying.connectionId)!.pings) >= 5, dropped: h4().dropped }
  await ctl.arm({ silenceSocket: dying.connectionId })
  console.error = () => {}
  let wentDown4 = false, back4 = false
  try {
    wentDown4 = await until(() => !h4().connected, 2000)
    back4 = await until(() => h4().connected, 4000)
  } finally { console.error = errors }
  const quiet = await postMessage(alice, { channelExternalId: ids.open, message: 'after the silence' })
  await until(() => dfr.some(f => f.type === 'posted' && f.payload.post.externalId === quiet.row?.externalId))
  const conns4 = (await seen()).sockets, silent = conns4.find(s => s.connectionId === dying.connectionId)!, fresh = conns4.at(-1)!
  const landed4 = dfr.find(f => f.type === 'posted' && f.payload.post.externalId === quiet.row?.externalId)
  t('socket.silentLinkIsCutAndRedialed', { kept, wentDown: wentDown4, back: back4, cutAtTheSink: !silent.open, keyedToTheNew: fresh.connectionId !== dying.connectionId && !!landed4?.id.startsWith(`${fresh.connectionId}:`) })
  await cdead.destroy()

  // Frames the server dropped without closing: `seq` skips on the one
  // connection, and `gap` is told ahead of the frame that showed it.
  const cgap = createConduit({ credentials, ...DRIVE_RESILIENCE }), gapLog: string[] = [], gaps: { connection: unknown; after: number; at: number }[] = []
  await cgap.register(mattermostSocketTarget({ address: sink.url }))
  await cgap.receive({ ...socketReceiver, gap(g) { gaps.push(g); gapLog.push('gap') }, apply(ev: SocketEvent) { gapLog.push(ev.type); return 'applied' as const } })
  const gapConn = (await seen()).sockets.at(-1)!
  await postMessage(alice, { channelExternalId: ids.open, message: 'before the gap' })
  await until(() => gapLog.length >= 1)
  await ctl.arm({ skipSeq: 3 })
  const afterGap = await postMessage(alice, { channelExternalId: ids.open, message: 'after the gap' })
  await until(() => gapLog.length >= 3)
  t('socket.seqGapCallsGap', { order: gapLog, gaps: gaps.length, connection: gaps[0]?.connection === gapConn.connectionId, skipped: gaps[0] ? gaps[0].at - gaps[0].after : null, landed: !!afterGap.row })
  await cgap.destroy()

  // ─── A socket per person (FJS-D1153) ───────────────────────
  // Mattermost sends a channel's events to its members only, so the private
  // channel alice alone is in reaches her socket and neither bob's nor the bot's.
  const tokenOf: Record<string, string> = { ALICE_SOCKET: sink.tokens.alice, BOB_SOCKET: sink.tokens.bob }
  const perPerson = createConduit({ credentials: { async get(ref) { return tokenOf[ref] ?? null } }, ...DRIVE_RESILIENCE })
  const personal = { alice: [] as SocketEvent[], bob: [] as SocketEvent[] }, opened = { alice: 0, bob: 0 }
  for (const who of ['alice', 'bob'] as const) {
    const target = `broker:mattermost:${who}`
    await perPerson.register(mattermostSocketTarget({ address: sink.url, id: target, ref: `${who.toUpperCase()}_SOCKET` }))
    await perPerson.receive({
      provider: 'mattermost', target, dialect: mattermostSocketDialect,
      opened() { opened[who]++ },
      apply(ev: SocketEvent) { personal[who].push(ev); return 'applied' as const },
    })
  }
  const botBefore = frames.length
  const hidden = await postMessage(alice, { channelExternalId: ids.secret, message: 'only alice reads this' })
  const sawHidden = (xs: SocketEvent[]) => xs.filter(f => f.type === 'posted' && f.payload.post.externalId === hidden.row?.externalId).length
  await until(() => sawHidden(personal.alice) === 1)
  await new Promise(r => setTimeout(r, 50))
  t('socket.perPersonSeesWhatOnlyTheyMay', { alice: sawHidden(personal.alice), bob: sawHidden(personal.bob), service: frames.slice(botBefore).filter(f => f.type === 'posted' && f.payload.post.externalId === hidden.row?.externalId).length, openedOnce: { ...opened } })

  const dm = await api<{ id: string; type: string }>(sink.tokens.alice, '/channels/direct', [ids.alice, ids.bob])
  await api(sink.tokens.bob, '/reactions', { post_id: live.row!.externalId, user_id: ids.bob, emoji_name: 'wave' })
  await fetch(`${sink.url}/api/v4/users/${ids.bob}/posts/${live.row!.externalId}/reactions/wave`, { method: 'DELETE', headers: { authorization: `Bearer ${sink.tokens.bob}` } })
  await until(() => personal.alice.some(f => f.type === 'reaction_removed'))
  const kinds = (xs: SocketEvent[]) => xs.filter(f => ['direct_added', 'reaction_added', 'reaction_removed'].includes(f.type)).map(f => f.type)
  const added = personal.alice.find(f => f.type === 'reaction_added')
  t('socket.reactionsAndJoinsLand', {
    alice: kinds(personal.alice), bob: kinds(personal.bob),
    dmNamed: personal.bob.some(f => f.type === 'direct_added' && f.payload.channelExternalId === dm.id),
    reactionKey: added?.type === 'reaction_added' && added.payload.reaction.externalId === reactionKey(live.row!.externalId, ids.bob, 'wave'),
  })

  // ─── What a person has read ────────────────────────────────
  // A post that names alice carries her in `mentions`; a reply moves the
  // channel's total and not its root total, so a room's badge counts roots.
  const roomOf = async () => (await listChannels(alice, ids.alice, ids.team)).rows!.find(c => c.externalId === ids.open)!
  const myRow = async (who: MattermostSend, id: string) => (await listMembers(who, ids.open)).rows!.find(m => m.profileExternalId === id)!
  const before0 = await roomOf()
  const named = await postMessage(bob, { channelExternalId: ids.open, message: 'hey @alice, a question' })
  await until(() => personal.alice.some(f => f.type === 'posted' && f.payload.post.externalId === named.row?.externalId))
  const namedFrame = personal.alice.find(f => f.type === 'posted' && f.payload.post.externalId === named.row?.externalId)
  const afterRoot = await roomOf(), aliceOwed = await myRow(alice, ids.alice), bobSeen = await myRow(bob, ids.bob)
  const reply = await postMessage(alice, { channelExternalId: ids.open, rootExternalId: named.row!.externalId, message: 'an answer' })
  const afterReply = await roomOf()
  t('read.rootCountsAndMentions', {
    mentions: namedFrame?.type === 'posted' ? namedFrame.payload.mentions : null, channelType: namedFrame?.type === 'posted' ? namedFrame.payload.channelType : null,
    root: afterRoot.totalMessageCountRoot - before0.totalMessageCountRoot, rootAfterReply: afterReply.totalMessageCountRoot - afterRoot.totalMessageCountRoot, allAfterReply: afterReply.totalMessageCount - afterRoot.totalMessageCount,
    aliceMentioned: aliceOwed.mentionCountRoot, authorSawOwn: bobSeen.messageCountRoot === afterRoot.totalMessageCountRoot,
  })

  const viewed = await viewChannel(alice, ids.open)
  await until(() => personal.alice.some(f => f.type === 'channel_viewed'))
  const viewFrame = personal.alice.find(f => f.type === 'channel_viewed')
  const cleared = await myRow(alice, ids.alice), now0 = await roomOf()
  t('read.viewClearsAndIsPushed', {
    answered: !!viewed.times?.[ids.open], pushed: viewFrame?.type === 'channel_viewed' && viewFrame.payload.profileExternalId === ids.alice && !!viewFrame.payload.times[ids.open],
    bobHeardNothing: !personal.bob.some(f => f.type === 'channel_viewed'), counts: [cleared.messageCountRoot === now0.totalMessageCountRoot, cleared.mentionCount, cleared.mentionCountRoot], badId: await viewChannel(alice, 'nope').catch((e: Error) => e.message),
  })

  await fetch(`${sink.url}/api/v4/channels/${ids.open}/members/${ids.alice}/notify_props`, { method: 'PUT', headers: { authorization: `Bearer ${sink.tokens.alice}`, 'content-type': 'application/json' }, body: JSON.stringify({ mark_unread: 'mention' }) })
  await until(() => personal.alice.some(f => f.type === 'channel_member_updated'))
  const muteFrame = personal.alice.find(f => f.type === 'channel_member_updated')
  t('read.muteIsPushed', { muted: muteFrame?.type === 'channel_member_updated' && muteFrame.payload.member.muted, listed: (await myRow(alice, ids.alice)).muted, bobNot: (await myRow(bob, ids.bob)).muted })

  // bob's root, answered by alice: bob follows it (his post) and is owed the reply.
  await until(() => personal.bob.some(f => f.type === 'thread_updated'))
  const threadFrame = personal.bob.find(f => f.type === 'thread_updated')
  const bobThreads = await listThreads(bob, ids.bob, ids.team)
  const one = await getThread(bob, ids.bob, ids.team, named.row!.externalId)
  const threadRead = await markThreadRead(bob, ids.bob, ids.team, named.row!.externalId, Date.now())
  await until(() => personal.bob.some(f => f.type === 'thread_read_changed'))
  const readFrame = personal.bob.find(f => f.type === 'thread_read_changed')
  t('thread.followedReadAndPushed', {
    pushed: threadFrame?.type === 'thread_updated' ? [threadFrame.payload.thread.externalId === threadKey(ids.bob, named.row!.externalId), threadFrame.payload.thread.unreadReplies, threadFrame.payload.thread.isFollowing, threadFrame.payload.root?.externalId === named.row!.externalId] : null,
    listed: bobThreads.rows?.map(r => [r.rootExternalId === named.row!.externalId, r.unreadReplies, r.replyCount]), roots: bobThreads.roots?.length, one: one.rows?.[0]?.unreadReplies,
    read: threadRead.row?.unreadReplies, readPushed: readFrame?.type === 'thread_read_changed' ? [readFrame.payload.rootExternalId === named.row!.externalId, readFrame.payload.unreadReplies, !!readFrame.payload.at] : null,
    replierFollowsRead: (await listThreads(alice, ids.alice, ids.team)).rows?.find(r => r.rootExternalId === named.row!.externalId)?.unreadReplies, replyId: !!reply.row,
  })

  await ctl.arm({ dropSockets: true })
  await until(() => opened.alice === 2 && opened.bob === 2 && !!perPerson.stats().subscriptions['broker:mattermost:alice']?.connected, 8_000)
  t('socket.openedOnEveryConnection', { alice: opened.alice, bob: opened.bob, back: !!perPerson.stats().subscriptions['broker:mattermost:alice']?.connected })
  await perPerson.destroy()

  // ─── What the backfill reads ───────────────────────────────
  const backlogRoom = await api<{ id: string }>(sink.tokens.alice, '/channels', { team_id: ids.team, name: 'backlog', display_name: 'Backlog', type: 'O' })
  const mark = Date.now() - 1
  const backlog: string[] = []
  for (let i = 0; i < 5; i++) {
    backlog.push((await postMessage(alice, { channelExternalId: backlogRoom.id, message: `backlog ${i}` })).row!.externalId)
    await new Promise(r => setTimeout(r, 3))
  }
  await ctl.arm({ sinceLimit: 2 })
  const reads0 = (await seen()).requests.length
  const paged = await postsSince(alice, backlogRoom.id, mark, { limit: 2, perPage: 2 })
  const reads = (await seen()).requests.slice(reads0).filter(r => r.path === `/api/v4/channels/${backlogRoom.id}/posts`).length
  await ctl.arm({ sinceLimit: 1000 })
  const whole = await postsSince(alice, backlogRoom.id, mark)
  t('backfill.sinceCapFallsBackToPages', { rows: paged.rows?.length, all: backlog.every(id => paged.rows?.some(r => r.externalId === id)), distinct: new Set(paged.rows?.map(r => r.externalId)).size, truncated: paged.truncated, pagedMoreThanOnce: reads > 2, underTheCap: [whole.rows?.length, whole.truncated] })

  await fetch(`${sink.url}/api/v4/channels/${backlogRoom.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${sink.tokens.alice}` } })
  const withArchived = await listChannels(alice, ids.alice, ids.team, { includeDeleted: true })
  const plain  = await listChannels(alice, ids.alice, ids.team)
  const dmRow = withArchived.rows?.find(c => c.externalId === dm.id)
  t('backfill.channelsIncludeDirectAndArchived', {
    direct: dmRow?.type, directTeam: dmRow?.teamExternalId,
    archived: !!withArchived.rows?.find(c => c.externalId === backlogRoom.id)?.deletedAt, archivedHiddenByDefault: !plain.rows?.some(c => c.externalId === backlogRoom.id),
  })

  await api(sink.tokens.bob, '/reactions', { post_id: live.row!.externalId, user_id: ids.bob, emoji_name: 'eyes' })
  const withMeta = await listPosts(alice, ids.open)
  const profiles = await listProfiles(alice, [ids.bob, ids.alice])
  t('backfill.metadataAndProfiles', {
    reaction: withMeta.reactions?.some(r => r.externalId === reactionKey(live.row!.externalId, ids.bob, 'eyes')),
    files: Array.isArray(withMeta.files), profiles: profiles.rows?.map(r => r.username).sort(),
  })

  // A pasted screenshot: the bytes go up as they are, a post of nothing but
  // the file claims it, and a member of the room reads the same bytes back.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255])
  const up = await uploadFile(alice, { channelExternalId: ids.open, name: 'shot.png', bytes: png, mimeType: 'image/png' })
  const upWire = (await seen()).requests.filter(r => r.path === '/api/v4/files').at(-1)
  const filed = await postMessage(alice, { channelExternalId: ids.open, message: '', fileExternalIds: [up.row!.externalId] })
  const read = await fileBytes(bob, up.row!.externalId)
  const thumb = await fileBytes(bob, up.row!.externalId, 'thumbnail')
  const reclaim = await postMessage(alice, { channelExternalId: ids.open, message: 'again', fileExternalIds: [up.row!.externalId] })
  const offRoom = await uploadFile(bob, { channelExternalId: ids.secret, name: 'x.png', bytes: png, mimeType: 'image/png' })
  let noBytes = ''
  try { await uploadFile(alice, { channelExternalId: ids.open, name: 'x.png', bytes: new Uint8Array(0) }) } catch (e) { noBytes = (e as Error).message }
  t('file.uploadPostAndRead', {
    bearer: upWire?.headers.authorization, type: upWire?.headers['content-type'], size: up.row?.size, mime: up.row?.mimeType, unclaimed: up.row?.postExternalId, preview: up.row?.hasPreviewImage,
    posted: !!filed.row, emptyMessage: filed.row?.message, same: !!read.bytes && read.bytes.length === png.length && read.bytes.every((b, i) => b === png[i]),
    readType: read.type, thumb: !!thumb.bytes, claimedTwice: reclaim.error?.kind, notAMember: offRoom.error?.kind, noBytes,
  })
} catch (e) { console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message) }
finally { sink.stop(); bridge.stop(true); await conduit.destroy() }

process.exit(report(got, {
  'target.refusesNoAddress':                   { threw: true },
  'bind.asPicksTheCredential':                 { ids: true, renamedIds: ['provider:chat', 'provider:chat:user', 'provider:chat:upload'], perCaller: [false, true, true], binary: 'binary', noAs: true, serviceUpload: true, unsent: 0 },
  'post.leavesAsItsAuthor':                    { ok: true, bearer: `Bearer ${sink.tokens.alice}`, path: '/api/v4/posts', body: { channel_id: ids.open, message: 'hello from the terminal' }, row: { id: true, user: true, channel: true, root: null, message: 'hello from the terminal', edited: null, deleted: null, created: true } },
  'post.notAMemberIsForbidden':                { kind: 'forbidden', code: 'api.context.permissions.app_error', retryable: false },
  'post.refusedLocallyBeforeTheWire':          { emptyMessage: 'mattermost: message is required', badId: 'mattermost: channelExternalId is not a Mattermost id', sent: 0 },
  'post.lostWithPendingIdReplayedOnce':        { ok: true, attempts: 2, postsAdded: 1, pendingEchoed: 'tui-0001' },
  'post.lostWithoutPendingIdIsIndeterminate':  { kind: 'timeout', retryable: false, attempts: 1, postsAdded: 1 },
  'post.rateLimitedWaitReadOffReset':          { kind: 'rate_limited', retryAfterMs: 2000, attempts: 1 },
  'post.patchTouchesOnlyWhatIsPresent':        { path: true, body: { is_pinned: true }, isPinned: true, message: 'hello from the terminal', editedAt: null },
  'post.deleteThenGone':                       { othersEdit: 'forbidden', deleted: true, then: 'gone' },
  'reaction.keyReadsBackThroughDelete':        { key: true, deleted: true, path: true, badEmoji: true, left: 0 },
  'member.keyReadsBackThroughDelete':          { key: true, joinedCanList: true, left: true, leftCannot: 'forbidden' },
  'channel.createPatchDelete':                 { type: 'private', purpose: 'pixels', creator: true, patchBody: { display_name: 'Design & Brand' }, renamed: 'Design & Brand', dup: 'refused', dupCode: 'store.sql_channel.save_channel.exists.app_error', listedBefore: ['design', 'general', 'ops'], deleted: true, listedAfter: ['general', 'ops'], directRefused: true },
  'backfill.sinceListsDeletionsToo':           { sinceHasDeleted: true, sinceHasPinned: true, newestFirst: true, pageSize: 2, pageExcludesDeleted: true, twoCursors: true },
  'backfill.readsAreReplayedByConduit':        { attempts: 2, teams: [['town', 'open']], me: 'alice', roster: [ids.alice, ids.bob, ids.bot].sort(), isAdmin: true },
  'mirror.claimShape':                         { provider: 'mattermost', models: ['Team', 'Channel', 'ChannelMember', 'Post', 'Thread', 'Reaction', 'Profile', 'FileInfo'], keys: true, verbs: ['Channel.create', 'Channel.update', 'Channel.delete', 'ChannelMember.create', 'ChannelMember.delete', 'Post.create', 'Post.update', 'Post.delete', 'Reaction.create', 'Reaction.delete'], humanVerbsSpendTheUser: true, verbNamesNoTarget: true, parseRefusesGarbage: true },
  'mirror.forwardCreatesAsTheCaller':          { bearer: `Bearer ${sink.tokens.alice}`, path: '/api/v4/posts', key: true, user: true, message: 'through the claim' },
  'mirror.forwardPatchAnswersTheRowDeleteAnswersNone': { edited: 'edited through the claim', sameKey: true, removed: null, editAfter: 404 },
  'mirror.forwardRefusalCarriesAStatus':       { unbuilt: 400, unsent: 0, notMember: 403, team: [], unclaimed: undefined },
  'thread.isOneUsersView':                     { noScope: true, key: true, root: true, unread: 2 },
  'mirror.timesAndCodesAreWords':              { teamType: 'invite', deleted: null, created: '1970-01-01T00:00:00.001Z', roles: 'system_user system_admin', emailWithheld: true, filePost: null, mime: 'image/png' },
  'translate.statusIsTheKind':                 { forbidden: 'forbidden', gone: 'gone', refused: 'model.post.is_valid.app_error', reset: 7000, server: 'server_error', unauth: 'auth_failed' },
  'webhook.firesAsFormWithTokenTwice':         { contentType: 'application/x-www-form-urlencoded', header: true, bodyToken: true, status: 200, outcome: 'applied', event: { post: true, user: true, userName: 'alice', channel: true, channelName: 'general', team: true, teamDomain: 'town', trigger: 'weather', text: 'weather tomorrow?', at: true, files: [] } },
  'webhook.replyIsTheBotsPostInThread':        { byBot: true, message: 'Forecast for alice: sun', bodyRepliesUsed: 0, deliveries: 1 },
  'webhook.jsonEncodingParsesTheSame':         { contentType: 'application/json', timestampIsNumber: 'number', status: 200, post: true, user: true, trigger: '!ping', text: '!ping now', at: true },
  'webhook.deliveredTwiceAppliedOnce':         { deliveries: 2, statuses: [200, 200], outcomes: ['applied', 'duplicate'], applied: 1, threadReplies: 2 },
  'webhook.firstWordOnly':                     { delivered: 0 },
  'command.arrivesWithHeaderToken':            { contentType: 'application/x-www-form-urlencoded', header: true, status: 200, event: { command: '/roll', text: '2d6', user: true, userName: 'bob', channel: true, channelName: 'general', teamDomain: 'town', triggerId: true, responseUrl: true } },
  'command.replyGoesThroughResponseUrl':       { via: 'response_url', responseType: 'ephemeral', text: 'bob rolled 2d6: 7', toUser: true, answerBodyHadNoText: true, responded: ['ok'] },
  'command.unregisteredTokenIsOne401':         { status: 401, mattermostSaid: 'api.command.execute_command.failed_resp.app_error', landed: 1, replies: 0 },
  'verify.everyTokenPresentMustMatch':         { body: true, header: true, both: true, bodyWrong: false, headerWrong: false, bearer: false, none: false, noCredential: false },
  'dialect.conduitOrder':                      { noTriggerId: 'ignored', garbage: 'ignored', forged: 401, unknownHook: 401, landed: 0 },
  'respond.refusedLocallyAndExpiredIsGone':    { badUrl: true, noText: true, sent: 1, expired: 'gone' },
  'socket.receiverRefusesWhatARouteHas':       { path: true, credential: true, verify: true, second: true, routes: 0 },
  'socket.dialAuthenticatesByHeader':          { connected: true, user: true, authBy: 'header', helloOnly: 1 },
  'socket.postLandsAsRow':                     { type: 'posted', same: true, user: true, message: 'over the socket', keyed: true, applied: 1 },
  'socket.editThenDeleteInOrder':              { types: ['posted', 'post_edited', 'post_deleted'], edited: 'edited', deleted: true },
  'socket.membershipAndChannel':               { types: ['user_added', 'channel_updated', 'user_removed'], added: true, renamed: 'Socket Room', removedNamesTheChannel: true },
  'socket.typingIgnoredGarbageCounted':        { landed: 0, ignored: 1, dropped: 1 },
  'socket.frameTwiceAppliedOnce':              { landed: 1, duplicate: 1 },
  'socket.applyThrowsNothingRedelivers':       { failed: 1, lostLanded: false, nextLanded: true },
  'socket.reconnectIsANewConnection':          { wentDown: true, back: true, connections: 2, distinct: 2, keyedToTheNew: true },
  'socket.challengeWhenTheHeaderIsIgnored':    { authBy: 'challenge', user: true, connected: true, landed: 'posted' },
  'socket.refusedTokenNeverConnected':         { connected: false, received: 0, sinkSawNoUser: null },
  'socket.silentLinkIsCutAndRedialed':         { kept: { connected: true, answered: true, dropped: 0 }, wentDown: true, back: true, cutAtTheSink: true, keyedToTheNew: true },
  'socket.seqGapCallsGap':                     { order: ['posted', 'gap', 'posted'], gaps: 1, connection: true, skipped: 4, landed: true },
  'socket.perPersonSeesWhatOnlyTheyMay':       { alice: 1, bob: 0, service: 0, openedOnce: { alice: 1, bob: 1 } },
  'socket.reactionsAndJoinsLand':              { alice: ['direct_added', 'reaction_added', 'reaction_removed'], bob: ['direct_added', 'reaction_added', 'reaction_removed'], dmNamed: true, reactionKey: true },
  'read.rootCountsAndMentions':                { mentions: [ids.alice], channelType: 'O', root: 1, rootAfterReply: 0, allAfterReply: 1, aliceMentioned: 1, authorSawOwn: true },
  'read.viewClearsAndIsPushed':                { answered: true, pushed: true, bobHeardNothing: true, counts: [true, 0, 0], badId: 'mattermost: channelExternalId is not a Mattermost id' },
  'read.muteIsPushed':                         { muted: true, listed: true, bobNot: false },
  'thread.followedReadAndPushed':              { pushed: [true, 1, true, true], listed: [[true, 1, 1]], roots: 1, one: 1, read: 0, readPushed: [true, 0, true], replierFollowsRead: 0, replyId: true },
  'socket.openedOnEveryConnection':            { alice: 2, bob: 2, back: true },
  'backfill.sinceCapFallsBackToPages':         { rows: 5, all: true, distinct: 5, truncated: true, pagedMoreThanOnce: true, underTheCap: [5, undefined] },
  'backfill.channelsIncludeDirectAndArchived': { direct: 'direct', directTeam: null, archived: true, archivedHiddenByDefault: true },
  'backfill.metadataAndProfiles':              { reaction: true, files: true, profiles: ['alice', 'bob'] },
  'file.uploadPostAndRead':                    { bearer: `Bearer ${sink.tokens.alice}`, type: 'image/png', size: 12, mime: 'image/png', unclaimed: null, preview: true, posted: true, emptyMessage: '', same: true, readType: 'image/png', thumb: true, claimedTwice: 'refused', notAMember: 'forbidden', noBytes: 'mattermost: an upload needs its bytes' },
}))
