// schema-gaps.js — does the database a client opened hold the tables its schema declares?
//
// Nothing at start compares the two, and a migration is a file (`FJS-D123`), so
// an app pointed at the wrong file answers health 200 and the first read of a
// model with no table is the first anyone hears (`FJS-1796`). A second app
// sharing the file under another schema is the same failure: a same-named table
// carrying the other model's columns.
//
// The question is presence only — a declared table, a declared column — because
// that is what a wrong file looks like and what a read or write breaks on at
// once. An index, a CHECK or a changed type is `migrate check`'s, and a column
// the schema no longer declares breaks nothing until a migration drops it.

import { openDatabase } from './engine.js'
import { buildPristine, buildPristineForDatabase, introspect } from './migrate.js'
import { modelToTableName } from './ddl.js'

const META_KEYS = new Set(['__views', '__triggers', '__fts', '__search', '__sql'])

/**
 * @param {{ schema: any }} parseResult
 * @param {Record<string, any>} dbRegistry
 * @param {{ pluralize?: boolean }} [opts]
 * @returns {{ db: string, model: string, table: string, missing: 'table' | string[] }[]}
 */
export function schemaGaps(parseResult, dbRegistry, { pluralize = false } = {}) {
  const sqliteNames = parseResult.schema.databases
    .filter(d => !d.driver || d.driver === 'sqlite')
    .map(d => d.name)
  const names = sqliteNames.length ? sqliteNames : ['main']
  if (!names.includes('main') && dbRegistry.main) names.push('main')

  const modelOf = new Map(parseResult.schema.models.map(m => [modelToTableName(m, pluralize), m.name]))
  const gaps = []

  for (const name of names) {
    const conn   = dbRegistry[name]
    const handle = conn?.rawWriteDb ?? conn?.rawReadDb
    if (!handle) continue

    const pristineDb = openDatabase(':memory:')
    try {
      const pristine = sqliteNames.length > 1
        ? buildPristineForDatabase(pristineDb, parseResult, name)
        : buildPristine(pristineDb, parseResult)
      const live = introspect(handle)

      for (const table of Object.keys(pristine)) {
        if (META_KEYS.has(table)) continue
        const model = modelOf.get(table) ?? table
        if (!live[table]) { gaps.push({ db: name, model, table, missing: 'table' }); continue }
        const have    = new Set(live[table].columns.map(c => c.name))
        const missing = pristine[table].columns.map(c => c.name).filter(c => !have.has(c))
        if (missing.length) gaps.push({ db: name, model, table, missing })
      }
    } finally {
      pristineDb.close()
    }
  }
  return gaps
}
