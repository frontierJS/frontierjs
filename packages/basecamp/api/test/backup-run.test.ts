/*
 * backup-run.test.ts — what a backup archive holds (FJS-1766).
 *
 * `VACUUM INTO` over the main database copied one file of three. The schema
 * declares `database audit` (a trail driver, a directory) and the app opens a
 * second SQLite file for the job queue, so an archive restored from the old job
 * had every row and none of the audit trail or the pending jobs.
 */

import { test, expect, describe, beforeAll } from 'bun:test'
import { Database }          from 'bun:sqlite'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join }              from 'node:path'
import { createTestEnv }     from '@frontierjs/testing'
import { GatePlugin }        from '@frontierjs/litestone'
import { basecampGateLevel } from '../src/core/gate.ts'
import { buildBasecampApp }  from '../src/app.ts'
import { takeBackup }        from '../src/jobs/backup-run.job.ts'

let env: any

beforeAll(async () => {
  env = await createTestEnv({
    schema:        join(import.meta.dir, '..', '..', 'db', 'schema.lite'),
    migrations:    join(import.meta.dir, '..', '..', 'db', 'migrations'),
    encryptionKey: '0'.repeat(64),
    plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
  })
})

describe('a backup archives every database the app keeps', () => {
  test('main, the audit trail and the jobs queue are all in the archive', async () => {
    const sys = env.system as any
    const row = await sys.backup.create({ data: {} })

    // The trail's directory is made by its first write, which lands after the
    // create returns. An archive taken before then has no trail to hold.
    const trail = env.app.db.$databases.audit.path as string
    for (let i = 0; i < 100 && !existsSync(trail); i++) await Bun.sleep(20)
    expect(existsSync(trail)).toBe(true)

    await takeBackup(env.app, row.id)

    const done = await sys.backup.findUnique({ where: { id: row.id } })
    expect(done.error).toBeNull()
    expect(done.status).toBe('success')

    const dir = done.location as string
    expect(statSync(dir).isDirectory()).toBe(true)
    expect(existsSync(join(dir, 'main.db'))).toBe(true)
    expect(existsSync(join(dir, 'jobs.db'))).toBe(true)
    expect(existsSync(join(dir, 'audit'))).toBe(true)

    // The archive opens and carries the row it was asked about.
    const copy = new Database(join(dir, 'main.db'), { readonly: true })
    try {
      expect(copy.query('SELECT id FROM backup WHERE id = ?').get(row.id)).toBeTruthy()
    } finally { copy.close() }

    // sizeBytes is the whole archive, not the largest file.
    const total = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(e => e.isFile()).reduce((n, e) => n + statSync(join(e.parentPath, e.name)).size, 0)
    expect(done.sizeBytes).toBe(total)
  })
})
