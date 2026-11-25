// test/github.drive.ts — the connector against the sink. No fixture.
// What only this drive asks: a 403 is a rate limit or a missing grant by one
// header, and the call that reads it must not call a busy token broken; a lost
// deploy-key write is resolved by the list; the hook secret is written and
// never read back; a file read asks for the repository first.

import { createHmac } from 'node:crypto'
import { createConduit, createStaticResolver, type ConduitError } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startGhSink, NO_HOOKS_TOKEN } from '../sink.ts'
import { githubTarget, bindSend, verify, repository, setDeployKey, setPushHook, readFile, translate, verifyGithubSignature, parsePush, GithubError, DEFAULT_WAIT_MS } from '../src/index.ts'

const { got, t } = results()
const BIG = 'x'.repeat(1_000_001)
const sink = startGhSink({ files: { 'sink-owner/app': { Dockerfile: 'FROM oven/bun:1\n', 'deploy/Dockerfile': 'FROM deploy\n', 'deploy/other': 'x', 'big.txt': BIG, 'docs/a.md': 'a' } } })
const other = startGhSink()
const ctl = control(sink.url)
const conduit = createConduit({ credentials: createStaticResolver({ GH: 'github_pat_devtoken', GH_NOHOOKS: NO_HOOKS_TOKEN, GH_BAD: 'nope' }), ...DRIVE_RESILIENCE })
for (const [accountId, ref] of [['a', 'GH'], ['nohooks', 'GH_NOHOOKS'], ['bad', 'GH_BAD']]) await conduit.register(githubTarget({ accountId, ref, address: sink.url, userAgent: 'github-drive' }))
const send = bindSend(conduit, 'provider:github:a')
const sendAs = (id: string) => bindSend(conduit, `provider:github:${id}`)
const seen = () => ctl.seen() as unknown as Promise<{ requests: { method: string; path: string; status: number; userAgent: string | null; apiVersion: string | null; accept: string | null }[] }>
const app = { owner: 'sink-owner', name: 'app' }, elsewhere = { owner: 'sink-owner', name: 'other' }, nowhere = { owner: 'sink-owner', name: 'missing' }
const failure = async (fn: () => Promise<unknown>): Promise<Record<string, any> | null> => {
  try { await fn(); return null } catch (e) {
    if (!(e instanceof GithubError)) return { threw: String(e) }
    const f = e.failure
    return { kind: f.kind, retryable: f.retryable, ...(f.grant ? { grant: f.grant, level: f.level } : {}), ...(f.retryAfterMs !== undefined ? { retryAfterMs: f.retryAfterMs } : {}), ...(f.indeterminate ? { indeterminate: true } : {}) }
  }
}
const err = (over: Partial<ConduitError>): ConduitError => ({ kind: 'auth_failed', message: 'Auth failed: 403', retryable: false, ...over } as ConduitError)
const ghBody = (message: string, extra: object = {}) => ({ message, documentation_url: 'https://docs.github.com/rest', ...extra })
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKEY1', KEY2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKEY2', KEY3 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKEY3'
const NOW = 1_800_000_000_000

try {
  // ── the target ─────────────────────────────────────────────────────────
  t('verify.threeTokens', { good: await verify(send), nohooks: await verify(sendAs('nohooks')), bad: await verify(sendAs('bad')) })
  const headers = (await seen()).requests[0]
  t('target.sendsAcceptVersionAndUserAgent', { ua: headers.userAgent, version: headers.apiVersion, accept: headers.accept })
  let refused = ''; try { githubTarget({ ref: 'x', userAgent: ' ' }) } catch (e) { refused = (e as Error).message.split(' — ')[0] }
  t('target.refusesNoUserAgent', refused)
  t('target.idsAndPerCaller', {
    account: githubTarget({ ref: 'r', userAgent: 'u', accountId: '7' }).id, process: githubTarget({ ref: 'r', userAgent: 'u' }).id,
    perCaller: (githubTarget({ ref: 'r', userAgent: 'u', perCaller: true }).auth as { per_caller?: boolean }).per_caller === true,
  })

  // ── translate, pure: the 403 split, and its negative control ───────────
  const primary = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 30) }
  const grant = { 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': String(NOW / 1000 + 3000) }
  const row = (e: ConduitError, status: number, h: Record<string, string>, grantNeeded?: 'Administration') => { const f = translate(e, status, h, { now: NOW, ...(grantNeeded ? { grant: grantNeeded } : {}) }); return { kind: f.kind, retryable: f.retryable, retryAfterMs: f.retryAfterMs, grant: f.grant } }
  t('translate.primaryLimit403WaitsForTheReset', row(err({ raw: ghBody('API rate limit exceeded for 1.2.3.4.') }), 403, primary))
  t('translate.grant403NamesTheGrant', row(err({ raw: ghBody('Resource not accessible by personal access token') }), 403, grant, 'Administration'))
  // Negative control: the same status, told apart by one header and nothing else.
  t('translate.control.limitIsNotAGrantRefusal', translate(err({ raw: ghBody('x') }), 403, primary).kind !== 'refused_grant')
  t('translate.control.grantIsNotARateLimit', translate(err({ raw: ghBody('x') }), 403, grant).kind !== 'rate_limited')
  t('translate.secondary403ByMessageWaitsForRetryAfter', row(err({ raw: ghBody('You have exceeded a secondary rate limit.') }), 403, { ...grant, 'retry-after': '12' }))
  t('translate.secondary403ByMessageNoHeaders', row(err({ raw: ghBody('You have exceeded a secondary rate limit.') }), 403, grant))
  t('translate.limit403WithNeitherResetNorRetryAfter', row(err({ raw: ghBody('x') }), 403, { 'x-ratelimit-remaining': '0' }))
  t('translate.resetAlreadyPastWaitsASecond', row(err({ raw: ghBody('x') }), 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 - 5) }))
  t('translate.429KeepsConduitsWait', row(err({ kind: 'rate_limited', retryable: true, retry_after_ms: 7000, raw: ghBody('You have exceeded a secondary rate limit.') }), 429, { 'retry-after': '7' }))
  t('translate.401IsAuthFailed', row(err({ raw: ghBody('Bad credentials') }), 401, grant))
  t('translate.404IsUnseen', row(err({ kind: 'client_error', raw: ghBody('Not Found') }), 404, grant))
  t('translate.422KeyInUse', row(err({ kind: 'client_error', raw: ghBody('Validation Failed', { errors: [{ message: 'key is already in use' }] }) }), 422, grant))
  t('translate.otherValidation422IsRefused', row(err({ kind: 'client_error', raw: ghBody('Validation Failed', { errors: [{ message: 'Hook already exists' }] }) }), 422, grant))
  t('translate.5xxPassesThrough', row(err({ kind: 'server_error', retryable: true }), 500, grant))
  t('translate.rawAsJsonString', translate(err({ raw: JSON.stringify(ghBody('Resource not accessible by personal access token')) }), 403, grant).message)
  t('translate.default60s', DEFAULT_WAIT_MS)

  // ── errors through the wire ────────────────────────────────────────────
  t('errors.grant403', await failure(() => setPushHook(sendAs('nohooks'), app, { url: 'https://x.test/h', secret: 's' })))
  await ctl.reset(); await ctl.arm({ primaryLimit: { resetInSeconds: 30 } })
  let primaryWait = 0
  const primaryErr = await failure(() => repository(send, app).catch(e => { primaryWait = e.failure.retryAfterMs; throw e }))
  t('errors.primaryLimit403IsRateLimitedNotAGrant', { ...primaryErr, retryAfterMs: undefined, waitIsAboutTheReset: primaryWait >= 28_000 && primaryWait <= 30_000, attempts: (await seen()).requests.length })
  // Control: what conduit alone answers, so removing translate would show here.
  await ctl.reset(); await ctl.arm({ primaryLimit: { resetInSeconds: 30 } })
  const bare = await send({ method: 'GET', path: '/repos/sink-owner/app' })
  t('errors.control.withoutTranslateAPrimaryLimitReadsAsAuthFailed', { kind: bare.error?.kind, status: bare.meta.status, retryable: bare.error?.retryable })
  await ctl.arm({ primaryLimit: { resetInSeconds: 30 } })
  const limitedVerify = await failure(() => verify(send))
  t('errors.verifyThrowsOnALimitRatherThanFalse', { ...limitedVerify, retryAfterMs: undefined, waitIsAboutTheReset: (limitedVerify?.retryAfterMs ?? 0) >= 28_000 })
  await ctl.arm({ rateLimit: { retryAfter: 30 } })
  t('errors.secondary429HandedBackWithItsWait', await failure(() => repository(send, app)))
  await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const t0 = Date.now()
  t('errors.secondary429GetIsReplayedAfterWait', { ok: (await repository(send, app)).fullName, waited: Date.now() - t0 >= 1000 })
  t('errors.unseen', { repo: await failure(() => repository(send, nowhere)), neverClaimsWhich: (await failure(() => repository(send, nowhere)))?.kind })
  t('errors.401', await failure(() => repository(sendAs('bad'), app)))
  await ctl.arm({ failNext: true })
  await ctl.reset(); await ctl.arm({ failNext: true })
  t('errors.5xxOnAReadIsRetriedByConduit', { ok: (await repository(send, app)).fullName, requests: (await seen()).requests.map(r => r.status) })

  // ── the calls ──────────────────────────────────────────────────────────
  t('repository.read', await repository(send, app))
  await ctl.reset()
  const key1 = await setDeployKey(send, app, { title: 'one', key: `${KEY} deploy@host` })
  const key1b = await setDeployKey(send, app, { title: 'one', key: `${KEY} another comment` })
  const posts = (await seen()).requests.filter(r => r.method === 'POST')
  t('setDeployKey.findsByMaterialThenCreatesUnkeyed', { created: key1.title, readOnly: key1.readOnly, sameId: key1.id === key1b.id, posts: posts.length, sinkKeys: sink.keysOf('sink-owner/app').length })
  t('setDeployKey.inUseElsewhere', await failure(() => setDeployKey(send, elsewhere, { title: 'two', key: KEY })))
  t('setDeployKey.noGrantIsUnseenNever403', await failure(() => setDeployKey(send, nowhere, { title: 'x', key: KEY2 })))

  // C6: the POST applied and its answer was lost; the list says so.
  await ctl.reset(); await ctl.arm({ lost: true })
  const landed = await setDeployKey(send, app, { title: 'lost', key: KEY2 })
  const lostLog = (await seen()).requests
  t('setDeployKey.lostAnswerIsResolvedByTheList', { title: landed.title, posts: lostLog.filter(r => r.method === 'POST').length, listsAfter: lostLog.filter(r => r.method === 'GET' && r.path.includes('/keys')).length, sinkKeys: sink.keysOf('sink-owner/app').filter(k => k.key === KEY2).length })
  // Control: with no list to read, the same loss is indeterminate and nothing says it landed.
  await ctl.arm({ lost: true })
  const bareLost = await send({ method: 'POST', path: '/repos/sink-owner/app/keys', body: { title: 'raw', key: KEY3, read_only: true } })
  t('setDeployKey.control.aBareLostPostIsIndeterminate', { kind: bareLost.error?.kind, indeterminate: bareLost.error?.indeterminate, landed: sink.keysOf('sink-owner/app').some(k => k.key === KEY3) })

  const url = 'https://basecamp.test/hooks/git/app-1'
  await ctl.reset()
  const hook = await setPushHook(send, app, { url, secret: 'first-secret' })
  const hook2 = await setPushHook(send, app, { url, secret: 'second-secret' })
  const hookLog = (await seen()).requests.filter(r => r.path.includes('/hooks') && r.method !== 'GET')
  t('setPushHook.createsThenPatchesByUrl', { events: hook.events, active: hook.active, sameId: hook.id === hook2.id, writes: hookLog.map(r => r.method), hooks: sink.hooksOf('sink-owner/app').length })
  t('setPushHook.secretIsWrittenNeverReadBack', {
    answered: JSON.stringify([hook, hook2]).includes('secret'), stored: (sink.hooksOf('sink-owner/app')[0].config as { secret: string }).secret,
    wroteJson: (sink.hooksOf('sink-owner/app')[0].config as { content_type: string }).content_type,
  })
  await ctl.reset(); await ctl.arm({ lost: true })
  const lostHook = await setPushHook(send, app, { url: 'https://basecamp.test/hooks/git/app-2', secret: 's' })
  t('setPushHook.lostCreateIsResolvedByTheList', { url: lostHook.url, hooks: sink.hooksOf('sink-owner/app').filter(h => (h.config as { url: string }).url === 'https://basecamp.test/hooks/git/app-2').length })

  // ── readFile ───────────────────────────────────────────────────────────
  await ctl.reset()
  const got1 = await readFile(send, app, { paths: ['deploy/Dockerfile', 'Dockerfile'], ref: 'feat/x' })
  const reads = (await seen()).requests.map(r => `${r.method} ${r.path}`)
  t('readFile.asksTheRepositoryFirstThenEncodesPathAndRef', { file: got1, reads })
  t('readFile.missingFileFallsThrough', await readFile(send, app, { paths: ['nope', 'Dockerfile'] }))
  t('readFile.directoryIsSkipped', await readFile(send, app, { paths: ['deploy', 'docs'] }))
  t('readFile.over1MBIsSkipped', await readFile(send, app, { paths: ['big.txt', 'Dockerfile'] }))
  t('readFile.nothingHeldIsNull', await readFile(send, app, { paths: ['Dockerfile.nope'] }))
  await ctl.reset()
  const unseenRepo = await failure(() => readFile(send, nowhere, { paths: ['Dockerfile'] }))
  t('readFile.unseenRepositoryIsNeverReadAsAMissingFile', { ...unseenRepo, requests: (await seen()).requests.map(r => r.path) })
  t('readFile.noPathsIsAVisibilityProbe', { probe: await readFile(send, app, { paths: [] }), unseen: (await failure(() => readFile(send, nowhere, { paths: [] })))?.kind })

  // ── per-instance state ─────────────────────────────────────────────────
  t('sink.stateIsPerInstance', { here: sink.keysOf('sink-owner/app').length > 0, there: other.keysOf('sink-owner/app').length, distinctPorts: sink.port !== other.port })

  // ── signature ──────────────────────────────────────────────────────────
  const secret = 'whsec-test', body = JSON.stringify({ ref: 'refs/heads/main', after: 'abc123', repository: { default_branch: 'main' }, head_commit: { message: 'ship it', author: { name: 'Ada' } } })
  const sign = (b: string, s = secret) => `sha256=${createHmac('sha256', s).update(b).digest('hex')}`
  t('signature.good', verifyGithubSignature({ rawBody: body, header: sign(body), secret }))
  t('signature.goodOverBytes', verifyGithubSignature({ rawBody: new TextEncoder().encode(body), header: sign(body), secret }))
  t('signature.wrongSecret', verifyGithubSignature({ rawBody: body, header: sign(body, 'other'), secret }))
  t('signature.missingHeader', verifyGithubSignature({ rawBody: body, header: undefined, secret }))
  t('signature.notSha256', verifyGithubSignature({ rawBody: body, header: 'sha1=abc', secret }))
  t('signature.oneByteChangedInTheBody', verifyGithubSignature({ rawBody: body.replace('abc123', 'abc124'), header: sign(body), secret }))
  t('signature.truncatedHeaderIsNotAThrow', verifyGithubSignature({ rawBody: body, header: 'sha256=abcd', secret }))
  t('signature.noSecretRefuses', verifyGithubSignature({ rawBody: body, header: sign(body), secret: undefined }))

  // ── parsePush ──────────────────────────────────────────────────────────
  t('parsePush.push', parsePush({ headers: { 'x-github-event': 'push', 'x-github-delivery': 'd-1' }, body: JSON.parse(body) }))
  t('parsePush.pingIsIgnored', parsePush({ headers: { 'x-github-event': 'ping' }, body: {} }))
  t('parsePush.branchDeleteAndGiteaHeaders', parsePush({ headers: { 'x-gitea-event': 'push', 'x-gitea-delivery': 'g-1' }, body: { ref: 'refs/heads/x', after: '0000000000000000000000000000000000000000', pusher: { name: 'Bo' } } }))
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message)
} finally { sink.stop(); other.stop(); await conduit.destroy() }

const D = 'sink-owner/app'
const PUSH_BODY = { ref: 'refs/heads/main', after: 'abc123', deleted: false, defaultBranch: 'main', author: 'Ada', message: 'ship it' }
process.exit(report(got, {
  'verify.threeTokens':                          { good: true, nohooks: true, bad: false },
  'target.sendsAcceptVersionAndUserAgent':       { ua: 'github-drive', version: '2022-11-28', accept: 'application/vnd.github+json' },
  'target.refusesNoUserAgent':                   'githubTarget: userAgent is required',
  'target.idsAndPerCaller':                      { account: 'provider:github:7', process: 'provider:github', perCaller: true },

  'translate.primaryLimit403WaitsForTheReset':   { kind: 'rate_limited', retryable: true, retryAfterMs: 30_000 },
  'translate.grant403NamesTheGrant':             { kind: 'refused_grant', retryable: false, grant: 'Administration' },
  'translate.control.limitIsNotAGrantRefusal':   true,
  'translate.control.grantIsNotARateLimit':      true,
  'translate.secondary403ByMessageWaitsForRetryAfter': { kind: 'rate_limited', retryable: true, retryAfterMs: 12_000 },
  'translate.secondary403ByMessageNoHeaders':    { kind: 'rate_limited', retryable: true, retryAfterMs: 3_000_000 },
  'translate.limit403WithNeitherResetNorRetryAfter': { kind: 'rate_limited', retryable: true, retryAfterMs: 60_000 },
  'translate.resetAlreadyPastWaitsASecond':      { kind: 'rate_limited', retryable: true, retryAfterMs: 1000 },
  'translate.429KeepsConduitsWait':              { kind: 'rate_limited', retryable: true, retryAfterMs: 7000 },
  'translate.401IsAuthFailed':                   { kind: 'auth_failed', retryable: false },
  'translate.404IsUnseen':                       { kind: 'unseen', retryable: false },
  'translate.422KeyInUse':                       { kind: 'key_in_use', retryable: false },
  'translate.otherValidation422IsRefused':       { kind: 'refused', retryable: false },
  'translate.5xxPassesThrough':                  { kind: 'server_error', retryable: true },
  'translate.rawAsJsonString':                   'Resource not accessible by personal access token',
  'translate.default60s':                        60_000,

  'errors.grant403':                             { kind: 'refused_grant', retryable: false, grant: 'Webhooks', level: 'Read and write' },
  'errors.primaryLimit403IsRateLimitedNotAGrant': { kind: 'rate_limited', retryable: true, waitIsAboutTheReset: true, attempts: 1 },
  'errors.control.withoutTranslateAPrimaryLimitReadsAsAuthFailed': { kind: 'auth_failed', status: 403, retryable: false },
  'errors.verifyThrowsOnALimitRatherThanFalse':  { kind: 'rate_limited', retryable: true, waitIsAboutTheReset: true },
  'errors.secondary429HandedBackWithItsWait':    { kind: 'rate_limited', retryable: true, retryAfterMs: 30_000 },
  'errors.secondary429GetIsReplayedAfterWait':   { ok: D, waited: true },
  'errors.unseen':                               { repo: { kind: 'unseen', retryable: false }, neverClaimsWhich: 'unseen' },
  'errors.401':                                  { kind: 'auth_failed', retryable: false },
  'errors.5xxOnAReadIsRetriedByConduit':         { ok: D, requests: [500, 200] },

  'repository.read':                             { fullName: D, private: true, defaultBranch: 'main' },
  'setDeployKey.findsByMaterialThenCreatesUnkeyed': { created: 'one', readOnly: true, sameId: true, posts: 1, sinkKeys: 1 },
  'setDeployKey.inUseElsewhere':                 { kind: 'key_in_use', retryable: false },
  'setDeployKey.noGrantIsUnseenNever403':        { kind: 'unseen', retryable: false },
  'setDeployKey.lostAnswerIsResolvedByTheList':  { title: 'lost', posts: 1, listsAfter: 2, sinkKeys: 1 },
  'setDeployKey.control.aBareLostPostIsIndeterminate': { kind: 'timeout', indeterminate: true, landed: true },
  'setPushHook.createsThenPatchesByUrl':         { events: ['push'], active: true, sameId: true, writes: ['POST', 'PATCH'], hooks: 1 },
  'setPushHook.secretIsWrittenNeverReadBack':    { answered: false, stored: 'second-secret', wroteJson: 'json' },
  'setPushHook.lostCreateIsResolvedByTheList':   { url: 'https://basecamp.test/hooks/git/app-2', hooks: 1 },

  'readFile.asksTheRepositoryFirstThenEncodesPathAndRef': { file: { path: 'deploy/Dockerfile', content: 'FROM deploy\n' }, reads: [`GET /repos/sink-owner/app`, `GET /repos/sink-owner/app/contents/deploy/Dockerfile?ref=feat%2Fx`] },
  'readFile.missingFileFallsThrough':            { path: 'Dockerfile', content: 'FROM oven/bun:1\n' },
  'readFile.directoryIsSkipped':                 null,
  'readFile.over1MBIsSkipped':                   { path: 'Dockerfile', content: 'FROM oven/bun:1\n' },
  'readFile.nothingHeldIsNull':                  null,
  'readFile.unseenRepositoryIsNeverReadAsAMissingFile': { kind: 'unseen', retryable: false, requests: ['/repos/sink-owner/missing'] },
  'readFile.noPathsIsAVisibilityProbe':          { probe: null, unseen: 'unseen' },
  'sink.stateIsPerInstance':                     { here: true, there: 0, distinctPorts: true },

  'signature.good':                              { ok: true },
  'signature.goodOverBytes':                     { ok: true },
  'signature.wrongSecret':                       { ok: false, reason: 'signature does not match' },
  'signature.missingHeader':                     { ok: false, reason: 'no X-Hub-Signature-256' },
  'signature.notSha256':                         { ok: false, reason: 'no X-Hub-Signature-256' },
  'signature.oneByteChangedInTheBody':           { ok: false, reason: 'signature does not match' },
  'signature.truncatedHeaderIsNotAThrow':        { ok: false, reason: 'signature does not match' },
  'signature.noSecretRefuses':                   { ok: false, reason: 'no hook secret is configured on this side' },
  'parsePush.push':                              { id: 'd-1', type: 'push', payload: PUSH_BODY },
  'parsePush.pingIsIgnored':                     null,
  'parsePush.branchDeleteAndGiteaHeaders':       { id: 'g-1', type: 'push', payload: { ref: 'refs/heads/x', after: '0000000000000000000000000000000000000000', deleted: true, defaultBranch: null, author: 'Bo', message: null } },
}))
