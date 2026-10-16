// resolveAllRowCounts counts each table once. getTableStats also summed every
// table's COUNT(*) to price a row, so a percent or size limit over T tables
// ran T² counts (FJS-620 M11).

import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { parseLimit, resolveAllRowCounts, resolveRowCount } from '../src/transform/framework.js'

const TABLES = 12

function fixture() {
  const db = new Database(':memory:')
  for (let i = 0; i < TABLES; i++) {
    db.run(`CREATE TABLE "t${i}" (id INTEGER PRIMARY KEY, v TEXT)`)
    for (let r = 0; r < 10 * (i + 1); r++) db.run(`INSERT INTO "t${i}" (v) VALUES ('x')`)
  }
  const counts: string[] = []
  const query = db.query.bind(db)
  ;(db as any).query = (sql: string) => {
    counts.push(sql)
    return query(sql)
  }
  return { db, counts, names: Array.from({ length: TABLES }, (_, i) => `t${i}`) }
}

const countsIn = (sqls: string[]) => sqls.reduce((n, s) => n + s.split('COUNT(*)').length - 1, 0)

describe('a transform limit counts each table once', () => {
  test('a percent limit counts each table once', () => {
    const { db, counts, names } = fixture()
    const got = resolveAllRowCounts(db, names, parseLimit('50%'))
    expect(got.t0).toBe(5)
    expect(got.t11).toBe(60)
    expect(countsIn(counts)).toBeLessThanOrEqual(TABLES)
  })

  test('a size limit counts each table once', () => {
    const { db, counts, names } = fixture()
    const got = resolveAllRowCounts(db, names, parseLimit('1mb'))
    expect(Object.keys(got)).toHaveLength(TABLES)
    expect(countsIn(counts)).toBeLessThanOrEqual(TABLES)
  })

  test('a percent limit on one table counts that table alone', () => {
    const { db, counts } = fixture()
    expect(resolveRowCount(db, 't3', parseLimit('50%'))).toBe(20)
    expect(countsIn(counts)).toBe(1)
  })

  test('a size limit on one table still prices a row by the whole file', () => {
    const { db } = fixture()
    const n = resolveRowCount(db, 't3', parseLimit('1kb'))
    expect(n).toBeGreaterThanOrEqual(1)
    expect(n).toBeLessThanOrEqual(40)
  })
})
