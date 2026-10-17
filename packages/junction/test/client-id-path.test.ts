// client-id-path.test.ts — an id is one path segment on the HTTP fallback.
//
// The id comes from wherever the caller found it, and sierra's router hands a
// page its route params DECODED, so a link to /lead/..%2F..%2Fauth%2Flogout
// gives the page `../../auth/logout`. Interpolated raw into the URL, fetch
// resolves the dot segments and the signed-in caller's request lands on a path
// the link chose; a `?` or `#` in the id injects a query or drops the rest.
// Junction's router decodes each segment, so encoding round-trips. An id of
// `.` or `..` cannot be sent as a segment at all — `%2e` is a dot segment to
// the URL parser too — and is refused before any request leaves.

import { describe, it, expect, mock, afterEach } from 'bun:test'
import { createJunctionClient } from '../src/client/index.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function traceHttp() {
  const seen: string[] = []
  globalThis.fetch = mock(async (url: unknown) => {
    seen.push(new URL(String(url)).pathname + new URL(String(url)).search)
    return new Response('{"ok":true}', {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as never
  return seen
}

const lead = () => createJunctionClient({ url: 'http://localhost:3000', timeout: 2_000 })
  .service('lead') as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>

const HOSTILE = '../../auth/logout'
const ENCODED = '/lead/..%2F..%2Fauth%2Flogout'

describe('an id is one path segment on the HTTP fallback', () => {
  const calls: Array<[string, (s: Record<string, (...a: unknown[]) => Promise<unknown>>, id: unknown) => Promise<unknown>]> = [
    ['get',     (s, id) => s.get(id)],
    ['patch',   (s, id) => s.patch(id, { name: 'x' })],
    ['remove',  (s, id) => s.remove(id)],
    ['restore', (s, id) => s.restore(id)],
    ['invoke',  (s, id) => s.invoke('archive', id)],
  ]

  for (const [name, call] of calls) {
    it(`${name} encodes a traversal id rather than resolving it`, async () => {
      const seen = traceHttp()
      await call(lead(), HOSTILE)
      expect(seen).toEqual([ENCODED])
    })

    it(`${name} keeps a ? and # in the id inside the segment`, async () => {
      const seen = traceHttp()
      await call(lead(), 'a?$limit=1#b')
      expect(seen).toEqual(['/lead/a%3F%24limit%3D1%23b'])
    })

    it(`${name} refuses an id of . or .. before any request`, async () => {
      const seen = traceHttp()
      for (const id of ['.', '..']) {
        await expect(call(lead(), id)).rejects.toThrow(/path segment/)
      }
      expect(seen).toEqual([])
    })
  }

  it('a numeric id is sent as it was', async () => {
    const seen = traceHttp()
    await lead().get(42)
    expect(seen).toEqual(['/lead/42'])
  })
})
