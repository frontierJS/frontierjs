// file-url.test.ts — one answer for the public URL of a stored File reference
// (FJS-1094). The plugin's resolve(), fileUrl()/fileUrls() and
// S3Provider.publicUrl() build it from the same ref, so they are compared
// pairwise with a publicBase and without.

import { describe, test, expect } from 'bun:test'
import { FileStorage } from '../src/storage/file-storage.js'
import { fileUrl, fileUrls } from '../src/storage/index.js'
import { S3Provider } from '../src/storage/providers/s3.js'

const R2 = 'https://acct.r2.cloudflarestorage.com'

function ref(over: Record<string, unknown> = {}) {
  return { key: 'Product/7/photo/ab.png', bucket: 'shop', provider: 'r2', endpoint: R2, publicBase: null, ...over }
}

async function viaPlugin(r: any) {
  const plugin = FileStorage({ provider: 'r2', bucket: 'shop', endpoint: R2 }) as any
  return plugin.resolve(r, { field: 'photo', model: 'Product', ctx: {} })
}

const provider = (publicBase?: string) =>
  new S3Provider({ provider: 'r2', bucket: 'shop', endpoint: R2, accessKeyId: 'a', secretAccessKey: 's', ...(publicBase ? { publicBase } : {}) })

describe('resolve(), fileUrl(), fileUrls() and S3Provider.publicUrl() agree (FJS-1094)', () => {

  test('without a publicBase the bucket is in every answer', async () => {
    const r = ref()
    const want = `${R2}/shop/Product/7/photo/ab.png`
    expect(await viaPlugin(r)).toBe(want)
    expect(fileUrl(r)).toBe(want)
    expect(fileUrls([r])).toEqual([want])
    expect(provider().publicUrl(r.key)).toBe(want)
  })

  test('with a publicBase the bucket is not', async () => {
    const r = ref({ publicBase: 'https://cdn.test/' })
    const want = 'https://cdn.test/Product/7/photo/ab.png'
    expect(await viaPlugin(r)).toBe(want)
    expect(fileUrl(r)).toBe(want)
    expect(fileUrls([r])).toEqual([want])
    expect(provider('https://cdn.test/').publicUrl(r.key)).toBe(want)
  })

  test('a key is encoded per segment on every path', async () => {
    const key = 'Product/7/my photo#1?.png'
    const want = `${R2}/shop/Product/7/my%20photo%231%3F.png`
    const r = ref({ key })
    expect(await viaPlugin(r)).toBe(want)
    expect(fileUrl(r)).toBe(want)
    expect(fileUrls([r])).toEqual([want])
    expect(provider().publicUrl(key)).toBe(want)

    const cdn = ref({ key, publicBase: 'https://cdn.test' })
    const wantCdn = 'https://cdn.test/Product/7/my%20photo%231%3F.png'
    expect(await viaPlugin(cdn)).toBe(wantCdn)
    expect(fileUrl(cdn)).toBe(wantCdn)
    expect(provider('https://cdn.test').publicUrl(key)).toBe(wantCdn)
  })

  test('a ref with neither a publicBase nor an endpoint has no URL', async () => {
    const r = ref({ endpoint: null })
    expect(await viaPlugin(r)).toBeNull()
    expect(fileUrl(r)).toBeNull()
    expect(fileUrls([r])).toEqual([])
  })
})
