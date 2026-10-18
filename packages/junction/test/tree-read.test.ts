// test/tree-read.test.ts — `$recursive`, a tree read over the wire (FJS-1748, FJS-D1098)
//
// `findMany({ recursive })` is a Litestone read, graded at the Data boundary at
// every level. The wire had no spelling for it, so a breadcrumb was a custom
// read method per tree model. One structured directive carries it; the walk and
// its refusals stay litestone's.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../../litestone/src/index.js'
import { createApp, createStubAuth } from '../index.ts'
import { buildService } from '../src/core/service.ts'
import { request } from '../src/testing/index.ts'

async function trees() {
  const db: any = await createClient({
    db: ':memory:',
    schema: `
      model Page {
        id       Int     @id
        title    String
        parentId Int?
        parent   Page?   @relation(fields: [parentId], references: [id])
        children Page[]

        @@gate(0)
      }

      claim id

      model Folder {
        id       Int      @id
        name     String
        ownerId  String
        parentId Int?
        parent   Folder? @relation(fields: [parentId], references: [id])
        children Folder[]

        @@allow(read, ownerId == auth().id)
      }
    `,
  })
  const sys = db.asSystem()
  await sys.page.createMany({ data: [
    { id: 1, title: 'root' }, { id: 2, title: 'a', parentId: 1 }, { id: 3, title: 'b', parentId: 2 },
  ] })
  await sys.folder.createMany({ data: [
    { id: 1, name: 'mine',   ownerId: 'u1' },
    { id: 2, name: 'theirs', ownerId: 'u2', parentId: 1 },
    { id: 3, name: 'deep',   ownerId: 'u1', parentId: 2 },
    { id: 4, name: 'also',   ownerId: 'u1', parentId: 1 },
  ] })

  const app = createApp({ db, auth: createStubAuth({ users: [{ id: 'u1', role: 'member' }] }) })
  app.services.register(buildService({ name: 'pages',   model: 'Page' }))
  app.services.register(buildService({ name: 'folders', model: 'Folder' }))
  return { app, db }
}

const get = async (app: any, path: string, token?: string): Promise<any> =>
  token ? request(app).get(path).auth(token) : request(app).get(path)

describe('$recursive — a tree read over the wire', () => {

  test('ancestors: the breadcrumb is one find, anchor excluded, nearest first', async () => {
    const { app } = await trees()
    const res = await get(app, '/pages?id=3&$recursive[direction]=ancestors&$orderBy[_depth]=asc')
    expect(res.status).toBe(200)
    expect(res.body.data.map((r: any) => [r.id, r._depth])).toEqual([[2, 1], [1, 2]])
  })

  test('a tree read skips the default page: total is the length, limit and offset are absent', async () => {
    const { app } = await trees()
    const res = await get(app, '/pages?id=1&$recursive=true')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.total).toBe(2)
    expect('limit' in res.body).toBe(false)
    expect('offset' in res.body).toBe(false)
  })

  test('nested: each node carries its children', async () => {
    const { app } = await trees()
    const res = await get(app, '/pages?id=1&$recursive[nested]=true')
    expect(res.status).toBe(200)
    expect(res.body.data.map((r: any) => r.id)).toEqual([2])
    expect(res.body.data[0].children.map((r: any) => r.id)).toEqual([3])
  })

  test('maxDepth bounds the walk', async () => {
    const { app } = await trees()
    const res = await get(app, '/pages?id=1&$recursive[maxDepth]=1')
    expect(res.body.data.map((r: any) => r.id)).toEqual([2])
  })

  test('a row the caller cannot read hides its branch, as a flat read would', async () => {
    const { app } = await trees()
    const token = 'test-token-u1'
    const res = await get(app, '/folders?id=1&$recursive=true', token)
    expect(res.status).toBe(200)
    expect(res.body.data.map((r: any) => r.id)).toEqual([4])
  })

  test('an unknown key under $recursive is refused by name', async () => {
    const { app } = await trees()
    const res = await get(app, '/pages?id=1&$recursive[depth]=2')
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain('depth')
  })

  test('a direction that is neither is refused', async () => {
    const { app } = await trees()
    const res = await get(app, '/pages?id=1&$recursive[direction]=sideways')
    expect(res.status).toBe(400)
  })

  test('nested with $limit is refused (cuts branches out of the middle)', async () => {
    const { app } = await trees()
    const res = await get(app, '/pages?id=1&$recursive[nested]=true&$limit=1')
    expect(res.status).toBe(400)
  })

  test('$recursive on aggregate and on a single read is refused by name', async () => {
    const { app } = await trees()
    const one = await get(app, '/pages?id=1&$first=true&$recursive=true')
    expect(one.status).toBe(400)
    expect(JSON.stringify(one.body)).toContain('$recursive')
  })
})
