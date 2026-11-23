// test/esri.drive.ts — the connector against the sink, over conduit's real http
// transport and no network. What only this drive asks: a tile comes back as the
// bytes the vendor sent and the type it named, the key rides the `token` URL
// parameter and surfaces nowhere a caller or log is handed, and a coordinate
// that is not a tile never reaches the wire.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startEsriSink, PNG, JPEG } from '../sink.ts'
import { esriImageryTarget, naipTarget, bindSend, esriTile, naipTile, basemap, ESRI_TARGET, NAIP_TARGET } from '../src/index.ts'

const { got, t } = results()
const sink = startEsriSink(), ctl = control(sink.url)
const KEY = sink.key
const same = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i])
const seen = () => ctl.seen() as unknown as Promise<{ requests: { path: string; query: string; headers: Record<string, string> }[] }>
const leaks = (v: unknown) => JSON.stringify(v, (_k, x) => x instanceof Uint8Array ? undefined : x).includes(KEY)

const conduit = createConduit({
  credentials: { ...createStaticResolver({}), get: async () => null,
    getFor: async (ref: string, who) => ref === 'ESRI_API_KEY' && who.tenant === 'acct-1' ? KEY : null },
  ...DRIVE_RESILIENCE,
})
await conduit.register(esriImageryTarget({ address: sink.url }))
await conduit.register(naipTarget({ address: sink.url }))
const esri = bindSend(conduit, ESRI_TARGET), naip = bindSend(conduit, NAIP_TARGET)
let wrongConduit: ReturnType<typeof createConduit> | undefined
const acct1 = { who: { tenant: 'acct-1', principal: null, grant: null } }
const acct2 = { who: { tenant: 'acct-2', principal: null, grant: null } }

try {
  const png = await esriTile(esri, { z: 3, x: 1, y: 2 }, acct1)
  const reqs = (await seen()).requests
  t('esri.pngRoundTripsByteIdentical', { same: same(png.tile?.bytes, PNG), type: png.tile?.contentType, cache: png.tile?.cacheControl, etag: png.tile?.etag })
  t('esri.pathIsZYXAndKeyIsTheTokenParam', { path: reqs[0]?.path, tokenIsKey: reqs[0]?.query === `?token=${KEY}`, authHeader: reqs[0]?.headers.authorization ?? null, esriHeader: reqs[0]?.headers['x-esri-authorization'] ?? null })
  t('esri.resultCarriesNoKey', { leaked: leaks(png) })

  const jpg = await esriTile(esri, { z: 4, x: 6, y: 5 }, acct1)
  t('esri.jpegRoundTripsByteIdentical', { same: same(jpg.tile?.bytes, JPEG), type: jpg.tile?.contentType })

  await ctl.reset()
  const none = await esriTile(esri, { z: 3, x: 1, y: 2 }, acct2)
  t('esri.noKeyForTheAccountIsDistinguishedAndSendsNothing', { kind: none.error?.kind, retryable: none.error?.retryable, sent: (await seen()).requests.length })
  const noWho = await esriTile(esri, { z: 3, x: 1, y: 2 })
  t('esri.noCallerIsNoKeyToo', { kind: noWho.error?.kind, sent: (await seen()).requests.length })

  // A wrong key: ArcGIS REST answers 498 as JSON under a 200.
  wrongConduit = createConduit({ credentials: { ...createStaticResolver({}), getFor: async () => 'nope' }, ...DRIVE_RESILIENCE })
  await wrongConduit.register(esriImageryTarget({ address: sink.url }))
  const bad = await esriTile(bindSend(wrongConduit!, ESRI_TARGET), { z: 3, x: 1, y: 2 }, acct1)
  t('esri.badKeyUnder200IsBadKey', { kind: bad.error?.kind, leaked: leaks(bad), sentOnce: (await seen()).requests.length === 1 })
  await ctl.reset(); await ctl.arm({ unauthorized: true })
  const u = await esriTile(esri, { z: 3, x: 1, y: 2 }, acct1)
  t('esri.a401IsBadKey', { kind: u.error?.kind, status: u.error?.status })

  await ctl.reset(); await ctl.arm({ json200: true })
  const j = await esriTile(esri, { z: 3, x: 1, y: 2 }, acct1)
  t('esri.json200IsAnErrorNotATile', { tile: j.tile ?? null, kind: j.error?.kind })
  await ctl.reset(); await ctl.arm({ markup200: true })
  const mk = await esriTile(esri, { z: 3, x: 1, y: 2 }, acct1)
  t('esri.markup200IsNotAnImage', { tile: mk.tile ?? null, kind: mk.error?.kind })

  await ctl.reset()
  const miss = await esriTile(esri, { z: 5, x: 3, y: 3 }, acct1)
  t('esri.a404IsNoTileAndNotReplayed', { kind: miss.error?.kind, retryable: miss.error?.retryable, status: miss.error?.status, attempts: (await seen()).requests.length })
  await ctl.reset(); await ctl.arm({ echoKey: true })
  const echo = await esriTile(esri, { z: 5, x: 3, y: 3 }, acct1)
  t('esri.aVendorBodyThatEchoesTheUrlCarriesNoKeyOut', { leaked: leaks(echo) })
  await ctl.reset(); await ctl.arm({ failNext: true })
  t('esri.serverErrorIsReplayed', { ok: !!(await esriTile(esri, { z: 3, x: 1, y: 2 }, acct1)).tile, attempts: (await seen()).requests.length })

  // Nothing but a tile coordinate reaches the wire.
  await ctl.reset()
  const bads: [string, unknown, unknown, unknown][] = [
    ['negativeZ', -1, 0, 0], ['zPastMax', 20, 0, 0], ['fractionalZ', 3.5, 1, 2], ['stringZ', '3', 1, 2],
    ['negativeX', 3, -1, 2], ['xPastRange', 3, 8, 2], ['fractionalX', 3, 1.5, 2], ['nanX', 3, NaN, 2], ['infinityY', 3, 1, Infinity],
    ['negativeY', 3, 1, -2], ['yPastRange', 3, 1, 8], ['fractionalY', 3, 1, 2.2], ['pathY', 3, 1, '../../../x'], ['nullX', 3, null, 2], ['undefinedY', 3, 1, undefined],
  ]
  const refusals: Record<string, string | undefined> = {}
  for (const [name, z, x, y] of bads) refusals[name] = (await esriTile(esri, { z, x, y } as { z: number; x: number; y: number }, acct1)).error?.kind
  t('esri.refusalsBeforeAnySend', { kinds: [...new Set(Object.values(refusals))], count: Object.keys(refusals).length, sent: (await seen()).requests.length })
  t('esri.zeroAndLastTileAreInRange', { sent: (await Promise.all([esriTile(esri, { z: 0, x: 0, y: 0 }, acct1), esriTile(esri, { z: 19, x: 2 ** 19 - 1, y: 2 ** 19 - 1 }, acct1)])).map(r => r.error?.kind) })

  // NAIP: keyless, and its cache ends at z 16.
  await ctl.reset()
  const n = await naipTile(naip, { z: 3, x: 1, y: 2 })
  const nreq = (await seen()).requests[0]
  t('naip.sendsNoAuth', { same: same(n.tile?.bytes, PNG), path: nreq?.path, query: nreq?.query, authHeader: nreq?.headers.authorization ?? null, token: nreq?.query.includes('token') })
  await ctl.reset()
  const n17 = await naipTile(naip, { z: 17, x: 0, y: 0 })
  t('naip.zoom17IsRefusedLocally', { kind: n17.error?.kind, sent: (await seen()).requests.length })
  t('naip.zoom16IsSent', { sent: (await naipTile(naip, { z: 16, x: 100, y: 100 }), (await seen()).requests.length) })

  t('target.holdsTheRefAndNeverAKey', { key: JSON.stringify([esriImageryTarget(), naipTarget()]).includes(KEY), auth: [esriImageryTarget().auth, naipTarget().auth] })
  t('basemap.descriptors', {
    esri: basemap('esri', '/api/tiles/{z}/{x}/{y}'), naip: basemap('naip', '/api/tiles/{z}/{x}/{y}'),
  })
} catch (e) { console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message) }
finally { sink.stop(); await conduit.destroy(); await wrongConduit?.destroy() }

process.exit(report(got, {
  'esri.pngRoundTripsByteIdentical': { same: true, type: 'image/png', cache: 'max-age=86400', etag: '"png1"'},
  'esri.pathIsZYXAndKeyIsTheTokenParam': { path: '/arcgis/rest/services/World_Imagery/MapServer/tile/3/2/1', tokenIsKey: true, authHeader: null, esriHeader: null},
  'esri.resultCarriesNoKey': { leaked: false},
  'esri.jpegRoundTripsByteIdentical': { same: true, type: 'image/jpeg'},
  'esri.noKeyForTheAccountIsDistinguishedAndSendsNothing': { kind: 'no_key', retryable: false, sent: 0},
  'esri.noCallerIsNoKeyToo': { kind: 'no_key', sent: 0},
  'esri.badKeyUnder200IsBadKey': { kind: 'bad_key', leaked: false, sentOnce: true},
  'esri.a401IsBadKey': { kind: 'bad_key', status: 401},
  'esri.json200IsAnErrorNotATile': { tile: null, kind: 'refused'},
  'esri.markup200IsNotAnImage': { tile: null, kind: 'invalid_response'},
  'esri.a404IsNoTileAndNotReplayed': { kind: 'no_tile', retryable: false, status: 404, attempts: 1},
  'esri.aVendorBodyThatEchoesTheUrlCarriesNoKeyOut': { leaked: false},
  'esri.serverErrorIsReplayed': { ok: true, attempts: 2},
  'esri.refusalsBeforeAnySend': { kinds: ['refused'], count: 15, sent: 0},
  'esri.zeroAndLastTileAreInRange': { sent: ['no_tile', 'no_tile']},
  'naip.sendsNoAuth': { same: true, path: '/arcgis/rest/services/USGSImageryOnly/MapServer/tile/3/2/1', query: '', authHeader: null, token: false},
  'naip.zoom17IsRefusedLocally': { kind: 'refused', sent: 0},
  'naip.zoom16IsSent': { sent: 1},
  'target.holdsTheRefAndNeverAKey': { key: false, auth: [{ type: 'api_key', ref: 'ESRI_API_KEY', query: 'token', per_caller: true }, { type: 'none' }] },
  'basemap.descriptors': { esri: { tiles: '/api/tiles/{z}/{x}/{y}', attribution: 'Esri, Maxar, Earthstar Geographics, and the GIS User Community', maxZoom: 19, tileSize: 256}, naip: { tiles: '/api/tiles/{z}/{x}/{y}', attribution: 'USDA, USGS The National Map: Orthoimagery', maxZoom: 16, tileSize: 256}},
}))
