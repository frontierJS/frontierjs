// file-from-path.test.ts — a File column never reads a string off the disk.
//
// A string shaped like a path (`/x`, `./x`, `../x`, `~/x`) was taken as a file
// to upload and read with readFileSync, whoever was calling. Junction types a
// File column `any`, so a JSON body naming `/etc/hostname` stored the SERVER's
// file and answered its public URL (FJS-2061). `asSystem()` is no exception: a
// system import of untrusted rows carries the same `./x`. Uploading from disk
// is `fromPath(path)`, a wrapper only code can build.

import { describe, test, expect, afterAll } from 'bun:test'
import { writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createClient, autoMigrate } from '../src/index.js'
import { FileStorage, fromPath } from '../src/storage/file-storage.js'
import { tempDir } from '../src/tmp-dirs.js'

const dir = tempDir('file-from-path')
const secret = join(dir, 'secret.txt')
writeFileSync(secret, 'server-only bytes')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function client() {
  const files = FileStorage({ provider: 'local', bucket: 'test', publicBase: 'https://cdn.test' }) as any
  const db: any = await createClient({
    schema: `
      model Photo {
        id       Int    @id
        name     String
        original File?
        @@allow('all', true)
      }
    `,
    db: ':memory:', plugins: [files],
  })
  await autoMigrate(db)
  const puts: Array<{ key: string, bytes: string }> = []
  files._provider = {
    async put(key: string, bytes: Uint8Array) { puts.push({ key, bytes: Buffer.from(bytes).toString() }) },
    async get() { return null },
    async delete() {},
  }
  return { db, puts }
}

describe('a string in a File column is never a path (FJS-2061)', () => {

  for (const path of [secret, `./${join('.', 'package.json')}`, '../package.json', '~/.bashrc']) {
    test(`a principal's create naming ${path.startsWith('/') ? 'an absolute path' : path} is refused, and nothing is read`, async () => {
      const { db, puts } = await client()
      await expect(db.$setAuth({ id: 7 }).photo.create({ data: { id: 1, name: 'x', original: path } }))
        .rejects.toThrow(/fromPath/)
      expect(puts).toEqual([])
      db.$close()
    })
  }

  test('asSystem() refuses it too — a system import of untrusted rows carries the same string', async () => {
    const { db, puts } = await client()
    await expect(db.asSystem().photo.create({ data: { id: 1, name: 'x', original: secret } }))
      .rejects.toThrow(/fromPath/)
    expect(puts).toEqual([])
    db.$close()
  })

  test('an update naming a path is refused the same way', async () => {
    const { db, puts } = await client()
    const sys = db.asSystem()
    await sys.photo.create({ data: { id: 1, name: 'x' } })
    await expect(sys.photo.update({ where: { id: 1 }, data: { original: secret } }))
      .rejects.toThrow(/fromPath/)
    expect(puts).toEqual([])
    db.$close()
  })

  test('fromPath(path) is how code uploads from disk', async () => {
    const { db, puts } = await client()
    const row = await db.asSystem().photo.create({ data: { id: 1, name: 'x', original: fromPath(secret) } })
    expect(puts.map(p => p.bytes)).toEqual(['server-only bytes'])
    expect(puts[0].key.endsWith('.txt')).toBe(true)
    expect(JSON.parse(row.original).key).toBe(puts[0].key)
    db.$close()
  })

  test('a JSON body cannot spell the wrapper', async () => {
    const { db, puts } = await client()
    const forged = JSON.parse(JSON.stringify(fromPath(secret)))
    await expect(db.$setAuth({ id: 7 }).photo.create({ data: { id: 1, name: 'x', original: forged } }))
      .rejects.toThrow()
    expect(puts).toEqual([])
    db.$close()
  })
})
