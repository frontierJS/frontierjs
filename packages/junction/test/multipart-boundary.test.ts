// multipart-boundary.test.ts — the boundary is case-sensitive and the type is not.
//
// `parseBody` lowercased the whole `content-type` header and then read the
// boundary out of that. A media type is case-insensitive; a PARAMETER value is
// not (RFC 2046 §5.1.1 says so about this parameter by name), so the boundary
// handed to the splitter did not match the one in the body and no part was
// found — `data: {}`, and a create answering `Request body is required` about a
// request that plainly has one.
//
// Every browser generates a mixed-case boundary: Chrome and Safari write
// `----WebKitFormBoundary…`, Firefox writes `---------------------------` plus
// digits. So no file has ever been uploaded from a browser to a Junction app,
// while every probe of the path passed — curl, Bun's own `new Request({ body:
// form })` and `undici` all generate lowercase hex, and the one existing test
// asserted the body's TYPE and never its contents (`FJS-542`).

import { describe, it, expect } from 'bun:test'
import { parseBody } from '../src/transport/body.ts'

/** A multipart body built by hand, so the boundary is this test's to choose. */
function multipart(boundary: string, headerValue = `multipart/form-data; boundary=${boundary}`) {
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="alt"\r\n\r\n` +
    `a photograph\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="Photo.PNG"\r\n` +
    `Content-Type: image/png\r\n\r\n` +
    `PNGBYTES\r\n` +
    `--${boundary}--\r\n`
  return new Request('http://localhost/product-images', {
    method:  'POST',
    headers: { 'content-type': headerValue },
    body,
  })
}

describe('a multipart boundary is case-sensitive', () => {
  it('parses the one every browser actually sends', async () => {
    const parsed = await parseBody(multipart('----WebKitFormBoundarybUWK9MfqvvgQ6B0J'))
    expect(parsed.type).toBe('multipart')
    // The assertion that was missing: the CONTENTS, not the type. A body nothing
    // could be split out of still answers `multipart`.
    expect((parsed.data as Record<string, unknown>).alt).toBe('a photograph')
    expect(parsed.files.length).toBe(1)
    expect(parsed.files[0].name).toBe('file')
  })

  it('and the lowercase one that always worked', async () => {
    const parsed = await parseBody(multipart('------------------------1a2b3c4d5e6f'))
    expect((parsed.data as Record<string, unknown>).alt).toBe('a photograph')
    expect(parsed.files.length).toBe(1)
  })

  it('a filename keeps its own case too', async () => {
    // The same bug one level down if the fix had lowercased the parts instead:
    // a stored file called `Photo.PNG` is not `photo.png`, and on a
    // case-sensitive object store that is a 404 rather than a cosmetic slip.
    const parsed = await parseBody(multipart('----WebKitFormBoundaryXYZ'))
    expect(parsed.files[0].filename).toBe('Photo.PNG')
  })

  it('the media type is still matched case-insensitively', async () => {
    // The half the lowercasing was there for, and it has to keep working:
    // `Multipart/Form-Data` is the same media type.
    const parsed = await parseBody(
      multipart('----WebKitFormBoundaryABC', 'Multipart/Form-Data; BOUNDARY=----WebKitFormBoundaryABC'))
    expect(parsed.type).toBe('multipart')
    expect((parsed.data as Record<string, unknown>).alt).toBe('a photograph')
  })

  it('a quoted boundary has its quotes taken off', async () => {
    // Legal, and required for a value holding a comma or a space. Matched
    // against the bytes with the quotes still on, it finds nothing.
    const parsed = await parseBody(
      multipart('----WebKitFormBoundary Q', 'multipart/form-data; boundary="----WebKitFormBoundary Q"'))
    expect((parsed.data as Record<string, unknown>).alt).toBe('a photograph')
  })
})
