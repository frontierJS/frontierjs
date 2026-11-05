// test/hetzner.drive.ts — the connector against the sink. No fixture.
// What only this drive asks: a decimal-string GROSS price per location becomes
// minor units (4.35 net → 517.65 gross → 518); a type priced nowhere is
// dropped; 1.9 GB is 1946 MB; a label key with a colon is refused BEFORE
// sending; a 423 is `capacity`; a 201 with no id is `indeterminate`, not
// `refused`; a delete answers 200 with an action and is still true twice.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '@frontierjs/conduit/testing'
import { startHzSink } from '../sink.ts'
import { hetznerTarget, bindSend, catalog, machine, create, destroy, list, verify, HetznerError } from '../src/index.ts'

const { got, t } = results()
const sink = startHzSink(), ctl = control(sink.url)
const slow = startHzSink({ token: 'y'.repeat(64), bootMs: 50 })
const conduit = createConduit({ credentials: createStaticResolver({ HZ: 'hz'.padEnd(64, '0'), HZ_BAD: 'x'.repeat(64), HZ_SLOW: 'y'.repeat(64) }), ...DRIVE_RESILIENCE })
await conduit.register(hetznerTarget({ accountId: 'a', ref: 'HZ', address: sink.url }))
await conduit.register(hetznerTarget({ accountId: 'bad', ref: 'HZ_BAD', address: sink.url }))
await conduit.register(hetznerTarget({ accountId: 'slow', ref: 'HZ_SLOW', address: slow.url }))
await conduit.register(hetznerTarget({ accountId: 'slowDefault', ref: 'HZ', address: slow.url }))
const send = bindSend(conduit, 'provider:hetzner:a')
const failure = async (fn: () => Promise<unknown>) => { try { await fn(); return null } catch (e) { return e instanceof HetznerError ? { kind: e.failure.kind, code: e.failure.code, retryable: e.failure.retryable, retryAfterMs: e.failure.retryAfterMs, indeterminate: e.failure.indeterminate } : { threw: String(e) } } }
const seen = () => ctl.seen() as unknown as Promise<{ requests: { method: string; path: string }[] }>
const spec = { name: 'web-1', region: 'fsn1', size: 'cax11', image: 'ubuntu-24.04', userData: '#cloud-config', labels: { fleet: '', 'fleet.server': 's1' } }

try {
  t('verify.goodAndBad', { good: await verify(send), bad: await verify(bindSend(conduit, 'provider:hetzner:bad')) })
  const cat = await catalog(send)
  const cpx11 = cat.sizes.find(s => s.slug === 'cpx11')!, cax = cat.sizes.find(s => s.slug === 'cax11')!
  t('catalog.grossPerLocationAsMinorUnits', { nbg1: cpx11.prices.nbg1, hel1: cpx11.prices.hel1, currency: cpx11.currency, caxWhere: Object.keys(cax.prices), caxMb: cax.memoryMb, unpricedDropped: cat.sizes.some(s => s.slug === 'ghost'), deprecatedImageHidden: cat.images.some(i => i.slug === 'debian-10') })

  const made = await create(send, spec)
  const young = await machine(send, made.providerServerId)
  await fetch(`${sink.url}/_sink/boot`, { method: 'POST', body: JSON.stringify({ id: made.providerServerId, ip: '198.51.100.50' }) })
  const up = await machine(send, made.providerServerId)
  t('create.initializingThenRunning', { young: young?.status, youngIp: young?.ipAddress, up: up?.status, upIp: up?.ipAddress, region: up?.region })
  t('list.bySelector', { byIdentity: (await list(send, { labelSelector: 'fleet.server==s1' })).length, fleet: (await list(send, { labelSelector: 'fleet' })).length })

  const sentBefore = (await seen()).requests.length
  const colon = await failure(() => create(send, { ...spec, labels: { 'fleet:server': 's1' } }))
  t('create.colonLabelRefusedBeforeSending', { ...colon, sent: (await seen()).requests.length - sentBefore })
  t('create.typeNotSoldInLocation', await failure(() => create(send, { ...spec, region: 'nbg1' })))
  await ctl.arm({ capacity: true })
  t('create.423IsCapacity', await failure(() => create(send, spec)))
  await ctl.arm({ createNoId: true })
  t('create.201WithNoIdIsIndeterminate', await failure(() => create(send, spec)))

  t('machine.404IsNull', { gone: await machine(send, '424242') })
  t('destroy.200WithActionTwiceIsTrue', { first: await destroy(send, made.providerServerId), second: await destroy(send, made.providerServerId) })

  await ctl.reset(); await ctl.arm({ lost: true })
  const lost = await failure(() => create(send, { ...spec, name: 'lost', labels: { fleet: '', 'fleet.server': 'lost' } }))
  t('create.lostIsIndeterminateAndLabelFindsIt', { ...lost, found: (await list(send, { labelSelector: 'fleet.server==lost' })).length })

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1 } })
  t('rateLimited.createHandedToCaller', await failure(() => create(send, spec)))

  await create(send, spec)
  const createdBefore = sink.created.length
  sink.reset()
  const createdAfter = sink.created.length, fleet = (await list(send, { labelSelector: 'fleet' })).length
  t('sink.resetEmptiesToTheSeed', { createdBefore, createdAfter, fleet, nextId: (await create(send, spec)).providerServerId, handleSaw: sink.created[0]?.user_data })

  const sendSlow = bindSend(conduit, 'provider:hetzner:slow')
  const late = await create(sendSlow, spec), atCreate = (await machine(sendSlow, late.providerServerId))?.status
  await Bun.sleep(150)
  const booted = await machine(sendSlow, late.providerServerId)
  t('sink.tokenAndBootDelay', { tokenOption: await verify(sendSlow), defaultTokenRefused: !(await verify(bindSend(conduit, 'provider:hetzner:slowDefault'))), atCreate, afterBoot: booted?.status, ip: booted?.ipAddress })
} catch (e) { console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message) }
finally { sink.stop(); slow.stop(); await conduit.destroy() }

process.exit(report(got, {
  'verify.goodAndBad':                       { good: true, bad: false },
  'catalog.grossPerLocationAsMinorUnits':    { nbg1: 518, hel1: 577, currency: 'EUR', caxWhere: ['fsn1'], caxMb: 1946, unpricedDropped: false, deprecatedImageHidden: false },
  'create.initializingThenRunning':          { young: 'starting', youngIp: null, up: 'running', upIp: '198.51.100.50', region: 'fsn1' },
  'list.bySelector':                         { byIdentity: 1, fleet: 2 },
  'create.colonLabelRefusedBeforeSending':   { kind: 'refused', retryable: false, sent: 0 },
  'create.typeNotSoldInLocation':            { kind: 'refused', code: 'invalid_input', retryable: false },
  'create.423IsCapacity':                    { kind: 'capacity', code: 'resource_unavailable', retryable: false },
  'create.201WithNoIdIsIndeterminate':       { kind: 'indeterminate', indeterminate: true, retryable: false },
  'machine.404IsNull':                       { gone: null },
  'destroy.200WithActionTwiceIsTrue':        { first: true, second: true },
  'create.lostIsIndeterminateAndLabelFindsIt': { kind: 'timeout', indeterminate: true, retryable: false, found: 1 },
  'rateLimited.createHandedToCaller':        { kind: 'rate_limited', code: 'rate_limit_exceeded', retryable: true, retryAfterMs: 1000 },
  'sink.resetEmptiesToTheSeed':              { createdBefore: 1, createdAfter: 0, fleet: 1, nextId: '8000', handleSaw: '#cloud-config' },
  'sink.tokenAndBootDelay':                  { tokenOption: true, defaultTokenRefused: true, atCreate: 'starting', afterBoot: 'running', ip: '198.51.100.100' },
}))
