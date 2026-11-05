// test/digitalocean.drive.ts — the connector against the sink. No fixture.
// What only this drive asks: dollars become minor units with the currency's
// exponent (84.005 → 8401, not 8400.5); a create is `starting` with no
// address; a 404 is `gone` and a destroy twice is still true; a 2xx with no
// id is `indeterminate`, not `refused`; a lost create is a `timeout` that says
// it is indeterminate, and the tag finds the machine.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '@frontierjs/conduit/testing'
import { startDoSink } from '../sink.ts'
import { digitaloceanTarget, bindSend, catalog, machine, create, destroy, list, verify, DigitalOceanError } from '../src/index.ts'

const { got, t } = results()
const sink = startDoSink(), ctl = control(sink.url)
const slow = startDoSink({ token: 'dop_v1_other', bootMs: 50 })
const conduit = createConduit({ credentials: createStaticResolver({ DO: 'dop_v1_devtoken', DO_BAD: 'dop_v1_nope', DO_SLOW: 'dop_v1_other' }), ...DRIVE_RESILIENCE })
await conduit.register(digitaloceanTarget({ accountId: 'a', ref: 'DO', address: sink.url }))
await conduit.register(digitaloceanTarget({ accountId: 'bad', ref: 'DO_BAD', address: sink.url }))
await conduit.register(digitaloceanTarget({ accountId: 'slow', ref: 'DO_SLOW', address: slow.url }))
await conduit.register(digitaloceanTarget({ accountId: 'slowDefault', ref: 'DO', address: slow.url }))
const send = bindSend(conduit, 'provider:digitalocean:a')
const failure = async (fn: () => Promise<unknown>) => { try { await fn(); return null } catch (e) { return e instanceof DigitalOceanError ? { kind: e.failure.kind, id: e.failure.id, retryable: e.failure.retryable, retryAfterMs: e.failure.retryAfterMs, indeterminate: e.failure.indeterminate, reset: typeof e.failure.rateLimitReset } : { threw: String(e) } } }
const seen = () => ctl.seen() as unknown as Promise<{ requests: { method: string; path: string }[] }>
const spec = { name: 'web-1', region: 'nyc3', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64', userData: '#cloud-config', tags: ['fleet', 'fleet:server:s1'] }

try {
  t('verify.goodAndBad', { good: await verify(send), bad: await verify(bindSend(conduit, 'provider:digitalocean:bad')) })
  const cat = await catalog(send)
  const c4 = cat.sizes.find(s => s.slug === 'c-4')!
  t('catalog.moneyIsMinorUnits', { price: c4.prices.nyc3, currency: c4.currency, regionsFromPrices: Object.keys(c4.prices), unavailable: cat.regions.find(r => r.slug === 'ams2')?.available, images: cat.images.length })

  const made = await create(send, spec)
  const young = await machine(send, made.providerServerId)
  await fetch(`${sink.url}/_sink/boot`, { method: 'POST', body: JSON.stringify({ id: made.providerServerId, ip: '203.0.113.50' }) })
  const up = await machine(send, made.providerServerId)
  t('create.startsWithNoAddressThenBoots', { young: young?.status, youngIp: young?.ipAddress, up: up?.status, upIp: up?.ipAddress, tags: up?.tags })
  t('list.byTag', { byIdentity: (await list(send, { tag: 'fleet:server:s1' })).length, fleet: (await list(send, { tag: 'fleet' })).length })

  t('create.refusedSizeNotInRegion', await failure(() => create(send, { ...spec, region: 'fra1', size: 'c-4' })))
  await ctl.arm({ createNoId: true })
  t('create.2xxWithNoIdIsIndeterminate', await failure(() => create(send, spec)))

  t('machine.404IsNull', { gone: await machine(send, '424242') })
  t('destroy.twiceIsTrue', { first: await destroy(send, made.providerServerId), second: await destroy(send, made.providerServerId), afterwards: await machine(send, made.providerServerId) })

  await ctl.reset(); await ctl.arm({ lost: true })
  const lost = await failure(() => create(send, { ...spec, name: 'lost-1', tags: ['fleet', 'fleet:server:lost'] }))
  const found = await list(send, { tag: 'fleet:server:lost' })
  t('create.lostIsIndeterminateAndTagFindsIt', { ...lost, attempts: (await seen()).requests.filter(r => r.method === 'POST').length, found: found.length })

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const t0 = Date.now(); const cat2 = await catalog(send)
  t('rateLimited.getIsReplayed', { ok: cat2.sizes.length > 0, waited: Date.now() - t0 >= 1000 })
  await ctl.arm({ rateLimit: { retryAfter: 1 } })
  t('rateLimited.createHandedToCaller', await failure(() => create(send, spec)))

  await create(send, spec)
  const createdBefore = sink.created.length
  sink.reset()
  const createdAfter = sink.created.length, fleet = (await list(send, { tag: 'fleet' })).length
  t('sink.resetEmptiesToTheSeed', { createdBefore, createdAfter, fleet, nextId: (await create(send, spec)).providerServerId, handleSaw: sink.created[0]?.user_data })

  const sendSlow = bindSend(conduit, 'provider:digitalocean:slow')
  const late = await create(sendSlow, spec), atCreate = (await machine(sendSlow, late.providerServerId))?.status
  await Bun.sleep(150)
  const booted = await machine(sendSlow, late.providerServerId)
  t('sink.tokenAndBootDelay', { tokenOption: await verify(sendSlow), defaultTokenRefused: !(await verify(bindSend(conduit, 'provider:digitalocean:slowDefault'))), atCreate, afterBoot: booted?.status, ip: booted?.ipAddress })
} catch (e) { console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message) }
finally { sink.stop(); slow.stop(); await conduit.destroy() }

process.exit(report(got, {
  'verify.goodAndBad':                 { good: true, bad: false },
  'catalog.moneyIsMinorUnits':         { price: 8401, currency: 'USD', regionsFromPrices: ['nyc3'], unavailable: false, images: 2 },
  'create.startsWithNoAddressThenBoots': { young: 'starting', youngIp: null, up: 'running', upIp: '203.0.113.50', tags: ['fleet', 'fleet:server:s1'] },
  'list.byTag':                        { byIdentity: 1, fleet: 2 },
  'create.refusedSizeNotInRegion':     { kind: 'refused', id: 'unprocessable_entity', retryable: false, reset: 'undefined' },
  'create.2xxWithNoIdIsIndeterminate': { kind: 'indeterminate', indeterminate: true, retryable: false, reset: 'undefined' },
  'machine.404IsNull':                 { gone: null },
  'destroy.twiceIsTrue':               { first: true, second: true, afterwards: null },
  'create.lostIsIndeterminateAndTagFindsIt': { kind: 'timeout', indeterminate: true, retryable: false, reset: 'undefined', attempts: 1, found: 1 },
  'rateLimited.getIsReplayed':         { ok: true, waited: true },
  'rateLimited.createHandedToCaller':  { kind: 'rate_limited', id: 'too_many_requests', retryable: true, retryAfterMs: 1000, reset: 'number' },
  'sink.resetEmptiesToTheSeed':        { createdBefore: 1, createdAfter: 0, fleet: 1, nextId: '1000', handleSaw: '#cloud-config' },
  'sink.tokenAndBootDelay':            { tokenOption: true, defaultTokenRefused: true, atCreate: 'starting', afterBoot: 'running', ip: '203.0.113.100' },
}))
