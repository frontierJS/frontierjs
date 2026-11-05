// test/s3.drive.ts — the S3 connector against the sink, and against a fixture.
//
// `FIXTURE_URL=http://127.0.0.1:9000 FIXTURE_CREDENTIAL=minioadmin:minioadmin
// FIXTURE_REGION=us-east-1 FIXTURE_BUCKET=drive bun run drive` runs the
// (`FIXTURE_PREFIX=` when the key is restricted to an object-name prefix)
// PROTOCOL rows against a real server too (MinIO, SeaweedFS, R2 — the bucket
// must exist). The chaos rows run on the sink only: nothing real moves its
// clock on request. A pass on the sink with a fail on the fixture is the sink
// drifting from the protocol, and the sink is what gets fixed.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startS3Sink } from '../sink.ts'
import { s3Target, s3Signer, S3_SIGNER, bindSend, putObject, getObject, headObject, deleteObject, listObjects, presign, objectPath } from '../src/index.ts'

const { got, t } = results()
const sink = startS3Sink()
const ctl  = control(sink.url)

// `keyPrefix` is what a vendor key restricted by object-name prefix (B2's
// namePrefix) allows; every key the rows write starts with it, or every row is
// AccessDenied and nothing about the protocol was tested.
async function protocolRows(prefix: string, address: string, region: string, credential: string, bucket: string, keyPrefix = '') {
  const k = (name: string) => `${keyPrefix}${name}`
  const conduit = createConduit({ credentials: createStaticResolver({ S3: credential }), signers: { [S3_SIGNER]: s3Signer }, ...DRIVE_RESILIENCE })
  await conduit.register(s3Target({ address, region, ref: 'S3', id: `provider:s3:${prefix}` }))
  const send = bindSend(conduit, `provider:s3:${prefix}`)
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255])
  // A key with every character a naive join gets wrong.
  const key = k('drive/dir one/na?me#ü.png')

  const put = await putObject(send, bucket, key, bytes, { contentType: 'image/png' })
  const head = await headObject(send, bucket, key)
  const get = await getObject(send, bucket, key)
  t(`${prefix}.putHeadGet`, { putOk: !put.error, etag: !!put.meta?.etag, size: head.meta?.size, type: head.meta?.contentType, roundTrip: !!get.bytes && Buffer.from(get.bytes).equals(Buffer.from(bytes)) })

  const again = await putObject(send, bucket, key, bytes, { contentType: 'image/png' })
  t(`${prefix}.duplicatePutSameEtag`, again.meta?.etag === put.meta?.etag)

  // A server that ignores `if-none-match: *` answers 200 twice and the second
  // write wins, so a create-only write silently overwrites. Refusing the header
  // outright is loud and passes: B2 answers 501 NotImplemented to the first PUT.
  // A fresh key per run, because a versioned bucket keeps a deleted key hidden.
  const once = k(`drive/once-${Date.now()}.txt`)
  const first = await putObject(send, bucket, once, 'one', { ifNoneMatch: '*' })
  const second = await putObject(send, bucket, once, 'two', { ifNoneMatch: '*' })
  const kept = await getObject(send, bucket, once)
  await deleteObject(send, bucket, once)
  t(`${prefix}.createOnlyPutNeverOverwrites`, { overwritten: !!kept.bytes && new TextDecoder().decode(kept.bytes) === 'two' })
  console.log(`        ${prefix}: create-only PUT answered ${first.error?.code ?? 'ok'}, then ${second.error?.code ?? 'ok'}`)

  const cond = await getObject(send, bucket, key, { ifNoneMatch: put.meta!.etag! })
  t(`${prefix}.conditionalGetIs304`, { unchanged: cond.unchanged === true, noBytes: cond.bytes === undefined })

  const text = await putObject(send, bucket, k('drive/note.txt'), 'hello', { contentType: 'text/plain' })
  const textBack = await getObject(send, bucket, k('drive/note.txt'))
  t(`${prefix}.textObjectRoundTrips`, { ok: !text.error, body: textBack.bytes && new TextDecoder().decode(textBack.bytes) })

  const missing = await getObject(send, bucket, k('drive/never'))
  t(`${prefix}.missingIsMissing`, { kind: missing.error?.kind, code: missing.error?.code, retryable: missing.error?.retryable })

  const del1 = await deleteObject(send, bucket, key), del2 = await deleteObject(send, bucket, key)
  await deleteObject(send, bucket, k('drive/note.txt'))
  t(`${prefix}.deleteTwiceIsGone`, { first: del1.gone, second: del2.gone })

  // Three keys over pages of two: the token is followed, an `&` in a key comes
  // back unescaped, and the order is UTF-8 bytes, so `ü` sorts last.
  const listed = ['a & b.bin', 'b.bin', 'ü.bin'].map(n => k(`drive/list/${n}`))
  for (const name of listed) await putObject(send, bucket, name, bytes)
  const pages: string[][] = []
  let token: string | undefined, sizes: number[] = []
  do {
    const page = await listObjects(send, bucket, { prefix: k('drive/list/'), maxKeys: 2, continuationToken: token })
    if (page.error) { pages.push([`error:${page.error.code ?? page.error.kind}`]); break }
    pages.push(page.objects!.map(o => o.key.slice(k('drive/list/').length)))
    sizes.push(...page.objects!.map(o => o.size))
    token = page.nextToken ?? undefined
  } while (token && pages.length < 5)
  for (const name of listed) await deleteObject(send, bucket, name)
  t(`${prefix}.listPagesInByteOrder`, { pages, sizes })

  const wrong = createConduit({ credentials: createStaticResolver({ S3: `${credential.split(':')[0]}:wrong` }), signers: { [S3_SIGNER]: s3Signer } })
  await wrong.register(s3Target({ address, region, ref: 'S3', id: 'provider:s3:wrong' }))
  // A GET, because a HEAD answers no body and so no <Code> — on real S3 too.
  const bad = await getObject(bindSend(wrong, 'provider:s3:wrong'), bucket, k('drive/x'))
  t(`${prefix}.wrongSecretIsAuthFailed`, { kind: bad.error?.kind, code: bad.error?.code })
  await wrong.destroy()

  // Presigned: minted here, fetched by a plain client, never through conduit.
  await putObject(send, bucket, k('drive/pre.bin'), bytes)
  const url = await presign({ url: `${address}${objectPath(bucket, k('drive/pre.bin'))}`, credential, region, expiresIn: 60 })
  const direct = await fetch(url)
  // A URL that HAS expired, not one minted with a bad X-Amz-Expires: a negative
  // or zero expiry is a 400 on AWS and B2 alike and tests the parameter check.
  // The refusal is 403 AccessDenied on AWS and 401 UnauthorizedAccess on B2.
  const soon = await presign({ url: `${address}${objectPath(bucket, k('drive/pre.bin'))}`, credential, region, expiresIn: 1 })
  await Bun.sleep(2000)
  const expired = await fetch(soon)
  t(`${prefix}.presignedGetWorksAndExpires`, { status: direct.status, bytes: Buffer.from(await direct.arrayBuffer()).equals(Buffer.from(bytes)), expiredRefused: expired.status === 401 || expired.status === 403 })
  console.log(`        ${prefix}: expired presign answered ${expired.status}`)
  await deleteObject(send, bucket, k('drive/pre.bin'))
  await conduit.destroy()
}

try {
  await protocolRows('sink', sink.url, sink.region, sink.credential, 'bucket')

  // ── chaos, sink only ───────────────────────────────────────────────────
  const conduit = createConduit({ credentials: createStaticResolver({ S3: sink.credential }), signers: { [S3_SIGNER]: s3Signer }, ...DRIVE_RESILIENCE })
  await conduit.register(s3Target({ address: sink.url, region: sink.region, ref: 'S3' }))
  const send = bindSend(conduit, `provider:s3:${sink.region}`)
  const seen = () => ctl.seen() as unknown as Promise<{ requests: unknown[] }>

  const denied = await putObject(send, 'bucket', 'private/x', 'no')
  t('chaos.policyRefusalIsForbidden', { kind: denied.error?.kind, code: denied.error?.code })

  await ctl.reset(); await ctl.arm({ slowDown: { retryAfter: 1 } })
  const t0 = Date.now()
  const slow = await putObject(send, 'bucket', 'drive/slow', 'x')
  t('chaos.slowDownIsRetriedAfterWait', { ok: !slow.error, attempts: (await seen()).requests.length, waited: Date.now() - t0 >= 1000 })

  await ctl.reset(); await ctl.arm({ lost: true })
  const lost = await putObject(send, 'bucket', 'drive/lost', 'x')
  t('chaos.lostPutIsReplayed', { ok: !lost.error, attempts: (await seen()).requests.length })

  await ctl.reset(); await ctl.arm({ skew: 1200 })
  const skewed = await getObject(send, 'bucket', 'drive/slow')
  t('chaos.movedClockIsSkewNotRetried', { kind: skewed.error?.kind, code: skewed.error?.code, attempts: (await seen()).requests.length })
  await ctl.reset()
  await conduit.destroy()

  if (process.env.FIXTURE_URL) {
    await protocolRows('fixture', process.env.FIXTURE_URL, process.env.FIXTURE_REGION ?? 'us-east-1', process.env.FIXTURE_CREDENTIAL ?? 'minioadmin:minioadmin', process.env.FIXTURE_BUCKET ?? 'drive', process.env.FIXTURE_PREFIX ?? '')
  } else console.log('  skip  fixture rows — FIXTURE_URL is not set (unproved against a real server)')
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message)
} finally { sink.stop() }

const protocol = (p: string) => ({
  [`${p}.putHeadGet`]:               { putOk: true, etag: true, size: 8, type: 'image/png', roundTrip: true },
  [`${p}.duplicatePutSameEtag`]:     true,
  [`${p}.createOnlyPutNeverOverwrites`]: { overwritten: false },
  [`${p}.conditionalGetIs304`]:      { unchanged: true, noBytes: true },
  [`${p}.textObjectRoundTrips`]:     { ok: true, body: 'hello' },
  [`${p}.missingIsMissing`]:         { kind: 'missing', code: 'NoSuchKey', retryable: false },
  [`${p}.deleteTwiceIsGone`]:        { first: true, second: true },
  [`${p}.listPagesInByteOrder`]:     { pages: [['a & b.bin', 'b.bin'], ['ü.bin']], sizes: [8, 8, 8] },
  [`${p}.wrongSecretIsAuthFailed`]:  { kind: 'auth_failed', code: 'SignatureDoesNotMatch' },
  [`${p}.presignedGetWorksAndExpires`]: { status: 200, bytes: true, expiredRefused: true },
})
process.exit(report(got, {
  ...protocol('sink'),
  ...(process.env.FIXTURE_URL ? protocol('fixture') : {}),
  'chaos.policyRefusalIsForbidden':    { kind: 'forbidden', code: 'AccessDenied' },
  'chaos.slowDownIsRetriedAfterWait':  { ok: true, attempts: 2, waited: true },
  'chaos.lostPutIsReplayed':           { ok: true, attempts: 2 },
  'chaos.movedClockIsSkewNotRetried':  { kind: 'clock_skew', code: 'RequestTimeTooSkewed', attempts: 1 },
}))
