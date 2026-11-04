// api/src/domain/backup/check-archive.ts — an archive graded on the laptop, before any box is touched.
//
// `fli basecamp:restore` and `fli basecamp:reinstall` run it by path from the
// Basecamp checkout, against HEAD's migrations, because `/setup` grades the
// same archive only once the old box is gone (`IDEAS/basecamp-reinstall.md` 0.2):
//
//   bun api/src/domain/backup/check-archive.ts '{"dir":"<archive dir>","keyFile":"<key file>","migrationsRoot":"<db/migrations>"}'
//
// `dir` is an unpacked `basecamp-<stamp>/` holding `manifest.json`. The key
// travels as a file, never in argv another process can read. It grades a
// scratch copy: `archiveRefusals` gives a database with no tracking table one,
// and that write to the backup itself would fail its own sha256 next time.
//
// The last line of stdout is one JSON object, which is fli's whole contract:
//   { ok: true, takenAt, installId }   restorable onto this code with this key
//   { refused: ['<why>', ...] }       one sentence per reason
//   { error: '<what>' }               and the exit is non-zero

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir }     from 'node:os'
import { join }       from 'node:path'
import { archiveRefusals, MANIFEST_FILE } from './archive-manifest.ts'
import { DEV_ENCRYPTION_KEY } from '../../core/env.ts'

const answer = (o: Record<string, unknown>) => console.log(JSON.stringify(o))

let scratch = ''
try {
  const { dir, keyFile, migrationsRoot } = JSON.parse(process.argv[2] ?? '{}') as Record<string, string | undefined>
  for (const [name, path] of Object.entries({ dir, keyFile, migrationsRoot }))
    if (!path || !existsSync(path)) throw new Error(`${name} ${path ? `${path} does not exist` : 'is required'}`)

  const key = readFileSync(keyFile!, 'utf8').trim()
  const keyFingerprint = key === DEV_ENCRYPTION_KEY ? null : createHash('sha256').update(key).digest('hex')

  scratch = mkdtempSync(join(tmpdir(), 'basecamp-archive-check-'))
  cpSync(dir!, scratch, { recursive: true })
  const reasons = await archiveRefusals(scratch, { migrationsRoot: migrationsRoot!, keyFingerprint })
  if (reasons.length) answer({ refused: reasons })
  else {
    const manifest = JSON.parse(readFileSync(join(scratch, MANIFEST_FILE), 'utf8'))
    answer({ ok: true, takenAt: manifest.takenAt, installId: manifest.installId ?? null })
  }
} catch (err) {
  answer({ error: (err as Error).message })
  process.exitCode = 1
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
}
