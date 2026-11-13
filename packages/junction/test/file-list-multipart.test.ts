// test/file-list-multipart.test.ts
// A File[] column could not be written over HTTP (FJS-4247). The client looked
// for files among the body's top-level values only, so `{ files: [a, b] }` went
// in the `$json` part and each File became `{}`; and the bridge set
// body[part.name] once per part, so repeated parts kept only the last. Each file
// of a list now travels as its own part named `name[i]`, the rest of the list
// (refs a patch carries forward) in `$json` with a null where each file goes,
// and the bridge puts each part back at its index, so a one-file list stays a
// list and a mixed list keeps its order.

import { describe, it, expect } from 'bun:test'
import { createJunctionClient } from '../src/client/index.ts'
import { parseBody } from '../src/transport/body.ts'
import { bridge } from '../src/transport/bridge.ts'
import { stubbable } from './helpers.ts'

// What the client puts on the wire for this body, read by the server's parser
// and handed to the bridge, as a service's ctx.data.
async function arrive(body: Record<string, unknown>, method = 'POST') {
  let sent: BodyInit | null | undefined
  const original = globalThis.fetch
  stubbable.fetch = async (_input?: RequestInfo | URL, init?: RequestInit) => {
    sent = init?.body
    return Response.json({ id: 1 }, { status: 201 })
  }
  try {
    await (createJunctionClient({ url: 'http://localhost:3000' }) as unknown as { _request: Function })
      ._request(method, '/messages', body)
  } finally {
    globalThis.fetch = original
  }
  expect(sent).toBeInstanceOf(FormData)
  const parsed = await parseBody(new Request('http://localhost/messages', { method, body: sent as FormData }))
  const raw = {
    method, path: '/messages', route: {}, query: {}, headers: {},
    body: parsed.data, files: parsed.files, ip: '127.0.0.1',
  }
  const ctx = bridge.toContext(raw as never, 'messages')
  return { form: sent as FormData, data: ctx.data as Record<string, unknown> }
}

const file = (name: string, text = name) => new File([text], name, { type: 'text/plain' })

describe('a File[] value reaches the service as a list of Files', () => {
  it('two files arrive as two Files, in order, beside the other values', async () => {
    const { data } = await arrive({ body: 'hi', files: [file('a.txt', 'A'), file('b.txt', 'B')] })
    expect(data.body).toBe('hi')
    const files = data.files as File[]
    expect(Array.isArray(files)).toBe(true)
    expect(files.map(f => f.name)).toEqual(['a.txt', 'b.txt'])
    expect(files.every(f => f instanceof File)).toBe(true)
    expect(await files[1].text()).toBe('B')
  })

  it('one file is still a list', async () => {
    const { data } = await arrive({ files: [file('only.txt')] })
    const files = data.files as File[]
    expect(Array.isArray(files)).toBe(true)
    expect(files.map(f => f.name)).toEqual(['only.txt'])
  })

  it('a patch that keeps a stored ref and adds a file keeps their order', async () => {
    const kept = { key: 'messages/1/files/abc.txt', name: 'abc.txt' }
    const { data } = await arrive({ files: [file('new.txt'), kept] }, 'PATCH')
    const files = data.files as unknown[]
    expect(files).toHaveLength(2)
    expect((files[0] as File).name).toBe('new.txt')
    expect(files[1]).toEqual(kept)
  })

  it('a single File column is unchanged: one part under its own name', async () => {
    const { form, data } = await arrive({ avatar: file('me.png') })
    expect(form.has('avatar')).toBe(true)
    expect((data.avatar as File).name).toBe('me.png')
  })

  it('a list with no file is not multipart, and an empty list stays empty', async () => {
    let sent: BodyInit | null | undefined
    const original = globalThis.fetch
    stubbable.fetch = async (_i?: RequestInfo | URL, init?: RequestInit) => { sent = init?.body; return Response.json({}) }
    try {
      await (createJunctionClient({ url: 'http://localhost:3000' }) as unknown as { _request: Function })
        ._request('POST', '/messages', { files: [] })
    } finally {
      globalThis.fetch = original
    }
    expect(typeof sent).toBe('string')
    expect(JSON.parse(sent as string)).toEqual({ files: [] })
  })
})

// The whole way: the junction client, the app's HTTP transport, the service and
// litestone's FileStorage, on a File[] column.
describe('a File[] column is written over HTTP', () => {
  it('a create stores both files, and a patch keeps one and adds one', async () => {
    const { join } = await import('node:path')
    const { createClient, autoMigrate } = await import('../../litestone/src/index.js')
    const { tempDir } = await import('../../litestone/src/tmp-dirs.js')
    const { createApp, createStubAuth } = await import('../index.ts')
    const { createService } = await import('../src/core/service.ts')

    const dir = tempDir('jn-file-list-')
    const db = await createClient({ schema: 'model Note {\n  id    Int    @id @default(autoincrement())\n  files File[]\n}', db: join(dir, 'app.db') } as never) as any
    await autoMigrate(db)
    const app = createApp({ config: { name: 'files', debug: false } as never, auth: createStubAuth({ users: [] }), db } as never) as any
    app.services.register(createService({ name: 'notes', model: 'Note', allowAnonymous: true } as never))
    await app._startForTest()
    app.http.router.build()

    const original = globalThis.fetch
    stubbable.fetch = (input?: RequestInfo | URL, init?: RequestInit) => app.http.fetch(new Request(input as string, init))
    try {
      const client = createJunctionClient({ url: 'http://localhost' }) as unknown as { _request: Function }
      const created = await client._request('POST', '/notes', { files: [file('a.txt', 'A'), file('b.txt', 'B')] })
      const refs = () => JSON.parse(sqlite.query('SELECT files FROM note WHERE id = ?').get(created.id).files)
      const bytes = async () => {
        const urls = (await db.asSystem().note.findUnique({ where: { id: created.id } })).files as string[]
        return Promise.all(urls.map(async u => (await app.http.fetch(new Request(u))).text()))
      }
      const sqlite = new (await import('bun:sqlite')).Database(join(dir, 'app.db'), { readonly: true })

      expect(refs().map((r: { name: string }) => r.name)).toEqual(['a.txt', 'b.txt'])
      expect(await bytes()).toEqual(['A', 'B'])

      const [, second] = refs()
      await client._request('PATCH', `/notes/${created.id}`, { files: [second, file('c.txt', 'C')] })
      expect(refs().map((r: { name: string }) => r.name)).toEqual(['b.txt', 'c.txt'])
      expect(refs()[0].key).toBe(second.key)
      expect(await bytes()).toEqual(['B', 'C'])
      sqlite.close()
    } finally {
      globalThis.fetch = original
    }
  })
})
