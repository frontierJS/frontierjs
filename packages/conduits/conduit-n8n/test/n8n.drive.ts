// test/n8n.drive.ts — the connector against the sink, and against a real n8n
// when FIXTURE_URL and FIXTURE_KEY are set (`test/fixture/start.sh` starts one
// in docker and prints both). What only this drive asks: two listeners on one
// origin behind two descriptors; activate is a replayable POST where the
// trigger is not, so a lost activate is retried by conduit and a lost trigger
// comes back `indeterminate` and is resolved by reading executions.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startN8nSink, STOP_AND_ERROR_NODE, WAIT_NODE } from '../sink.ts'
import { n8nTargets, bindN8n, workflows, allWorkflows, workflow, createWorkflow, deleteWorkflow, activate, deactivate, executions, execution, waitForExecution, stopExecution, retryExecution, tags, createTag, updateTag, deleteTag, workflowTags, setWorkflowTags, trigger, WEBHOOK_NODE, type N8nSend, type N8nWorkflowDefinition, type TriggerOptions } from '../src/index.ts'

const { got, t } = results()
const sink = startN8nSink(), ctl = control(sink.url)
const conduit = createConduit({ credentials: createStaticResolver({ N8N_API_KEY: sink.key, HOOK_KEY: sink.hookKey, HOOK_BASIC: sink.hookBasic, BAD_BASIC: 'hookuser:nope', BAD_KEY: 'nope', FX_KEY: process.env.FIXTURE_KEY ?? '' }), ...DRIVE_RESILIENCE })
const open   = n8nTargets({ address: sink.url })
const authed = n8nTargets({ address: sink.url, id: 'provider:n8n:authed', hook: { header: sink.hookHeader, ref: 'HOOK_KEY' } })
const badKey = n8nTargets({ address: sink.url, id: 'provider:n8n:bad', ref: 'BAD_KEY' })
const basic  = n8nTargets({ address: sink.url, id: 'provider:n8n:basic', hook: { basic: 'HOOK_BASIC' } })
const badBasic = n8nTargets({ address: sink.url, id: 'provider:n8n:basic:bad', hook: { basic: 'BAD_BASIC' } })
for (const d of [open, authed, badKey, basic, badBasic]) { await conduit.register(d.api); await conduit.register(d.hook) }
const n8n = bindN8n(conduit, open), n8nAuthed = bindN8n(conduit, authed), n8nBad = bindN8n(conduit, badKey), n8nBasic = bindN8n(conduit, basic), n8nBadBasic = bindN8n(conduit, badBasic)
const seen = async () => (await ctl.seen() as unknown as { requests: { path: string }[] }).requests
const attempts = async () => (await seen()).length

const hookNode = (path: string, extra: Record<string, unknown> = {}) => ({ name: `Webhook ${path}`, type: WEBHOOK_NODE, typeVersion: 2, position: [0, 0] as [number, number], parameters: { path, httpMethod: 'POST', responseMode: 'onReceived', options: {}, ...extra } })
const def = (name: string, nodes: N8nWorkflowDefinition['nodes'] = []): N8nWorkflowDefinition => ({ name, nodes, connections: {}, settings: {} })
// A Webhook node feeding one more node: n8n's own Stop and Error and Wait, so
// one definition ends the same way in the sink and in the real thing.
const after = (name: string, path: string, node: { type: string; typeVersion: number; parameters: Record<string, unknown>; webhookId?: string }): N8nWorkflowDefinition => ({
  name, settings: {}, nodes: [hookNode(path), { name: 'Then', position: [200, 0], ...node }],
  connections: { [`Webhook ${path}`]: { main: [[{ node: 'Then', type: 'main', index: 0 }]] } },
})
const boom = { type: STOP_AND_ERROR_NODE, typeVersion: 1, parameters: { errorMessage: 'boom' } }
const pause = (seconds: number) => ({ type: WAIT_NODE, typeVersion: 1.1, parameters: { amount: seconds, unit: 'seconds' }, webhookId: crypto.randomUUID() })
// The newest run of a workflow, waited for: a trigger answers before n8n writes it.
const latest = async (send: N8nSend, workflowId: string) => {
  for (let i = 0; i < 20; i++) { const id = (await executions(send, { workflowId, limit: 1 })).result?.data[0]?.id; if (id) return id; await Bun.sleep(250) }
  throw new Error(`no execution for ${workflowId}`)
}
// The real one registers a webhook a beat after `activate` answers.
const fire = async (send: N8nSend, path: string, opts: TriggerOptions = {}) => {
  let r = await trigger(send, path, opts)
  for (let i = 0; i < 12 && r.error?.kind === 'not_registered'; i++) { await Bun.sleep(250); r = await trigger(send, path, opts) }
  return r
}

try {
  const empty = await workflows(n8n)
  t('workflows.listsEmpty', { ok: !empty.error, count: empty.result?.data.length, next: empty.result?.nextCursor })

  const plain  = (await createWorkflow(n8n, def('plain'))).result!
  const openWf = (await createWorkflow(n8n, def('open', [hookNode('intake')]))).result!
  const secure = (await createWorkflow(n8n, def('secure', [hookNode('secure', { authentication: 'headerAuth' })]))).result!
  const reply  = (await createWorkflow(n8n, def('reply', [hookNode('echo', { responseMode: 'lastNode' })]))).result!
  t('createWorkflow.returnsInactive', { id: typeof openWf.id, active: openWf.active, nodes: openWf.nodes.length })
  const sentBefore = await attempts()
  t('createWorkflow.emptyNameRefusedLocally', { kind: (await createWorkflow(n8n, def('  '))).error?.kind, sent: (await attempts()) - sentBefore })
  t('workflow.readsById', { name: (await workflow(n8n, plain.id)).result?.name })

  await ctl.reset()
  const all = await allWorkflows(n8n, { limit: 3 })
  t('allWorkflows.walksCursor', { count: all.result?.length, requests: await attempts() })
  t('workflows.filtersByName', { count: (await workflows(n8n, { name: 'secure' })).result?.data.length })
  t('workflows.limitAboveMaxRefusedLocally', { kind: (await workflows(n8n, { limit: 251 })).error?.kind })

  const noTrig = await activate(n8n, plain.id)
  t('activate.noTriggerRefused', { kind: noTrig.error?.kind, retryable: noTrig.error?.retryable })
  t('trigger.beforeActiveNotRegistered', { kind: (await trigger(n8n, 'intake', { body: { n: 1 } })).error?.kind, hint: !!(await trigger(n8n, 'intake')).error?.hint })
  t('activate.flipsActive', { active: (await activate(n8n, openWf.id)).result?.active })

  await ctl.reset(); await ctl.arm({ lost: true })
  const act = await activate(n8n, secure.id)
  t('activate.lostIsReplayed', { ok: !act.error, active: act.result?.active, attempts: await attempts() })
  await activate(n8n, reply.id)

  await ctl.reset()
  const fired = await trigger(n8n, 'intake', { body: { lead: 42 } })
  t('trigger.startsActiveWorkflow', { status: fired.result?.status, body: fired.result?.body, executions: (await executions(n8n, { workflowId: openWf.id })).result?.data.length })
  t('trigger.replyFromWorkflow', { body: (await trigger(n8n, '/echo', { body: { hello: 'n8n' } })).result?.body })
  t('trigger.headerAuthRefusedWithoutIt', { kind: (await trigger(n8n, 'secure', { body: {} })).error?.kind })
  t('trigger.headerAuthAccepted', { status: (await trigger(n8nAuthed, 'secure', { body: {} })).result?.status })
  t('trigger.emptyPathRefusedLocally', { kind: (await trigger(n8n, '/')).error?.kind })
  const hooks = (await seen()).filter(r => r.path.startsWith('/webhook'))
  t('hook.carriesNoApiKey', { hooks: hooks.length, keyed: hooks.some(r => r.keyed) })

  await ctl.reset(); await ctl.arm({ lost: true })
  const lost = await trigger(n8n, 'intake', { body: { lead: 43 } })
  t('trigger.lostIsIndeterminate', { kind: lost.error?.kind, indeterminate: lost.error?.indeterminate, retryable: lost.error?.retryable, attempts: await attempts() })
  // C6: the read that says whether it landed. The sink records on arrival.
  const runs = (await executions(n8n, { workflowId: openWf.id })).result!
  t('trigger.lostResolvedByExecutions', { landed: runs.data.length === 2, mode: runs.data[0]?.mode })
  t('execution.readsById', { status: (await execution(n8n, runs.data[0]!.id)).result?.status })
  t('executions.filtersByStatus', { success: (await executions(n8n, { status: 'success' })).result?.data.length, error: (await executions(n8n, { status: 'error' })).result?.data.length })
  t('deactivate.flipsBack', { active: (await deactivate(n8n, openWf.id)).result?.active, kind: (await trigger(n8n, 'intake')).error?.kind })

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const rl = await createWorkflow(n8n, def('throttled'))
  t('rateLimited.createHandedBack', { kind: rl.error?.kind, retryable: rl.error?.retryable, retryAfterMs: rl.error?.retryAfterMs, attempts: await attempts(), created: (await workflows(n8n, { name: 'throttled' })).result?.data.length })

  await ctl.reset(); await ctl.arm({ failNext: true })
  const read = await workflow(n8n, plain.id)
  t('serverError.readIsReplayed', { ok: !read.error, attempts: await attempts() })
  t('auth.badKeyIsAuthFailed', { kind: (await workflows(n8nBad)).error?.kind })

  const soon = await deleteWorkflow(n8n, openWf.id)
  t('deleteWorkflow.afterDeactivateIsUnpublishing', { kind: soon.error?.kind, retryable: soon.error?.retryable, retryAfterMs: soon.error?.retryAfterMs, thenDeleted: (await deleteWorkflow(n8n, openWf.id)).result?.id === openWf.id })
  const gone = await deleteWorkflow(n8n, plain.id)
  t('deleteWorkflow.thenNotFound', { deleted: gone.result?.id === plain.id, kind: (await workflow(n8n, plain.id)).error?.kind })

  // ── tags ──
  const red = (await createTag(n8n, 'red')).result!, blue = (await createTag(n8n, 'blue')).result!
  t('tags.createdAndListed', { names: (await tags(n8n)).result?.data.map(x => x.name) })
  t('createTag.takenNameIsConflict', { kind: (await createTag(n8n, 'red')).error?.kind })
  const tagSent = await attempts()
  t('createTag.emptyOrLongNameRefusedLocally', { empty: (await createTag(n8n, ' ')).error?.kind, long: (await createTag(n8n, 'x'.repeat(25))).error?.kind, sent: (await attempts()) - tagSent })
  t('updateTag.renames', { name: (await updateTag(n8n, blue.id, 'navy')).result?.name, kind: (await updateTag(n8n, blue.id, 'red')).error?.kind })
  const tagged = (await createWorkflow(n8n, def('tagged'))).result!
  t('setWorkflowTags.replacesSet', { set: (await setWorkflowTags(n8n, tagged.id, [red.id, blue.id])).result?.map(x => x.name), read: (await workflowTags(n8n, tagged.id)).result?.length })
  t('setWorkflowTags.unknownIdRefusesAll', { kind: (await setWorkflowTags(n8n, tagged.id, [red.id, 'nope'])).error?.kind, still: (await workflowTags(n8n, tagged.id)).result?.length })
  t('workflows.filtersByTagName', { names: (await workflows(n8n, { tags: ['navy'] })).result?.data.map(w => w.name), both: (await workflows(n8n, { tags: ['red', 'navy'] })).result?.data.map(w => w.name), oneMissing: (await workflows(n8n, { tags: ['navy', 'nosuch'] })).result?.data.length })
  t('deleteTag.takesItOffWorkflows', { deleted: (await deleteTag(n8n, blue.id)).result?.id === blue.id, left: (await workflowTags(n8n, tagged.id)).result?.map(x => x.name) })
  t('setWorkflowTags.emptyClears', { left: (await setWorkflowTags(n8n, tagged.id, [])).result?.length })

  // ── retry and stop ──
  const failing = (await createWorkflow(n8n, after('failing', 'fails', boom))).result!
  const pausing = (await createWorkflow(n8n, after('pausing', 'pauses', pause(60)))).result!
  const brief   = (await createWorkflow(n8n, after('brief', 'brief', pause(1)))).result!
  for (const w of [failing, pausing, brief]) await activate(n8n, w.id)
  await trigger(n8n, 'fails', { body: {} })
  const failed = await latest(n8n, failing.id)
  const retried = await retryExecution(n8n, failed)
  t('retryExecution.startsNewRun', { mode: retried.result?.mode, retryOf: retried.result?.retryOf === failed, newId: retried.result?.id !== failed, status: retried.result?.status })
  await ctl.reset(); await ctl.arm({ lost: true })
  const lostRetry = await retryExecution(n8n, failed)
  t('retryExecution.lostIsIndeterminate', { kind: lostRetry.error?.kind, indeterminate: lostRetry.error?.indeterminate, attempts: await attempts() })
  t('retryExecution.lostResolvedByRetryOf', { retries: (await executions(n8n, { workflowId: failing.id })).result?.data.filter(e => e.retryOf === failed).length })
  t('retryExecution.unknownIdNotFound', { kind: (await retryExecution(n8n, '99999')).error?.kind })

  await trigger(n8n, 'pauses', { body: {} })
  const paused = await latest(n8n, pausing.id)
  t('stopExecution.cancelsWaiting', { before: (await execution(n8n, paused)).result?.status, status: (await stopExecution(n8n, paused)).result?.status })
  const again = await stopExecution(n8n, paused)
  t('stopExecution.endedRunIsConflict', { kind: again.error?.kind, names: /currently canceled/.test(again.error?.message ?? '') })
  await trigger(n8n, 'pauses', { body: {} })
  const paused2 = await latest(n8n, pausing.id)
  await ctl.reset(); await ctl.arm({ lost: true })
  const lostStop = await stopExecution(n8n, paused2)
  t('stopExecution.lostIsIndeterminate', { kind: lostStop.error?.kind, indeterminate: lostStop.error?.indeterminate, attempts: await attempts(), resolved: (await execution(n8n, paused2)).result?.status })
  t('stopExecution.unknownIdNotFound', { kind: (await stopExecution(n8n, '99999')).error?.kind })
  t('retryExecution.succeededIsConflict', { kind: (await retryExecution(n8n, runs.data[0]!.id)).error?.kind })

  // ── waiting for a run ──
  await trigger(n8n, 'brief', { body: {} })
  const briefRun = await latest(n8n, brief.id)
  await ctl.reset()
  const settled = await waitForExecution(n8n, briefRun, { intervalMs: 200 })
  t('waitForExecution.pollsUntilSettled', { status: settled.result?.status, polledMoreThanOnce: (await attempts()) > 1 })
  await trigger(n8n, 'pauses', { body: {} })
  const stuck = await waitForExecution(n8n, await latest(n8n, pausing.id), { timeoutMs: 300, intervalMs: 100 })
  t('waitForExecution.budgetIsTimeout', { kind: stuck.error?.kind, retryable: stuck.error?.retryable, names: /still waiting/.test(stuck.error?.message ?? '') })
  t('waitForExecution.settledAnswersAtOnce', { status: (await waitForExecution(n8n, failed)).result?.status })
  t('waitForExecution.unknownIdNotFound', { kind: (await waitForExecution(n8n, '99999')).error?.kind })

  // ── Basic Auth on the hook ──
  const guarded = (await createWorkflow(n8n, def('guarded', [hookNode('guarded', { authentication: 'basicAuth' })]))).result!
  await activate(n8n, guarded.id)
  t('trigger.basicAuthMissingIsAuthFailed', { kind: (await trigger(n8n, 'guarded', { body: {} })).error?.kind })
  t('trigger.basicAuthWrongIsAuthFailed', { kind: (await trigger(n8nBadBasic, 'guarded', { body: {} })).error?.kind })
  t('trigger.basicAuthAccepted', { status: (await trigger(n8nBasic, 'guarded', { body: {} })).result?.status })

  if (process.env.FIXTURE_URL) {
    const fx = n8nTargets({ address: process.env.FIXTURE_URL, ref: 'FX_KEY', id: 'provider:n8n:fixture' })
    await conduit.register(fx.api); await conduit.register(fx.hook)
    const live = bindN8n(conduit, fx)
    const path = `fjs-drive-${Date.now()}`
    const made = await createWorkflow(live, def(`conduit-n8n drive ${path}`, [hookNode(path)]))
    const bare = await createWorkflow(live, def(`conduit-n8n drive bare ${path}`))
    t('fixture.createsInactive', { ok: !made.error, active: made.result?.active, error: made.error?.message })
    t('fixture.noTriggerRefused', { kind: (await activate(live, bare.result!.id)).error?.kind })
    t('fixture.unknownHookNotRegistered', { kind: (await trigger(live, `${path}-nope`, { body: {} })).error?.kind })
    const on = await activate(live, made.result!.id)
    t('fixture.activates', { active: on.result?.active, error: on.error?.message })
    const again = await activate(live, made.result!.id)
    t('fixture.activateIsIdempotent', { active: again.result?.active, error: again.error?.message })
    const hit = await fire(live, path, { body: { from: 'conduit-n8n' } })
    t('fixture.triggerStarts', { status: hit.result?.status, body: hit.result?.body, error: hit.error?.message })
    // n8n writes the execution row after it answers the webhook; a short wait.
    let found = 0
    for (let i = 0; i < 20 && !found; i++) { await Bun.sleep(250); found = (await executions(live, { workflowId: made.result!.id })).result?.data.length ?? 0 }
    t('fixture.executionRecorded', { found })
    await deactivate(live, made.result!.id)
    // The real one refuses the delete while it tears the webhook down (`unpublishing`); the wait it names is honored here.
    let del = await deleteWorkflow(live, made.result!.id), waits = 0
    while (del.error?.kind === 'unpublishing' && waits++ < 10) { await Bun.sleep(del.error.retryAfterMs ?? 1000); del = await deleteWorkflow(live, made.result!.id) }
    t('fixture.deleteAfterDeactivateWaits', { unpublishingSeen: waits > 0, deleted: !del.error, error: del.error?.message })
    t('fixture.deleted', { ok: !(await deleteWorkflow(live, bare.result!.id)).error, after: (await workflow(live, made.result!.id)).error?.kind })

    const stamp = path.slice(-8), tagA = (await createTag(live, `a-${stamp}`)).result!, tagB = (await createTag(live, `b-${stamp}`)).result!
    const tw = (await createWorkflow(live, def(`tagged ${path}`))).result!
    t('fixture.tagTakenIsConflict', { kind: (await createTag(live, `a-${stamp}`)).error?.kind })
    t('fixture.setWorkflowTags', { count: (await setWorkflowTags(live, tw.id, [tagA.id, tagB.id])).result?.length, unknown: (await setWorkflowTags(live, tw.id, ['nope'])).error?.kind, still: (await workflowTags(live, tw.id)).result?.length })
    t('fixture.filtersByTagName', { ids: (await workflows(live, { tags: [`b-${stamp}`] })).result?.data.map(w => w.id).join() === tw.id, both: (await workflows(live, { tags: [`a-${stamp}`, `b-${stamp}`] })).result?.data.map(w => w.id).join() === tw.id, oneMissing: (await workflows(live, { tags: [`b-${stamp}`, `none-${stamp}`] })).result?.data.length })
    t('fixture.renameAndDeleteTag', { name: (await updateTag(live, tagB.id, `c-${stamp}`)).result?.name === `c-${stamp}`, deleted: !(await deleteTag(live, tagB.id)).error, left: (await workflowTags(live, tw.id)).result?.length })

    const fw = (await createWorkflow(live, after(`failing ${path}`, `${path}-fails`, boom))).result!
    const pw = (await createWorkflow(live, after(`pausing ${path}`, `${path}-pauses`, pause(120)))).result!
    const bw = (await createWorkflow(live, after(`brief ${path}`, `${path}-brief`, pause(2)))).result!
    for (const w of [fw, pw, bw]) await activate(live, w.id)
    await fire(live, `${path}-fails`, { body: {} })
    const fx1 = await latest(live, fw.id)
    t('fixture.failedRunSettles', { status: (await waitForExecution(live, fx1, { timeoutMs: 10_000 })).result?.status })
    const rx = await retryExecution(live, fx1)
    t('fixture.retryStartsNewRun', { mode: rx.result?.mode, retryOf: rx.result?.retryOf === fx1, newId: !!rx.result?.id && rx.result.id !== fx1, error: rx.error?.message })
    await fire(live, `${path}-pauses`, { body: {} })
    const px = await latest(live, pw.id)
    t('fixture.stopCancelsWaiting', { status: (await stopExecution(live, px)).result?.status, again: (await stopExecution(live, px)).error?.kind })
    await fire(live, `${path}-brief`, { body: {} })
    const bx = await latest(live, bw.id)
    const bs = await waitForExecution(live, bx, { timeoutMs: 15_000 })
    t('fixture.waitForSettles', { status: bs.result?.status, error: bs.error?.message })
    t('fixture.retrySucceededIsConflict', { kind: (await retryExecution(live, bx)).error?.kind })

    // A Basic Auth credential needs the editor or the credentials API; the
    // drive makes one by hand, since the connector does not write credentials.
    const cred = await (await fetch(`${process.env.FIXTURE_URL}/api/v1/credentials`, { method: 'POST', headers: { 'x-n8n-api-key': process.env.FIXTURE_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `basic ${path}`, type: 'httpBasicAuth', data: { user: sink.hookBasic.slice(0, sink.hookBasic.indexOf(':')), password: sink.hookBasic.slice(sink.hookBasic.indexOf(':') + 1) } }) })).json() as { id: string; name: string }
    const fxBasic = n8nTargets({ address: process.env.FIXTURE_URL, ref: 'FX_KEY', id: 'provider:n8n:fixture:basic', hook: { basic: 'HOOK_BASIC' } })
    await conduit.register(fxBasic.api); await conduit.register(fxBasic.hook)
    const gw = (await createWorkflow(live, def(`guarded ${path}`, [{ ...hookNode(`${path}-guarded`, { authentication: 'basicAuth' }), credentials: { httpBasicAuth: { id: cred.id, name: cred.name } } }]))).result!
    await activate(live, gw.id)
    t('fixture.basicAuthMissingIsAuthFailed', { kind: (await fire(live, `${path}-guarded`, { body: {} })).error?.kind })
    t('fixture.basicAuthAccepted', { status: (await fire(bindN8n(conduit, fxBasic), `${path}-guarded`, { body: {} })).result?.status })
  } else console.log('  skip  fixture rows — FIXTURE_URL is not set (test/fixture/start.sh starts n8n in docker)')
} catch (e) { console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message) }
finally { sink.stop(); await conduit.destroy() }

process.exit(report(got, {
  'workflows.listsEmpty':                   { ok: true, count: 0, next: null },
  'createWorkflow.returnsInactive':         { id: 'string', active: false, nodes: 1 },
  'createWorkflow.emptyNameRefusedLocally': { kind: 'refused', sent: 0 },
  'workflow.readsById':                     { name: 'plain' },
  'allWorkflows.walksCursor':               { count: 4, requests: 2 },
  'workflows.filtersByName':                { count: 1 },
  'workflows.limitAboveMaxRefusedLocally':  { kind: 'refused' },
  'activate.noTriggerRefused':              { kind: 'no_trigger', retryable: false },
  'trigger.beforeActiveNotRegistered':      { kind: 'not_registered', hint: true },
  'activate.flipsActive':                   { active: true },
  'activate.lostIsReplayed':                { ok: true, active: true, attempts: 2 },
  'trigger.startsActiveWorkflow':           { status: 200, body: { message: 'Workflow was started' }, executions: 1 },
  'trigger.replyFromWorkflow':              { body: { received: { hello: 'n8n' }, path: 'echo' } },
  'trigger.headerAuthRefusedWithoutIt':     { kind: 'forbidden' },
  'trigger.headerAuthAccepted':             { status: 200 },
  'trigger.emptyPathRefusedLocally':        { kind: 'refused' },
  'trigger.lostIsIndeterminate':            { kind: 'timeout', indeterminate: true, retryable: false, attempts: 1 },
  'trigger.lostResolvedByExecutions':       { landed: true, mode: 'webhook' },
  'execution.readsById':                    { status: 'success' },
  'executions.filtersByStatus':             { success: 4, error: 0 },
  'deactivate.flipsBack':                   { active: false, kind: 'not_registered' },
  'rateLimited.createHandedBack':           { kind: 'rate_limited', retryable: true, retryAfterMs: 1000, attempts: 1, created: 0 },
  'serverError.readIsReplayed':             { ok: true, attempts: 2 },
  'auth.badKeyIsAuthFailed':                { kind: 'auth_failed' },
  'hook.carriesNoApiKey':                   { hooks: 4, keyed: false },
  'deleteWorkflow.afterDeactivateIsUnpublishing': { kind: 'unpublishing', retryable: true, retryAfterMs: 1000, thenDeleted: true },
  'deleteWorkflow.thenNotFound':            { deleted: true, kind: 'not_found' },
  'tags.createdAndListed':                  { names: ['red', 'blue'] },
  'createTag.takenNameIsConflict':          { kind: 'conflict' },
  'createTag.emptyOrLongNameRefusedLocally': { empty: 'refused', long: 'refused', sent: 0 },
  'updateTag.renames':                      { name: 'navy', kind: 'conflict' },
  'setWorkflowTags.replacesSet':            { set: ['red', 'navy'], read: 2 },
  'setWorkflowTags.unknownIdRefusesAll':    { kind: 'not_found', still: 2 },
  'workflows.filtersByTagName':             { names: ['tagged'], both: ['tagged'], oneMissing: 0 },
  'deleteTag.takesItOffWorkflows':          { deleted: true, left: ['red'] },
  'setWorkflowTags.emptyClears':            { left: 0 },
  'retryExecution.startsNewRun':            { mode: 'retry', retryOf: true, newId: true, status: 'error' },
  'retryExecution.lostIsIndeterminate':     { kind: 'timeout', indeterminate: true, attempts: 1 },
  'retryExecution.lostResolvedByRetryOf':   { retries: 2 },
  'retryExecution.unknownIdNotFound':       { kind: 'not_found' },
  'retryExecution.succeededIsConflict':     { kind: 'conflict' },
  'stopExecution.cancelsWaiting':           { before: 'waiting', status: 'canceled' },
  'stopExecution.endedRunIsConflict':       { kind: 'conflict', names: true },
  'stopExecution.lostIsIndeterminate':      { kind: 'timeout', indeterminate: true, attempts: 1, resolved: 'canceled' },
  'stopExecution.unknownIdNotFound':        { kind: 'not_found' },
  'waitForExecution.pollsUntilSettled':     { status: 'success', polledMoreThanOnce: true },
  'waitForExecution.budgetIsTimeout':       { kind: 'timeout', retryable: true, names: true },
  'waitForExecution.settledAnswersAtOnce':  { status: 'error' },
  'waitForExecution.unknownIdNotFound':     { kind: 'not_found' },
  'trigger.basicAuthMissingIsAuthFailed':   { kind: 'auth_failed' },
  'trigger.basicAuthWrongIsAuthFailed':     { kind: 'auth_failed' },
  'trigger.basicAuthAccepted':              { status: 200 },
  ...(process.env.FIXTURE_URL ? {
    'fixture.createsInactive':        { ok: true, active: false, error: undefined },
    'fixture.noTriggerRefused':       { kind: 'no_trigger' },
    'fixture.unknownHookNotRegistered': { kind: 'not_registered' },
    'fixture.activates':              { active: true, error: undefined },
    'fixture.activateIsIdempotent':   { active: true, error: undefined },
    'fixture.triggerStarts':          { status: 200, body: { message: 'Workflow was started' }, error: undefined },
    'fixture.executionRecorded':      { found: 1 },
    'fixture.deleteAfterDeactivateWaits': { unpublishingSeen: true, deleted: true, error: undefined },
    'fixture.deleted':                { ok: true, after: 'not_found' },
    'fixture.tagTakenIsConflict':     { kind: 'conflict' },
    'fixture.setWorkflowTags':        { count: 2, unknown: 'not_found', still: 2 },
    'fixture.filtersByTagName':       { ids: true, both: true, oneMissing: 0 },
    'fixture.renameAndDeleteTag':     { name: true, deleted: true, left: 1 },
    'fixture.failedRunSettles':       { status: 'error' },
    'fixture.retryStartsNewRun':      { mode: 'retry', retryOf: true, newId: true, error: undefined },
    'fixture.stopCancelsWaiting':     { status: 'canceled', again: 'conflict' },
    'fixture.waitForSettles':         { status: 'success', error: undefined },
    'fixture.retrySucceededIsConflict': { kind: 'conflict' },
    'fixture.basicAuthMissingIsAuthFailed': { kind: 'auth_failed' },
    'fixture.basicAuthAccepted':      { status: 200 },
  } : {}),
}))
