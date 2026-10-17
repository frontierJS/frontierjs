// file-url.test.ts — one answer for the public URL of a stored File reference
// (FJS-1094). The plugin's resolve(), fileUrl()/fileUrls() and
// S3Provider.publicUrl() build it from the same ref, so they are compared
// pairwise with a publicBase and without. A publicBase is the config's, never
// the ref's (FJS-D875), so the plugin and useStorage carry it and the bare
// fileUrl()/fileUrls() do not.

import { describe, test, expect } from 'bun:test'
import { FileStorage } from '../src/storage/file-storage.js'
import { fileUrl, fileUrls } from '../src/storage/index.js'
import { S3Provider } from '../src/storage/providers/s3.js'

const R2 = 'https://acct.r2.cloudflarestorage.com'

function ref(over: Record<string, unknown> = {}) {
  return { key: 'Product/7/photo/ab.png', bucket: 'shop', provider: 'r2', endpoint: R2, ...over }
}

async function viaPlugin(r: any, publicBase?: string) {
  const plugin = FileStorage({ provider: 'r2', bucket: 'shop', endpoint: R2, ...(publicBase ? { publicBase } : {}) }) as any
  return plugin.resolve(r, { field: 'photo', model: 'Product', ctx: {} })
}

const storageFor = async (publicBase?: string) => {
  const { useStorage } = await import('../src/storage/index.js')
  return useStorage({ provider: 'r2', bucket: 'shop', endpoint: R2, accessKeyId: 'a', secretAccessKey: 's', ...(publicBase ? { publicBase } : {}) })
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
    const r = ref()
    const want = 'https://cdn.test/Product/7/photo/ab.png'
    expect(await viaPlugin(r, 'https://cdn.test/')).toBe(want)
    expect((await storageFor('https://cdn.test/')).url(r)).toBe(want)
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

    const wantCdn = 'https://cdn.test/Product/7/my%20photo%231%3F.png'
    expect(await viaPlugin(r, 'https://cdn.test')).toBe(wantCdn)
    expect((await storageFor('https://cdn.test')).url(r)).toBe(wantCdn)
    expect(provider('https://cdn.test').publicUrl(key)).toBe(wantCdn)
  })

  test('a ref with no endpoint, under a config with no publicBase, has no URL', async () => {
    const r = ref({ endpoint: null })
    expect(await viaPlugin(r)).toBeNull()
    expect(fileUrl(r)).toBeNull()
    expect(fileUrls([r])).toEqual([])
  })
})

// ─── FJS-1271 ────────────────────────────────────────────────────────────────
// A ref keeps no public origin: moving an app to another host must not orphan
// every stored file, so a read joins the config's CURRENT publicBase to the key.

describe('a File ref derives its public origin at read (FJS-D875)', () => {

  const old = { key: 'Product/7/photo/ab.png', bucket: 'shop', provider: 'local', endpoint: null, publicBase: 'http://old-host.test' }

  test('serialize writes no publicBase', async () => {
    const plugin = FileStorage({ provider: 'local', bucket: 'shop', localPath: '/tmp/fjs-1271', publicBase: 'https://cdn.test' }) as any
    plugin.onInit({ models: [] }, {})
    const written = await plugin.serialize(Buffer.from('x'), { field: 'photo', model: 'Product', id: 1, ctx: { models: {} } })
    expect('publicBase' in written).toBe(false)
  })

  test('a ref on the plugin\'s own provider resolves against the config\'s publicBase, not the stored one', async () => {
    const plugin = FileStorage({ provider: 'local', bucket: 'shop', publicBase: 'https://shop.example.com/storage' }) as any
    expect(await plugin.resolve(old, { field: 'photo', model: 'Product', ctx: {} })).toBe('https://shop.example.com/storage/Product/7/photo/ab.png')
    const { publicBase: _, ...bare } = old
    expect(await plugin.resolve(bare, { field: 'photo', model: 'Product', ctx: {} })).toBe('https://shop.example.com/storage/Product/7/photo/ab.png')
  })

  test('a ref on another provider keeps its own endpoint and bucket', async () => {
    const plugin = FileStorage({ provider: 'local', bucket: 'shop', publicBase: 'https://shop.example.com/storage' }) as any
    expect(await plugin.resolve(ref(), { field: 'photo', model: 'Product', ctx: {} })).toBe(`${R2}/shop/Product/7/photo/ab.png`)
  })

  test('useStorage(config).url derives; the bare fileUrl never reads a stored publicBase', async () => {
    const { useStorage } = await import('../src/storage/index.js')
    const storage = useStorage({ provider: 'local', bucket: 'shop', publicBase: 'https://shop.example.com/storage' })
    expect(storage.url(old)).toBe('https://shop.example.com/storage/Product/7/photo/ab.png')
    expect(fileUrl(old)).toBeNull()
    expect(fileUrls([old])).toEqual([])
  })
})
