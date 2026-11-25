// test/ahrefs.drive.ts — the connector against the sink, then (with
// AHREFS_FIXTURE_KEY) against api.ahrefs.com on FREE calls only.
// What only this drive asks: a 403 is a bad key, no key, or a spent allowance
// by its body, and the call that reads it must not call a working key broken;
// an add whose answer was lost is found by the list and not made twice; a
// project is found by its bare host; and the cost headers ride every answer.
//
// The fixture rows send nothing that bills or changes the workspace: only
// GETs, and a `target` only when it is one of Ahrefs' three free test targets.

import { createConduit, createStaticResolver, type ConduitError } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startAhrefsSink } from '../sink.ts'
import {
  ahrefsTarget, bindSend, verify, listProjects, findProject, addProject, removeProject, siteAudit,
  translate, costOf, bare, AhrefsError, DEFAULT_WAIT_MS, type Send, type Cost,
} from '../src/index.ts'

const { got, t } = results()
const sink = startAhrefsSink(), ctl = control(sink.origin)
const FIXTURE_KEY = process.env.AHREFS_FIXTURE_KEY
let realConduit: ReturnType<typeof createConduit> | undefined
const conduit = createConduit({ credentials: createStaticResolver({ AHREFS_API_KEY: sink.key, AHREFS_BAD: 'nope' }), ...DRIVE_RESILIENCE })
await conduit.register(ahrefsTarget({ address: sink.url }))
await conduit.register(ahrefsTarget({ address: sink.url, ref: 'AHREFS_BAD', id: 'provider:ahrefs:bad' }))
const send = bindSend(conduit)
type Seen = { requests: { method: string; path: string; status: number; accept: string | null; hasAuth: boolean; body: unknown }[]; projects: Record<string, unknown>[] }
const seen = () => ctl.seen() as unknown as Promise<Seen>
const failure = async (fn: () => Promise<unknown>) => {
  try { await fn(); return null } catch (e) {
    if (!(e instanceof AhrefsError)) return { threw: String(e) }
    const f = e.failure
    return { kind: f.kind, retryable: f.retryable, message: f.message, ...(f.retryAfterMs !== undefined ? { retryAfterMs: f.retryAfterMs } : {}) }
  }
}
const err = (over: Partial<ConduitError>): ConduitError => ({ kind: 'auth_failed', message: 'Auth failed: 403', retryable: false, ...over } as ConduitError)
const UNITS = 'API units limit reached. The limit of this API key should be increased. Expected usage: 50, API units left: 0.'
const posts = async () => (await seen()).requests.filter(r => r.method === 'POST').length

try {
  // ── the target and the cost headers ────────────────────────────────────
  const v = await verify(send)
  const first = (await seen()).requests[0]
  t('target.sendsBearerAndAccept', { hasAuth: first.hasAuth, accept: first.accept, path: first.path })
  t('verify.readsPlanExpiryAndUnits', v.value)
  t('verify.freeCallCostsNothing', v.cost)
  const dr = await send<unknown>({ method: 'GET', path: '/site-explorer/domain-rating', query: { target: 'ahrefs.com', date: '2026-11-25' } })
  t('costOf.freeTestTargetReportsEstimateAndChargesNothing', costOf(dr.meta))
  t('costOf.absentHeadersAreNullNotZero', costOf({ headers: { 'x-api-cache': 'bogus' } }))
  t('verify.badKeyIs401Array', await failure(() => verify(bindSend(conduit, 'provider:ahrefs:bad'))))

  // ── translate, pure: each body Phase 0 captured, and the negative control ──
  const quotaErr = err({ raw: JSON.stringify({ error: UNITS }) })
  const asQuota = translate(quotaErr, { status: 403 })
  t('translate.units403IsQuota', { kind: asQuota.kind, retryable: asQuota.retryable, message: asQuota.message })
  t('translate.noKey403IsAuthFailedWithAhrefsText', translate(err({ raw: JSON.stringify(['Error', 'Forbidden']) }), { status: 403 }))
  t('translate.wrongKey401IsAuthFailedWithAhrefsText', translate(err({ raw: JSON.stringify(['Error', 'Unauthorized']) }), { status: 401 }))
  t('translate.unknownObject403FallsBackToAuthFailed', translate(err({ raw: JSON.stringify({ error: 'Your plan has no API access' }) }), { status: 403 }))
  t('translate.429HonorsRetryAfter', translate(err({ kind: 'rate_limited', retryable: true, raw: '{"error":"x"}' }), { status: 429, headers: { 'retry-after': '7' } }).retryAfterMs)
  t('translate.429WithoutHeaderWaitsAMinute', { wait: translate(err({ kind: 'rate_limited', retryable: true }), { status: 429 }).retryAfterMs, minute: DEFAULT_WAIT_MS })
  t('translate.400IsRefusedWithAhrefsText', translate(err({ kind: 'client_error', raw: JSON.stringify({ error: "missing argument 'date'" }) }), { status: 400 }))
  t('translate.otherKindsPassThrough', translate(err({ kind: 'server_error', retryable: true, raw: '<html>', message: 'boom' }), { status: 502 }))
  // The control: with the units match gone the same body reads as a bad key, which is the advice that makes an owner remake a working key.
  t('translate.CONTROL.withoutUnitsMatchQuotaReadsAuthFailed', translate(quotaErr, { status: 403 }, { quota: /(?!)/ }).kind)

  // ── over the wire: the same refusals through conduit ───────────────────
  await ctl.reset(); await ctl.arm({ unitsLimit: true })
  t('wire.units403IsQuota', await failure(() => verify(send)))
  await ctl.arm({ forbidden: true })
  t('wire.keyless403IsAuthFailed', (await failure(() => verify(send)) as { kind: string }).kind)
  await ctl.reset(); await ctl.arm({ rateLimit: 3 })
  const rl = await failure(() => verify(send))
  t('wire.429WithoutHeaderIsRateLimitedAMinute', { ...rl, attempts: (await seen()).requests.length })
  await ctl.reset(); await ctl.arm({ failNext: true })
  t('wire.serverErrorReadIsReplayed', { ok: !!(await verify(send)).value.plan, attempts: (await seen()).requests.length })

  // ── projects ───────────────────────────────────────────────────────────
  await ctl.reset()
  t('listProjects.lists', (await listProjects(send)).value.map(p => p.id + ' ' + p.url))
  t('bare.stripsSchemeWwwPathAndCase', ['https://WWW.Kobami.com/pricing?x=1', 'kobami.com/', 'http://kobami.com'].map(bare))
  t('findProject.matchesBareHostWhateverProtocolOrWww', (await findProject(send, 'https://www.KOBAMI.com/about')).value?.id)
  t('findProject.noneIsNull', (await findProject(send, 'nothing.example')).value)

  await ctl.reset()
  const added = await addProject(send, { domain: 'https://www.Acme.test/', name: 'Acme' })
  const post = (await seen()).requests.find(r => r.method === 'POST')!
  t('addProject.createsWithTpmsDefaults', { created: added.value.created, name: added.value.name, body: post.body, cost: added.cost.actual })
  const again = await addProject(send, { domain: 'acme.test', name: 'Acme' })
  t('addProject.findsFirstAndPostsOnce', { created: again.value.created, id: again.value.id === added.value.id, posts: await posts() })
  t('addProject.refusedPostCarriesAhrefsText', await failure(() => addProject(send, { domain: 'x.test', name: '' })))

  await ctl.reset(); await ctl.arm({ lost: true })
  const lostAdd = await addProject(send, { domain: 'lostanswer.test', name: 'Lost' })
  const after = await seen()
  t('addProject.lostAnswerIsFoundByTheListNotMadeTwice', {
    found: lostAdd.value.url, created: lostAdd.value.created, posts: await posts(),
    stored: after.projects.filter(p => String(p.url).startsWith('lostanswer.test')).length,
  })

  await ctl.reset()
  const gone = await removeProject(send, 'www.kobami.com')
  const del = (await seen()).requests.find(r => r.method === 'DELETE')!
  t('removeProject.deletesByIdFoundByBareHost', { id: gone.value?.id, path: del.path, left: (await seen()).projects.map(p => p.project_id) })
  await ctl.reset()
  t('removeProject.missingDomainIsNullAndSendsNoDelete', { value: (await removeProject(send, 'nothing.example')).value, deletes: (await seen()).requests.filter(r => r.method === 'DELETE').length })

  // ── the Site Audit health score ────────────────────────────────────────
  await ctl.reset()
  t('siteAudit.readsTheProjectsRow', (await siteAudit(send, '1001')).value)
  t('siteAudit.neverAuditedIsNull', (await siteAudit(send, '1002')).value)
  t('siteAudit.unknownProjectIsNull', (await siteAudit(send, '999')).value)
  t('siteAudit.isOneFreeListRead', { requests: (await seen()).requests.filter(r => r.path.startsWith('/v3/site-audit')).length, actual: (await siteAudit(send, '1001')).cost.actual })

  // ── the fixture: api.ahrefs.com, free calls only ───────────────────────
  if (FIXTURE_KEY) {
    // The real list answers 81 projects slowly enough for the sink's 800 ms patience, so the fixture has its own conduit.
    realConduit = createConduit({ credentials: createStaticResolver({ AHREFS_API_KEY: FIXTURE_KEY, AHREFS_BAD: 'nope' }), timeout_ms: 20_000, retry_limit: 2, deadline_ms: 60_000 })
    await realConduit.register(ahrefsTarget())
    const real = bindSend(realConduit)
    // A guard under the whole fixture: a write, or a paid target, is a bug in this drive and never reaches Ahrefs.
    const FREE = ['ahrefs.com', 'yep.com', 'firehose.com']
    const safe: Send = req => {
      const target = (req.query as Record<string, unknown> | undefined)?.target
      if (req.method !== 'GET' || (target !== undefined && !FREE.includes(String(target)))) throw new Error(`fixture guard: refused ${req.method} ${req.path} target=${String(target)}`)
      return real(req)
    }
    const today = new Date().toISOString().slice(0, 10)
    const lim = await verify(safe)
    t('fixture.verifyReadsLimits', { plan: typeof lim.value.plan === 'string' && lim.value.plan.length > 0, expires: lim.value.expiresAt !== null, usedIsNumber: typeof lim.value.key.used === 'number', free: lim.cost.actual === 0 })
    const rdr = await safe<{ domain_rating?: { domain_rating?: number } }>({ method: 'GET', path: '/site-explorer/domain-rating', query: { target: 'ahrefs.com', date: today } })
    const c: Cost = costOf(rdr.meta)
    t('fixture.freeTargetReportsFiftyChargesNothing', { ok: !rdr.error, rated: typeof rdr.data?.domain_rating?.domain_rating === 'number', total: c.total, actual: c.actual, rows: c.rows, cacheKnown: c.cache !== null })
    const noDate = await safe({ method: 'GET', path: '/site-explorer/domain-rating', query: { target: 'ahrefs.com' } })
    t('fixture.missingDateIs400BadRequest', noDate.error ? translate(noDate.error, noDate.meta).kind : null)
    const ps = await listProjects(safe)
    t('fixture.projectsReadsTheWorkspace', { some: ps.value.length > 0, shaped: ps.value.every(p => p.id !== '' && p.url !== ''), free: ps.cost.actual === 0 })
    const sa = await siteAudit(safe, ps.value[0]?.id ?? '')
    t('fixture.siteAuditAnswersShapeOrNull', sa.value === null || (typeof sa.value.healthScore === 'number' && sa.value.date !== ''))
    t('fixture.wrongKeyIs401WithAhrefsText', await (async () => {
      await realConduit!.register(ahrefsTarget({ ref: 'AHREFS_BAD', id: 'provider:ahrefs:bad' }))
      const f = await failure(() => verify(bindSend(realConduit!, 'provider:ahrefs:bad')))
      return f && 'kind' in f ? { kind: f.kind, message: f.message } : f
    })())
  } else console.log('  skip  fixture rows — AHREFS_FIXTURE_KEY is not set (unproved against api.ahrefs.com)')
} catch (e) { console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message) }
finally { sink.stop(); await conduit.destroy(); await realConduit?.destroy() }

const LIMITS = { plan: 'Lite, billed monthly', expiresAt: '2026-12-19T23:59:58Z', resetsAt: '2026-12-25T00:00:00Z', key: { limit: 5000, used: 50, left: 4950 }, workspace: { limit: 200000, used: 50, left: 199950 } }
const AUDIT_1001 = { healthScore: 93, date: '2026-11-01T04:31:37Z', status: 'Completed', errors: 1, warnings: 3, notices: 7, total: 87 }
process.exit(report(got, {
  'target.sendsBearerAndAccept':         { hasAuth: true, accept: 'application/json', path: '/v3/subscription-info/limits-and-usage' },
  'verify.readsPlanExpiryAndUnits':      LIMITS,
  'verify.freeCallCostsNothing':         { rows: 1, perRow: 0, total: 0, actual: 0, cache: 'no_cache' },
  'costOf.freeTestTargetReportsEstimateAndChargesNothing': { rows: 1, perRow: 2, total: 50, actual: 0, cache: 'no_cache' },
  'costOf.absentHeadersAreNullNotZero':  { rows: null, perRow: null, total: null, actual: null, cache: null },
  'verify.badKeyIs401Array':             { kind: 'auth_failed', retryable: false, message: 'Error: Unauthorized' },

  'translate.units403IsQuota':           { kind: 'quota', retryable: false, message: UNITS },
  'translate.noKey403IsAuthFailedWithAhrefsText':   { kind: 'auth_failed', message: 'Error: Forbidden', retryable: false },
  'translate.wrongKey401IsAuthFailedWithAhrefsText': { kind: 'auth_failed', message: 'Error: Unauthorized', retryable: false },
  'translate.unknownObject403FallsBackToAuthFailed': { kind: 'auth_failed', message: 'Your plan has no API access', retryable: false },
  'translate.429HonorsRetryAfter':       7000,
  'translate.429WithoutHeaderWaitsAMinute': { wait: 60000, minute: 60000 },
  'translate.400IsRefusedWithAhrefsText': { kind: 'refused', message: "missing argument 'date'", retryable: false },
  'translate.otherKindsPassThrough':     { kind: 'server_error', message: 'boom', retryable: true },
  'translate.CONTROL.withoutUnitsMatchQuotaReadsAuthFailed': 'auth_failed',

  'wire.units403IsQuota':                { kind: 'quota', retryable: false, message: UNITS },
  'wire.keyless403IsAuthFailed':         'auth_failed',
  'wire.429WithoutHeaderIsRateLimitedAMinute': { kind: 'rate_limited', retryable: true, message: 'Too many requests', retryAfterMs: 60000, attempts: 3 },
  'wire.serverErrorReadIsReplayed':      { ok: true, attempts: 2 },

  'listProjects.lists':                      ['1001 kobami.com/', '1002 fresh.example/'],
  'bare.stripsSchemeWwwPathAndCase':     ['kobami.com', 'kobami.com', 'kobami.com'],
  'findProject.matchesBareHostWhateverProtocolOrWww': '1001',
  'findProject.noneIsNull':              null,
  'addProject.createsWithTpmsDefaults':  { created: true, name: 'Acme', body: { project_name: 'Acme', url: 'acme.test', mode: 'domain', protocol: 'both', access: 'shared' }, cost: 0 },
  'addProject.findsFirstAndPostsOnce':   { created: false, id: true, posts: 1 },
  'addProject.refusedPostCarriesAhrefsText': { kind: 'refused', retryable: false, message: "missing argument 'project_name'" },
  'addProject.lostAnswerIsFoundByTheListNotMadeTwice': { found: 'lostanswer.test/', created: true, posts: 1, stored: 1 },
  'removeProject.deletesByIdFoundByBareHost': { id: '1001', path: '/v3/management/projects?project_ids=1001', left: ['1002'] },
  'removeProject.missingDomainIsNullAndSendsNoDelete': { value: null, deletes: 0 },
  'siteAudit.readsTheProjectsRow':       AUDIT_1001,
  'siteAudit.neverAuditedIsNull':        null,
  'siteAudit.unknownProjectIsNull':      null,
  'siteAudit.isOneFreeListRead':         { requests: 3, actual: 0 },

  ...(FIXTURE_KEY ? {
    'fixture.verifyReadsLimits':         { plan: true, expires: true, usedIsNumber: true, free: true },
    'fixture.freeTargetReportsFiftyChargesNothing': { ok: true, rated: true, total: 50, actual: 0, rows: 1, cacheKnown: true },
    'fixture.missingDateIs400BadRequest': 'refused',
    'fixture.projectsReadsTheWorkspace': { some: true, shaped: true, free: true },
    'fixture.siteAuditAnswersShapeOrNull': true,
    'fixture.wrongKeyIs401WithAhrefsText': { kind: 'auth_failed', message: 'Error: Unauthorized' },
  } : {}),
}))
