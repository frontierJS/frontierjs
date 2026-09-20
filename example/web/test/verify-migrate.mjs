/**
 * web/test/verify-migrate.mjs — the files a deploy replays, replayed.
 *
 * **bun, no server.** Nothing here goes through a client: the question is what
 * a container gets when it runs `migrate apply` against an empty disk, and a
 * running app would answer it with `autoMigrate` instead.
 *
 * ─── What this drive is FOR ───────────────────────────────────────────────
 *
 * `FJS-1154`. The app boots with `autoMigrate`, which diffs the LIVE database
 * and writes whatever is missing — so development never reads the migration
 * files at all, and the committed history drifted a whole feature behind the
 * schema without one thing going red. It stayed that way across an auth
 * fragment, two orion imports and a column rename, and what found it was
 * somebody running `migrate check` by hand.
 *
 * A deploy has no such cushion: `deploy:local` replays exactly these files and
 * the container refuses to start rather than serving 500s.
 *
 * ─── The half a differ cannot see ─────────────────────────────────────────
 *
 * `DateTime` and `String` both emit TEXT, so a column that changed from an
 * INSTANT to a DAY (`FJS-D288`) is invisible to `diffSchemas` — it reports
 * nothing, a generated migration carries nothing, and old rows keep
 * `2026-09-14T23:30:00.000Z` in a column every reader now compares against
 * `2026-09-14`. Ten of the fourteen converted columns were in that blind spot.
 *
 * So the second section asks the question the differ cannot: **is every
 * `String @date` column in this schema actually holding a day?** The column
 * list is read OUT OF THE SCHEMA rather than written here, because a list
 * written here would be one more thing to forget on the next conversion — which
 * is the failure this drive exists for, one layer up.
 *
 * ─── Reading it ───────────────────────────────────────────────────────────
 *
 *   `history.buildsTheSchema` — the headline. Anything else red here and a
 *   deploy is broken; this one green is what the issue asked for.
 *
 *   `days.*` — asserted over the SEEDED database, so it grades the seed, the
 *   backfill and every write path the seed exercises at once. `run db:seed`
 *   first or it grades an empty table, which is why the count is asserted too.
 */

import { Database }      from 'bun:sqlite'
import { execFileSync }  from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir }        from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFile }     from '@frontierjs/litestone'
import { results, report } from './lib/report.mjs'

const HERE   = dirname(fileURLToPath(import.meta.url))
const DB_DIR = join(HERE, '..', '..', 'db')
const SCHEMA = join(DB_DIR, 'schema.lite')

const { got, t } = results()
const scratch = mkdtempSync(join(tmpdir(), 'fjs-migrate-'))

try {
  // ─── the history builds the schema ──────────────────────────────────────
  //
  // `SHOP_DB_PATH` is what `database main { path env(…) }` reads, and a
  // declared path WINS over every other way of naming a database — so this is
  // the only way to point the CLI somewhere disposable. Without it the two
  // commands below run against the development shop.
  const at  = { cwd: DB_DIR, env: { ...process.env, SHOP_DB_PATH: join(scratch, 'replay.db') } }
  const cli = (...args) => {
    try   { return { code: 0, out: execFileSync('litestone', args, { ...at, encoding: 'utf8' }) } }
    catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` } }
  }

  const applied = cli('migrate', 'apply')
  t('history.replaysOntoAnEmptyDatabase', applied.code === 0)

  // The assertion. `migrate check` builds a pristine schema from the FILES and
  // diffs it against the `.lite` — so this is *what a deploy produces* against
  // *what this app declares*, with nothing derived from the same source twice.
  const checked = cli('migrate', 'check')
  t('history.buildsTheSchema', checked.code === 0)
  // Printed rather than swallowed: a drift here is a list of tables and columns,
  // and the name of the one that broke is the whole of the fix.
  if (checked.code !== 0) console.log(checked.out)

  // ─── every day column holds a day ───────────────────────────────────────

  const { schema } = parseFile(SCHEMA)
  const table = (model) =>
    model.name.replace(/(?<=[a-z0-9])(?=[A-Z])/g, '_').toLowerCase()

  // `String` + `@date` is the declaration, and it is read here rather than
  // listed: the next column converted joins this drive by being converted.
  const dayColumns = []
  for (const model of schema.models ?? []) {
    for (const field of model.fields ?? []) {
      if (field.type?.name !== 'String') continue
      if (!(field.attributes ?? []).some(a => a.kind === 'date')) continue
      dayColumns.push([table(model), field.name])
    }
  }
  t('days.theSchemaDeclaresSome', dayColumns.length > 0)

  // The seeded shop, read-only. Under `tenancy { strategy database }` every
  // shop is its own file and this is the one `db:seed` writes.
  const shop = new Database(join(DB_DIR, 'shops', 'flagship.db'), { readonly: true })
  const DAY  = /^\d{4}-\d{2}-\d{2}$/

  let scanned = 0
  const wrong = []
  for (const [tbl, col] of dayColumns) {
    let rows
    try { rows = shop.query(`SELECT "${col}" AS v FROM "${tbl}" WHERE "${col}" IS NOT NULL`).all() }
    catch { continue }   // a table this shop has no rows in yet, or none at all
    for (const r of rows) {
      scanned++
      if (!DAY.test(String(r.v))) wrong.push(`${tbl}.${col} = ${JSON.stringify(r.v)}`)
    }
  }
  shop.close()

  // Both, and the count is not decoration: an empty database passes *no value
  // is wrong* without reading anything, which is the shape this whole drive is
  // about.
  t('days.thereAreRowsToGrade', scanned > 0)
  t('days.noneHoldsAnInstant', wrong.length === 0)
  if (wrong.length) console.log(wrong.slice(0, 10).join('\n'))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// ─── Report ───────────────────────────────────────────────────────────────

const expected = {
  'history.replaysOntoAnEmptyDatabase': true,
  'history.buildsTheSchema':            true,
  'days.theSchemaDeclaresSome':         true,
  'days.thereAreRowsToGrade':           true,
  'days.noneHoldsAnInstant':            true,
}

process.exit(report(got, expected))
