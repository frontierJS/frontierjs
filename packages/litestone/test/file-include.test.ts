// file-include.test.ts — a File column one join away.
//
// A read resolves the ref fields of the model it NAMES. An `include:` brings
// rows of other models back on the same result, and those were never visited —
// so the identical column answered a public URL when read directly and its raw
// stored JSON when reached through a relation. Both are strings, nothing
// reports the difference, and it fails where the value is finally used: an
// <img src> pointing at `{"key":"storage/…","provider":"local",…}`.
//
// The plugin's own hook is the unit here rather than a client with a provider
// and a disk behind it: what was wrong is which ROWS the hook walks, and that
// is decidable from the rows alone.

import { describe, test, expect } from 'bun:test'
import { parse }       from '../src/core/parser.js'
import { FileStorage } from '../src/plugins/file.js'

const SCHEMA = `
  model Product {
    id     Int    @id
    name   String
    images Image[]
    hero   File?
  }

  model Image {
    id        Int     @id
    productId Int
    product   Product @relation(fields: [productId], references: [id])
    file      File
  }
`

const ref = (key: string) => JSON.stringify({
  key, provider: 'local', publicBase: 'https://cdn.test', size: 1, mime: 'image/png',
})

function plugin() {
  const p = FileStorage({
    provider: 'local', publicBase: 'https://cdn.test', localPath: '/tmp',
  }) as any
  const schema = parse(SCHEMA).schema
  p.onInit(schema, { models: Object.fromEntries(schema.models.map((m: any) => [m.name, m])) })
  return p
}

describe('a File column is resolved wherever the read reached it', () => {

  test('top level — the case that always worked', async () => {
    const rows = [{ id: 1, name: 'Tee', hero: ref('a.png') }]
    await plugin().onAfterRead('Product', rows, {})
    expect(rows[0].hero).toBe('https://cdn.test/a.png')
  })

  test('one join away, through a to-many include', async () => {
    const rows = [{ id: 1, name: 'Tee', hero: null, images: [
      { id: 7, productId: 1, file: ref('b.png') },
      { id: 8, productId: 1, file: ref('c.png') },
    ] }]
    await plugin().onAfterRead('Product', rows, {})
    expect((rows[0].images as any[]).map(i => i.file))
      .toEqual(['https://cdn.test/b.png', 'https://cdn.test/c.png'])
  })

  test('through a to-one include, in the other direction', async () => {
    const rows = [{ id: 7, productId: 1, file: ref('b.png'),
                    product: { id: 1, name: 'Tee', hero: ref('a.png') } }]
    await plugin().onAfterRead('Image', rows, {})
    expect(rows[0].file).toBe('https://cdn.test/b.png')
    expect((rows[0].product as any).hero).toBe('https://cdn.test/a.png')
  })

  test('two joins deep', async () => {
    const rows = [{ id: 7, productId: 1, file: null,
                    product: { id: 1, name: 'Tee', hero: null, images: [
                      { id: 8, productId: 1, file: ref('c.png') },
                    ] } }]
    await plugin().onAfterRead('Image', rows, {})
    expect((rows[0].product as any).images[0].file).toBe('https://cdn.test/c.png')
  })

  test('a row reached twice is resolved once', async () => {
    // Resolving it again would hand `resolve()` a URL where it expects a ref,
    // which is not an error — it answers null and the value silently vanishes.
    const shared = { id: 1, name: 'Tee', hero: ref('a.png') }
    const rows = [
      { id: 7, productId: 1, file: null, product: shared },
      { id: 8, productId: 1, file: null, product: shared },
    ]
    await plugin().onAfterRead('Image', rows, {})
    expect(shared.hero).toBe('https://cdn.test/a.png')
  })

  test('a relation the caller did not include costs nothing and stays absent', async () => {
    const rows = [{ id: 1, name: 'Tee', hero: ref('a.png') }]
    await plugin().onAfterRead('Product', rows, {})
    expect('images' in rows[0]).toBe(false)
  })

  test('select: { resolve: false } applies where it was written, not below it', async () => {
    const rows = [{ id: 1, name: 'Tee', hero: ref('a.png'), images: [
      { id: 7, productId: 1, file: ref('b.png') },
    ] }]
    await plugin().onAfterRead('Product', rows, {}, { select: { hero: { resolve: false } } })
    expect(rows[0].hero).toBe(ref('a.png'))
    expect((rows[0].images as any[])[0].file).toBe('https://cdn.test/b.png')
  })
})
