// src/domain/host/db-disk.ts — free space on the disk the hub database lives on.
//
// A full disk refuses every SQLite write, and the hub backup stages its copy
// on that same disk (`backupDir`), so the backup is the thing most likely to
// fill it. Two callers ask the same question -- the `hub.disk-free` posture
// control and the backup job's refusal before it stages anything -- and the
// threshold lives here once, so the screen and the job cannot disagree
// (`FJS-3908`).
//
// Pure of the app: `databaseDisk` takes a path and, in a test, the two fs calls,
// so no case needs a full disk.

import { statfsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/** Free space must cover this many copies of the database: a backup stages one, and a compaction another. */
export const HEADROOM_DB_MULTIPLE = 2
/** Below this share of the volume free, writes are one burst of growth from refused. */
export const MIN_FREE_FRACTION    = 0.1

export interface DatabaseDisk { path: string; freeBytes: number; totalBytes: number; dbBytes: number }

export interface DiskDeps {
  statfs?: (path: string) => { bavail: number; bsize: number; blocks: number }
  stat?:   (path: string) => { size: number }
}

/** Bytes of a SQLite file and its `-wal` and `-shm` -- the WAL is part of what a copy must hold. */
export function dbFamilyBytes(dbPath: string, stat: NonNullable<DiskDeps['stat']> = statSync): number {
  let n = 0
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { n += stat(p).size } catch { /* absent: no WAL until the first write */ }
  }
  return n
}

/**
 * The disk holding `dbPath`. Free is what an unprivileged writer gets
 * (`bavail`), not what root could (`bfree`). Null when there is no file to
 * ask about (`:memory:`) or the filesystem will not answer, which a grader
 * reads as unknown, never as healthy.
 */
export function databaseDisk(dbPath: string, deps: DiskDeps = {}): DatabaseDisk | null {
  if (!dbPath || dbPath === ':memory:') return null
  const path = dirname(dbPath)
  try {
    const s = (deps.statfs ?? statfsSync)(path)
    return {
      path,
      freeBytes:  s.bavail * s.bsize,
      totalBytes: s.blocks * s.bsize,
      dbBytes:    dbFamilyBytes(dbPath, deps.stat),
    }
  } catch { return null }
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1)
const mb = (bytes: number) => (bytes / 1024 ** 2).toFixed(1)

/** A sentence saying why there is too little room, or null when there is enough. */
export function headroomShort(disk: DatabaseDisk): string | null {
  const need = HEADROOM_DB_MULTIPLE * disk.dbBytes
  if (disk.freeBytes < need)
    return `${gb(disk.freeBytes)} GB free on ${disk.path}, under ${HEADROOM_DB_MULTIPLE}x the databases' ${mb(disk.dbBytes)} MB`
  if (disk.totalBytes > 0 && disk.freeBytes < MIN_FREE_FRACTION * disk.totalBytes)
    return `${gb(disk.freeBytes)} GB free on ${disk.path} is under ${MIN_FREE_FRACTION * 100}% of its ${gb(disk.totalBytes)} GB`
  return null
}
