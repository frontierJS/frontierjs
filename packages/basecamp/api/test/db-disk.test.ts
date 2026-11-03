/*
 * db-disk.test.ts — the free-space rule the `hub.disk-free` control and the
 * backup job share (FJS-3908). The fs calls are injected: no case needs a
 * full disk.
 */

import { test, expect, describe } from 'bun:test'
import { databaseDisk, dbFamilyBytes, headroomShort } from '../src/domain/host/db-disk.ts'

const GB = 1024 ** 3
const MB = 1024 ** 2
const volume = (free: number, total: number) => ({ statfs: () => ({ bavail: free / 4096, bsize: 4096, blocks: total / 4096 }) })
const files  = (sizes: Record<string, number>) => ({ stat: (p: string) => { if (p in sizes) return { size: sizes[p] }; throw new Error('ENOENT') } })

describe('databaseDisk', () => {
  test('reads the directory of the file; free is what an unprivileged writer gets, the db counts its wal and shm', () => {
    const disk = databaseDisk('/srv/bc/main.db', { ...volume(20 * GB, 100 * GB), ...files({ '/srv/bc/main.db': 5 * MB, '/srv/bc/main.db-wal': 3 * MB, '/srv/bc/main.db-shm': MB }) })
    expect(disk).toEqual({ path: '/srv/bc', freeBytes: 20 * GB, totalBytes: 100 * GB, dbBytes: 9 * MB })
  })

  test('a missing wal is not an error', () => {
    expect(dbFamilyBytes('/x/a.db', files({ '/x/a.db': 7 }).stat)).toBe(7)
  })

  test('null for no path, :memory:, and a filesystem that will not answer', () => {
    expect(databaseDisk('')).toBeNull()
    expect(databaseDisk(':memory:')).toBeNull()
    expect(databaseDisk('/x/a.db', { statfs: () => { throw new Error('EIO') } })).toBeNull()
  })
})

describe('headroomShort', () => {
  const disk = (freeBytes: number, totalBytes: number, dbBytes: number) => ({ path: '/srv/bc', freeBytes, totalBytes, dbBytes })

  test('under twice the database is short, and names the path', () => {
    expect(headroomShort(disk(1.5 * GB, 100 * GB, GB))).toContain('/srv/bc')
  })
  test('under a tenth of the volume is short, however small the database', () => {
    expect(headroomShort(disk(5 * GB, 100 * GB, MB))).toContain('under 10%')
  })
  test('enough of both is null', () => {
    expect(headroomShort(disk(50 * GB, 100 * GB, GB))).toBeNull()
  })
})
