/**
 * test/stale.test.ts — `@stale(on: [...])`, the stored aggregate that says when
 * it is stale (`FJS-D1301` C, `FJS-D2307` A, `FJS-3023`).
 *
 * A gradebook category's grade is a rollup the app's job computes. The schema
 * cannot say the arithmetic, so it says the dependency: every write to a
 * listed source marks the live aggregate row that reads it, in the same
 * statement, by trigger — a raw UPDATE included. The job clears the mark by
 * inserting the successor row with the flag false.
 *
 * The tree is moodle's shape (`fjs-prototypes/moodle/db/schema.lite`): every
 * category has its own GradeItem, and the category grade is a Grade per user
 * on that item.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../src/index.js'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'litestone-stale-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const SOURCES = [
  'gradeItem.aggregatesCategory.items.grades(where: userId == this.userId)',
  'gradeItem.aggregatesCategory.items',
  'gradeItem.aggregatesCategory',
  'gradeItem.aggregatesCategory.children.ownItem.grades(where: userId == this.userId)',
].join(', ')

const MODELS = (stale = `stale Boolean @default(false) @system @stale(on: [${SOURCES}])`) => `
  model GradeCategory {
    id         Int              @id @default(autoincrement())
    parentId   Int?
    parent     GradeCategory?   @relation("GradeTree", fields: [parentId], references: [id])
    children   GradeCategory[]  @relation("GradeTree")
    dropLowest Int              @default(0)
    items      GradeItem[]      @relation("CategoryItems")
    ownItem    GradeItem?       @relation("CategoryItem")
  }
  model GradeItem {
    id                   Int            @id @default(autoincrement())
    categoryId           Int?
    category             GradeCategory? @relation("CategoryItems", fields: [categoryId], references: [id])
    aggregatesCategoryId Int?           @unique
    aggregatesCategory   GradeCategory? @relation("CategoryItem", fields: [aggregatesCategoryId], references: [id])
    weight               Int            @default(1)
    grades               Grade[]
  }
  model Grade {
    id           Int       @id @default(autoincrement())
    gradeItemId  Int
    gradeItem    GradeItem @relation(fields: [gradeItemId], references: [id])
    userId       Int
    score        Int?
    computedAt   DateTime  @default(now())
    supersededAt DateTime?
    ${stale}
    @@effective(from: computedAt, to: supersededAt)
  }
`

async function tree() {
  const dir = tmp()
  const db  = await createClient({ schema: `database main { path "${join(dir, 'app.db')}" }\n${MODELS()}` })
  const sys = db.asSystem()
  const root  = await sys.gradeCategory.create({ data: {} })
  const unit  = await sys.gradeCategory.create({ data: { parentId: root.id } })
  const rootItem = await sys.gradeItem.create({ data: { aggregatesCategoryId: root.id } })
  const unitItem = await sys.gradeItem.create({ data: { aggregatesCategoryId: unit.id, categoryId: root.id } })
  const quiz  = await sys.gradeItem.create({ data: { categoryId: unit.id } })
  const essay = await sys.gradeItem.create({ data: { categoryId: unit.id } })
  // Leaf to root, as the job writes them: the unit's aggregate first, so its
  // insert does not mark the root's.
  const unit7 = await sys.grade.create({ data: { gradeItemId: unitItem.id, userId: 7, score: 80 } })
  const unit8 = await sys.grade.create({ data: { gradeItemId: unitItem.id, userId: 8, score: 60 } })
  const root7 = await sys.grade.create({ data: { gradeItemId: rootItem.id, userId: 7, score: 80 } })
  return { db, sys, root, unit, rootItem, unitItem, quiz, essay, unit7, unit8, root7 }
}

const staleIds = async (sys: any) =>
  (await sys.grade.findMany({ where: { stale: true, supersededAt: null }, orderBy: { id: 'asc' } })).map((g: any) => g.id)

describe('@stale — a write to a source marks the live aggregate that reads it', () => {
  test('fresh aggregates read as not stale', async () => {
    const t = await tree()
    expect(await staleIds(t.sys)).toEqual([])
  })

  test("a child grade marks that user's category grade and nobody else's", async () => {
    const t = await tree()
    await t.sys.grade.create({ data: { gradeItemId: t.quiz.id, userId: 7, score: 9 } })
    expect(await staleIds(t.sys)).toEqual([t.unit7.id])
  })

  test("the job's successor clears the mark and climbs one level", async () => {
    const t = await tree()
    await t.sys.grade.create({ data: { gradeItemId: t.quiz.id, userId: 7, score: 9 } })
    const next = await t.sys.grade.create({ data: { gradeItemId: t.unitItem.id, userId: 7, score: 90 } })
    await t.sys.grade.update({ where: { id: t.unit7.id }, data: { supersededAt: new Date() } })
    expect(next.stale).toBe(false)
    expect(await staleIds(t.sys)).toEqual([t.root7.id])
  })

  test("a sibling's weight edit marks every user's category grade", async () => {
    const t = await tree()
    await t.sys.gradeItem.update({ where: { id: t.essay.id }, data: { weight: 3 } })
    expect(await staleIds(t.sys)).toEqual([t.unit7.id, t.unit8.id])
  })

  test("a category setting edit marks that category's grades", async () => {
    const t = await tree()
    await t.sys.gradeCategory.update({ where: { id: t.unit.id }, data: { dropLowest: 1 } })
    expect(await staleIds(t.sys)).toEqual([t.unit7.id, t.unit8.id])
  })

  test('a delete marks — a cascade leaves no newer child to compare against', async () => {
    const t = await tree()
    const g = await t.sys.grade.create({ data: { gradeItemId: t.quiz.id, userId: 8, score: 4 } })
    await t.sys.grade.create({ data: { gradeItemId: t.unitItem.id, userId: 8, score: 61 } })
    await t.sys.grade.update({ where: { id: t.unit8.id }, data: { supersededAt: new Date() } })
    const live8 = (await t.sys.grade.findFirst({ where: { gradeItemId: t.unitItem.id, userId: 8, supersededAt: null } })).id
    await t.sys.grade.delete({ where: { id: g.id } })
    expect(await staleIds(t.sys)).toContain(live8)
  })

  test('a move between parents marks both', async () => {
    const t = await tree()
    const other = await t.sys.gradeCategory.create({ data: { parentId: t.root.id } })
    const otherItem = await t.sys.gradeItem.create({ data: { aggregatesCategoryId: other.id, categoryId: t.root.id } })
    const other7 = await t.sys.grade.create({ data: { gradeItemId: otherItem.id, userId: 7, score: 50 } })
    await t.sys.grade.update({ where: { id: t.root7.id }, data: { stale: false } })
    await t.sys.gradeItem.update({ where: { id: t.quiz.id }, data: { categoryId: other.id } })
    expect(await staleIds(t.sys)).toEqual([t.unit7.id, t.unit8.id, other7.id])
  })
})

describe('@stale — refused by name', () => {
  const refuses = (stale: string, msg: RegExp) => {
    const r = parse(MODELS(stale))
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toMatch(msg)
  }

  test('on a column that is not a Boolean', () =>
    refuses(`stale Int @default(0) @system @stale(on: [gradeItem])`, /@stale.*Boolean/))

  test('without @system — a caller could clear the mark the job owns', () =>
    refuses(`stale Boolean @default(false) @stale(on: [gradeItem])`, /@stale.*@system/))

  test('a path segment that is not a relation', () =>
    refuses(`stale Boolean @default(false) @system @stale(on: [gradeItem.weight])`, /'weight' is not a relation on GradeItem/))

  test("a where: naming a column the source does not have", () =>
    refuses(`stale Boolean @default(false) @system @stale(on: [gradeItem(where: userId == this.userId)])`, /userId/))

  test('the DDL names each source table in a trigger trio', () => {
    const r = parse(MODELS())
    expect(r.valid).toBe(true)
    const ddl = generateDDL(r.schema)
    for (const v of ['insert', 'update', 'delete'])
      expect(ddl).toContain(`AFTER ${v.toUpperCase()}`)
    expect(ddl.match(/CREATE TRIGGER "[^"]+_stale_insert"/g)?.length).toBe(4)
  })
})
