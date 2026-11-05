// test/dataforseo.drive.ts — the connector against the sink. No fixture: every
// accepted task bills an agency. What is only provable here: the login is sent
// as Basic `login:password` and a wrong pair is `auth_failed`; a 200 whose
// envelope fails is refused by `validate` and read as its own kind; one post's
// tasks are answered one by one, a failed task beside created ones; 101 tasks
// and a live array are refused before anything is sent; a lost post is not
// resent and `tasksReady` finds what it created by the caller's tag; cost is
// micros, never a cent rounded to nothing.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startDataforseoSink } from '../sink.ts'
import { dataforseoTarget, bindSend, postTasks, live, tasksReady, getTask, toMicros, DATAFORSEO_TARGET } from '../src/index.ts'

const { got, t } = results()
const sink = startDataforseoSink({ accounts: { 'login@agency.test': 'secret' }, readyAfterMs: 60 })
const ctl = control(sink.url)
const conduit = createConduit({ credentials: createStaticResolver({ DATAFORSEO_LOGIN: 'login@agency.test:secret', WRONG: 'login@agency.test:nope' }), ...DRIVE_RESILIENCE })
await conduit.register(dataforseoTarget({ address: sink.url }))
await conduit.register(dataforseoTarget({ address: sink.url, id: 'provider:dataforseo:wrong', ref: 'WRONG' }))
const send = bindSend(conduit)
const wrong = bindSend(conduit, 'provider:dataforseo:wrong')
const SERP = 'serp/google/organic/task_post'
const seen = () => ctl.seen() as unknown as Promise<{ requests: { login: string | null; tasks: number; status: number }[]; tasks: { id: string; tag?: string; collected: boolean }[] }>
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

try {
  const task = (tag: string) => ({ keyword: 'lawn care austin', location_code: 2840, language_code: 'en', depth: 20, tag })

  const bad = await postTasks(wrong, SERP, [task('x')])
  t('basic.wrongPairIsAuthFailed', { kind: bad.error?.kind, code: bad.error?.code, retryable: bad.error?.retryable })

  await ctl.reset(); await ctl.arm({ failTasks: 1 })
  const posted = await postTasks(send, SERP, [task('a'), task('b'), task('c')])
  t('post.eachTaskAnsweredOnItsOwn', { ok: !posted.error, kinds: posted.tasks?.map(x => x.kind), tags: posted.tasks?.map(x => x.tag), loginSent: (await seen()).requests[0]?.login, costMicros: posted.costMicros })

  let threw = ''
  try { await postTasks(send, SERP, Array.from({ length: 101 }, (_, i) => task(String(i)))) } catch (e) { threw = (e as Error).message }
  let threwLive = ''
  try { await postTasks(send, 'serp/google/organic/live/advanced', [task('x')]) } catch (e) { threwLive = (e as Error).message }
  t('refusedLocally.over100AndLiveArray', { over: /takes 100/.test(threw), liveViaPost: /live endpoint/.test(threwLive), attempts: (await seen()).requests.length })

  await ctl.reset(); await ctl.arm({ refuseWith: 40200 })
  const broke = await postTasks(send, SERP, [task('x')])
  t('envelope.failedTwoHundredIsItsOwnKind', { kind: broke.error?.kind, code: broke.error?.code, retryable: broke.error?.retryable, http: (await seen()).requests[0]?.status })

  await ctl.reset(); await ctl.arm({ rateLimit: true })
  const limited = await postTasks(send, SERP, [task('x')])
  t('rateLimited.handedToCallerWithWindow', { kind: limited.error?.kind, retryable: limited.error?.retryable, retryAfterMs: limited.error?.retryAfterMs, attempts: (await seen()).requests.length })

  await ctl.reset(); await ctl.arm({ lost: true })
  const lost = await postTasks(send, SERP, [task('lost-1')])
  t('lostPost.notResent', { kind: lost.error?.kind, retryable: lost.error?.retryable, attempts: (await seen()).requests.length })

  // The post that was lost still created its task: the caller's tag is how tasks_ready finds it (C6).
  await wait(80)
  const ready = await tasksReady(send, SERP)
  const found = ready.ready?.find(r => r.tag === 'lost-1')
  t('lostPost.resolvedByTagInTasksReady', { found: !!found, readyIsFree: (await seen()).requests.at(-1)?.status })

  const early = await postTasks(send, SERP, [task('e')])
  const eid = early.tasks![0].id
  const notYet = await getTask(send, SERP, eid)
  await wait(80)
  const done = await getTask(send, SERP, eid)
  const after = await tasksReady(send, SERP)
  t('getTask.notReadyThenCollected', { first: notYet.task?.kind, firstCode: notYet.task?.code, then: done.task?.kind, items: (done.task?.result as { items: unknown[] }[] | null)?.[0]?.items.length, leftList: !after.ready?.some(r => r.id === eid) })

  const one = await live(send, 'backlinks/referring_domains/live', { target: 'kobami.test', limit: 10 })
  t('live.oneTaskAnsweredInline', { kind: one.task?.kind, hasResult: Array.isArray(one.task?.result), costMicros: one.task?.costMicros })
  let threwNotLive = ''
  try { await live(send, SERP, task('x')) } catch (e) { threwNotLive = (e as Error).message }
  t('live.refusesStandardPath', /not a live endpoint/.test(threwNotLive))

  t('cost.isMicrosNotCents', { sixHundred: toMicros(0.0006), nothing: toMicros(undefined), tenCents: toMicros(0.1) })
  t('target.perAccountId', { one: dataforseoTarget().id, per: dataforseoTarget({ accountId: 'ag7' }).id, perCaller: (dataforseoTarget({ perCaller: true }).auth as { per_caller?: true }).per_caller, base: DATAFORSEO_TARGET })
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message)
} finally { sink.stop(); await conduit.destroy() }

process.exit(report(got, {
  'basic.wrongPairIsAuthFailed':            { kind: 'auth_failed', code: 40100, retryable: false },
  'post.eachTaskAnsweredOnItsOwn':          { ok: true, kinds: ['refused', 'ok', 'ok'], tags: ['a', 'b', 'c'], loginSent: 'login@agency.test', costMicros: 1200 },
  'refusedLocally.over100AndLiveArray':     { over: true, liveViaPost: true, attempts: 1 },
  'envelope.failedTwoHundredIsItsOwnKind':  { kind: 'no_funds', code: 40200, retryable: false, http: 200 },
  'rateLimited.handedToCallerWithWindow':   { kind: 'rate_limited', retryable: true, retryAfterMs: 60000, attempts: 1 },
  'lostPost.notResent':                     { kind: 'timeout', retryable: false, attempts: 1 },
  'lostPost.resolvedByTagInTasksReady':     { found: true, readyIsFree: 200 },
  'getTask.notReadyThenCollected':          { first: 'not_ready', firstCode: 40602, then: 'ok', items: 3, leftList: true },
  'live.oneTaskAnsweredInline':             { kind: 'ok', hasResult: true, costMicros: 600 },
  'live.refusesStandardPath':               true,
  'cost.isMicrosNotCents':                  { sixHundred: 600, nothing: null, tenCents: 100000 },
  'target.perAccountId':                    { one: 'provider:dataforseo', per: 'provider:dataforseo:ag7', perCaller: true, base: 'provider:dataforseo' },
}))
