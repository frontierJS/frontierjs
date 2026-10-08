// file-type.test.ts — what a stored file's type is, and what `@accept` grades.
//
// `FJS-1184`. Every `mime` reaching `serialize` is a CLAIM: a browser `File`
// carries whatever `type` the client set on it, and a path carries whatever its
// extension says. That claim was what `@accept` graded, what went onto the ref,
// and what the provider was handed as `contentType` — which is what a public
// bucket later serves under. So `@accept("image/png")` was satisfied by any
// bytes at all, provided they arrived named `.png`, and the app then served
// them under its own claim rather than the uploader's.
//
// **Nothing here had ever been executed.** Every `@accept` test in the suite is
// over the PARSER — the attribute is on the AST, the JSON Schema carries
// `x-litestone-accept` — and a declaration that parses is not a declaration that
// binds. That gap is why the defect survived, so these rows drive `serialize`.
//
// The provider is a recorder rather than a disk. What is under test is what
// litestone DECIDES — which type it grades and which it stores — and both are
// decidable at the call it makes; a real S3 behind it would test bun's fetch.

import { describe, test, expect } from 'bun:test'
import { parse }       from '../src/core/parser.js'
import { FileStorage } from '../src/storage/file-storage.js'

const SCHEMA = `
  model Doc {
    id     Int   @id
    avatar File?  @accept("image/png")
    any    File?
    doc    File?  @accept("application/pdf")
    img    File?  @accept("image/*")
    photo  File?  @accept("image/heic")
  }
`

/** The plugin with a provider that records rather than writes. */
function plugin() {
  const puts: Array<{ key: string, contentType: string, size: number }> = []
  const p = FileStorage({ provider: 'local', publicBase: 'https://cdn.test', localPath: '/tmp' }) as any
  const schema = parse(SCHEMA).schema
  p.onInit(schema, { models: Object.fromEntries(schema.models.map((m: any) => [m.name, m])) })
  p._provider = {
    async put(key: string, _bytes: unknown, opts: any) { puts.push({ key, ...opts }) },
    async get() { return null },
    async delete() {},
    async sign(key: string) { return `https://cdn.test/${key}` },
  }
  return { p, puts }
}

const bytesOf = (...parts: Array<string | number[]>) => Uint8Array.from(parts.flatMap((x) =>
  typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : x))

const PNG  = bytesOf([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 0])
const SVG  = bytesOf('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>')
const PDF  = bytesOf('%PDF-1.7\n%âãÏÓ')
const TEXT = bytesOf('just some words, and no magic number anywhere')

/** A browser upload: the `type` is the CLIENT's word and can be anything. */
const upload = (bytes: Uint8Array, name: string, type: string) =>
  new File([bytes as any], name, { type })

const save = (p: any, field: string, value: unknown) =>
  p.serialize(value, { field, model: 'Doc', id: 1, ctx: {} })

// ─── the refusal ──────────────────────────────────────────────────────────────

describe('@accept grades the bytes, not the name', () => {

  test('SVG bytes announced as image/png are refused', async () => {
    const { p } = plugin()
    // The defect verbatim: the client sets `type` and names the file, and both
    // agree with each other. Only the bytes disagree.
    await expect(save(p, 'avatar', upload(SVG, 'logo.png', 'image/png')))
      .rejects.toThrow(/not allowed/)
  })

  test('the refusal names what was claimed and what arrived', async () => {
    const { p } = plugin()
    // An error is the framework explaining its model at the moment somebody is
    // listening hardest, and *file type not allowed* on a file the uploader can
    // see is named `.png` explains nothing.
    let message = ''
    try { await save(p, 'avatar', upload(SVG, 'logo.png', 'image/png')) }
    catch (e: any) { message = e.message }
    expect(message).toContain('image/svg+xml')
    expect(message).toContain('The name claimed "image/png"')
    expect(message).toContain('accepted: image/png')
  })

  test('nothing reaches the provider when the type is refused', async () => {
    const { p, puts } = plugin()
    await save(p, 'avatar', upload(SVG, 'logo.png', 'image/png')).catch(() => {})
    expect(puts.length).toBe(0)
  })

  test('a ValidationError carries its field and model', async () => {
    const { p } = plugin()
    const err: any = await save(p, 'doc', upload(PNG, 'report.pdf', 'application/pdf')).catch((e) => e)
    expect(err.name).toBe('ValidationError')
    expect(err.field).toBe('doc')
    expect(err.model).toBe('Doc')
  })

  test('honest bytes still pass, which is the control', async () => {
    const { p, puts } = plugin()
    const ref = await save(p, 'avatar', upload(PNG, 'logo.png', 'image/png'))
    expect(ref.mime).toBe('image/png')
    expect(puts[0].contentType).toBe('image/png')
  })

  test('a wildcard is matched against the evidence too', async () => {
    const { p } = plugin()
    // `image/*` accepts the SVG on its own terms — the point is that the
    // grading input changed, not that everything is now refused.
    const ref = await save(p, 'img', upload(SVG, 'logo.png', 'image/png'))
    expect(ref.mime).toBe('image/svg+xml')
  })
})

// ─── the correction ───────────────────────────────────────────────────────────

describe('what is stored is the evidence, declared or not', () => {

  test('with no @accept nothing is refused, and the type is still corrected', async () => {
    const { p, puts } = plugin()
    // `@accept` is absent, so nothing was asked and nothing is refused —
    // a declaration that does not exist implies nothing. Recording what the
    // bytes ARE is not enforcement: it is the difference between storing
    // evidence and storing a claim, and `contentType` is what a public bucket
    // serves under.
    const ref = await save(p, 'any', upload(SVG, 'logo.png', 'image/png'))
    expect(ref.mime).toBe('image/svg+xml')
    expect(puts[0].contentType).toBe('image/svg+xml')
  })

  test('the ref and the provider never disagree', async () => {
    const { p, puts } = plugin()
    const ref = await save(p, 'any', upload(PDF, 'anything.bin', 'application/octet-stream'))
    expect(ref.mime).toBe(puts[0].contentType)
    expect(ref.mime).toBe('application/pdf')
  })

  test('raw bytes with no name at all are typed by what they are', async () => {
    const { p, puts } = plugin()
    // A Buffer carries no name and no type, so this used to be
    // `application/octet-stream` always — and `@accept("image/png")` therefore
    // REFUSED a genuine PNG passed as bytes.
    const ref = await save(p, 'avatar', Buffer.from(PNG))
    expect(ref.mime).toBe('image/png')
    expect(puts[0].contentType).toBe('image/png')
  })
})

// ─── where there is no evidence ───────────────────────────────────────────────

describe('null is not a verdict', () => {

  test('bytes with no magic number keep the claim rather than being refused', async () => {
    const { p, puts } = plugin()
    // The row that keeps the check honest. Most text formats announce nothing,
    // so a sniffer read as authoritative would refuse every .txt and .csv ever
    // uploaded — the failure mode of a check that treats *unknown* as *wrong*.
    const ref = await save(p, 'any', upload(TEXT, 'notes.txt', 'text/plain'))
    expect(ref.mime).toBe('text/plain')
    expect(puts[0].contentType).toBe('text/plain')
  })

  test('unrecognized bytes are refused on the CLAIM, and the message does not invent evidence', async () => {
    // The pair to the row above: the same `sniff` answering null, on a field
    // that declares `@accept`. The claim is all there is, so it is what gets
    // graded — and the refusal must not say *the bytes are text/plain* about
    // bytes nothing identified. An error is read as fact.
    const { p } = plugin()
    let message = ''
    try { await save(p, 'avatar', upload(TEXT, 'notes.txt', 'text/plain')) }
    catch (e: any) { message = e.message }
    expect(message).toContain('file type "text/plain" not allowed')
    expect(message).not.toContain('the bytes are')
  })

  test('an unrecognized claim over unrecognized bytes is left alone', async () => {
    const { p } = plugin()
    const ref = await save(p, 'any', upload(TEXT, 'x.unknown', ''))
    expect(ref.mime).toBe('application/octet-stream')
  })
})

// ─── the stored key ──────────────────────────────────────────────────────────

describe('the key follows the type, so the ref and the URL cannot disagree', () => {

  test('a mislabeled photograph is stored under the extension its bytes earn', async () => {
    // A static origin serves by extension and has no ref to read. Storing a PNG
    // as `.txt` because that is what the upload was called leaves `ref.mime`
    // saying image/png and the URL serving text/plain — the same two-facts
    // defect one layer out, and the one the catalog drive caught.
    const { p, puts } = plugin()
    const ref = await save(p, 'avatar', upload(PNG, 'notes.txt', 'text/plain'))
    expect(ref.mime).toBe('image/png')
    expect(ref.key.endsWith('.png')).toBe(true)
    expect(puts[0].key).toBe(ref.key)
  })

  test('with no evidence the caller\'s own name stands', async () => {
    const { p } = plugin()
    const ref = await save(p, 'any', upload(TEXT, 'notes.txt', 'text/plain'))
    expect(ref.key.endsWith('.txt')).toBe(true)
  })
})

// ─── the parameter, found while fixing the above ─────────────────────────────

describe('a parameter is not part of the type', () => {

  test('a browser text upload is not refused by the @accept that names it', async () => {
    // `File.type` comes back with its parameters attached — Bun and every
    // browser answer `text/plain;charset=utf-8` for a `text/plain` upload — and
    // `mimeMatches` is an equality. So `@accept("text/plain")` refused the exact
    // thing it was written to allow, and only for uploads that came from a
    // browser, which is every real one.
    const f = new File([TEXT as any], 'notes.txt', { type: 'text/plain' })
    expect(f.type).toBe('text/plain;charset=utf-8')

    const { p, puts } = plugin()
    const schema = parse(`model Doc { id Int @id; note File? @accept("text/plain") }`).schema
    p.onInit(schema, { models: { Doc: schema.models[0] } })
    p._provider = { async put(k: string, _b: unknown, o: any) { puts.push({ key: k, ...o }) },
      async get() { return null }, async delete() {}, async sign(k: string) { return k } }

    const ref = await p.serialize(f, { field: 'note', model: 'Doc', id: 1, ctx: {} })
    expect(ref.mime).toBe('text/plain')
    expect(puts.at(-1).contentType).toBe('text/plain')
  })
})

// ─── one container, two registered types ─────────────────────────────────────

describe('@accept is not an equality over a format with two spellings', () => {

  // A HEIF file's `ftyp` brand decides which type it reads as: `heic`/`heix`
  // answer `image/heic`, `mif1`/`msf1` answer `image/heif`. Both are real files
  // and an app declares one of the two spellings. Once the EVIDENCE became the
  // grading input the equality refused a photograph for being the other
  // reading of itself, and the fact lived only in a kit function nobody called.
  const heif = bytesOf([0, 0, 0, 0x20], 'ftyp', 'mif1', [0, 0, 0, 0], 'mif1heic')
  const heic = bytesOf([0, 0, 0, 0x20], 'ftyp', 'heic', [0, 0, 0, 0], 'heicmif1')

  test('a mif1 photo satisfies @accept("image/heic")', async () => {
    const { p, puts } = plugin()
    const ref = await save(p, 'photo', upload(heif, 'photo.heic', 'image/heic'))
    expect(ref.mime).toBe('image/heif')
    expect(puts[0].contentType).toBe('image/heif')
  })

  test('the other brand still passes, which is the control', async () => {
    const { p } = plugin()
    const ref = await save(p, 'photo', upload(heic, 'photo.heic', 'image/heic'))
    expect(ref.mime).toBe('image/heic')
  })

  test('the equivalence is not a general looseness', async () => {
    const { p } = plugin()
    // The pair to the rows above: a list of formats that ARE one thing is only
    // useful if it refuses everything else.
    await expect(save(p, 'photo', upload(PNG, 'photo.heic', 'image/heic')))
      .rejects.toThrow(/not allowed/)
  })
})
