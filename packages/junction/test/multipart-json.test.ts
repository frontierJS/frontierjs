// test/multipart-json.test.ts
// A write that carries a file goes multipart, and a multipart text part is only
// a string. Sent as strings, a String[] column's `[]` arrived as the text "[]"
// and was refused as "tags must be an array", a Date arrived with its JSON
// quotes, and a null that clears a column was dropped. JazzHR's candidate form
// (a resume File beside tags) could not be saved at all (`FJS-1897`). The client
// now puts what is not a string in one `$json` part, and the body parser reads
// it back over the text fields.

import { describe, it, expect } from 'bun:test'
import { createJunctionClient } from '../src/client/index.ts'
import { parseBody, MULTIPART_JSON } from '../src/transport/body.ts'
import { createSchema, v } from '../src/core/schema.ts'
import { stubbable } from './helpers.ts'

// What the client puts on the wire for this body, as the server's parser reads it.
async function roundTrip(body: Record<string, unknown>) {
  let sent: BodyInit | null | undefined
  const original = globalThis.fetch
  stubbable.fetch = async (_input?: RequestInfo | URL, init?: RequestInit) => {
    sent = init?.body
    return Response.json({ id: 1 }, { status: 201 })
  }
  try {
    await (createJunctionClient({ url: 'http://localhost:3000' }) as unknown as { _request: Function })
      ._request('POST', '/candidates', body)
  } finally {
    globalThis.fetch = original
  }
  expect(sent).toBeInstanceOf(FormData)
  return { form: sent as FormData, parsed: await parseBody(new Request('http://localhost/candidates', { method: 'POST', body: sent as FormData })) }
}

const resume = () => new File(['%PDF'], 'resume.pdf', { type: 'application/pdf' })

describe('a write with a file keeps its other values', () => {
  it('a list arrives as a list, beside the file', async () => {
    const { parsed } = await roundTrip({ name: 'Ada', tags: [], labels: ['a', 'b'], resume: resume() })
    expect(parsed.type).toBe('multipart')
    expect(parsed.data).toEqual({ name: 'Ada', tags: [], labels: ['a', 'b'] })
    expect(parsed.files.map(f => f.name)).toEqual(['resume'])
  })

  it('a Json value keeps its shape, and a string that looks like JSON stays a string', async () => {
    const { parsed } = await roundTrip({ meta: { a: [1, 2] }, note: '[]', resume: resume() })
    expect(parsed.data).toEqual({ meta: { a: [1, 2] }, note: '[]' })
  })

  it('a number, a boolean and a null arrive as themselves; a Date as its ISO string', async () => {
    const at = new Date('2026-10-07T10:00:00.000Z')
    const { parsed } = await roundTrip({ count: 3, active: false, email: null, startsAt: at, resume: resume() })
    expect(parsed.data).toEqual({ count: 3, active: false, email: null, startsAt: '2026-10-07T10:00:00.000Z' })
  })

  it('strings stay plain text parts, so a form a person posts by hand still reads', async () => {
    const { form } = await roundTrip({ name: 'Ada', resume: resume() })
    expect(form.get('name')).toBe('Ada')
    expect(form.has(MULTIPART_JSON)).toBe(false)
  })

  it('the parsed body passes the validator the refused one failed', async () => {
    const S = createSchema({ name: v.string(), tags: v.array(v.string()) })
    const { parsed } = await roundTrip({ name: 'Ada', tags: [], resume: resume() })
    const r = S.validate(parsed.data as Record<string, unknown>)
    expect(r.errors).toEqual([])
    expect(r.data.tags).toEqual([])
  })

  it('a $json part that is not an object is a malformed body', async () => {
    const form = new FormData()
    form.append('name', 'Ada')
    form.append(MULTIPART_JSON, '[1]')
    const parsed = await parseBody(new Request('http://localhost/x', { method: 'POST', body: form }))
    expect(parsed.data).toBeNull()
  })
})
