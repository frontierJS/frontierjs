// A scratch copy of basecamp's db/ for a Studio drive.
//
// The copy takes the SOURCE (schema, config, migrations) and builds the
// database fresh with `db push`. basecamp.db itself is a gitignored dev file
// that lags the schema -- copying it made the drives grade a table older than
// the schema they were meant to grade (`workspace` had no ingressAccountId).
import { mkdtempSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const R = join(dirname(fileURLToPath(import.meta.url)), '../../..')

export function copyBasecampDb(prefix) {
  const work = mkdtempSync(join(tmpdir(), prefix))
  cpSync(`${R}/packages/basecamp/db`, work, { recursive: true, filter: s => !/\.db(-[a-z]+)?$/.test(s) })
  const r = spawnSync('bun', [`${R}/packages/litestone/src/tools/cli.js`, 'db', 'push'],
    { cwd: work, env: { ...process.env, ENCRYPTION_KEY: 'a'.repeat(64) }, encoding: 'utf8', timeout: 90000 })
  if (r.status !== 0) throw new Error('db push failed in ' + work + '\n' + (r.stdout + r.stderr).slice(-600))
  return work
}
