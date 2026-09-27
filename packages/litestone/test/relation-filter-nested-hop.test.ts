// test/relation-filter-nested-hop.test.ts
//
// A relation filter inside a relation filter resolves against the model it is
// nested in, not the model the query started on (FJS-1314). The tag shape
// `Issue → IssueLabel → Label` could be filtered by the label's id and never by
// anything on the label: `label` was looked up on Issue, found nothing, and
// compiled as a column.

import { describe, test, expect } from 'bun:test'
import { createClient }           from '../src/index.js'

const SCHEMA = `
  model Issue      { id Int @id  title String  labels IssueLabel[] }
  model Label      { id Int @id  name String  issues IssueLabel[] }
  model IssueLabel { id Int @id  issueId Int  labelId Int
                     issue Issue @relation(fields: [issueId], references: [id])
                     label Label @relation(fields: [labelId], references: [id]) }
`

async function db() {
  const c: any = await createClient({ db: ':memory:', schema: SCHEMA })
  const sys = c.asSystem()
  await sys.label.create({ data: { id: 1, name: 'bug' } })
  await sys.label.create({ data: { id: 2, name: 'feature' } })
  for (const id of [1, 2, 3]) await sys.issue.create({ data: { id, title: `i${id}` } })
  await sys.issueLabel.create({ data: { id: 1, issueId: 1, labelId: 1 } })
  await sys.issueLabel.create({ data: { id: 2, issueId: 2, labelId: 2 } })
  await sys.issueLabel.create({ data: { id: 3, issueId: 3, labelId: 1 } })
  await sys.issueLabel.create({ data: { id: 4, issueId: 3, labelId: 2 } })
  return sys
}

const ids = (rows: any[]) => rows.map(r => r.id).sort()

describe('a to-one hop inside some/every/none', () => {
  test('some → is', async () => {
    const sys = await db()
    const rows = await sys.issue.findMany({ where: { labels: { some: { label: { is: { name: 'bug' } } } } } })
    expect(ids(rows)).toEqual([1, 3])
  })

  test('none → isNot and every → is', async () => {
    const sys = await db()
    expect(ids(await sys.issue.findMany({ where: { labels: { none: { label: { is: { name: 'bug' } } } } } }))).toEqual([2])
    expect(ids(await sys.issue.findMany({ where: { labels: { every: { label: { is: { name: 'feature' } } } } } }))).toEqual([2])
    expect(ids(await sys.issue.findMany({ where: { labels: { some: { label: { isNot: { name: 'bug' } } } } } }))).toEqual([2, 3])
  })

  test('two hops back out: label → issues → issue', async () => {
    const sys = await db()
    const rows = await sys.label.findMany({ where: { issues: { some: { issue: { is: { title: 'i2' } } } } } })
    expect(ids(rows)).toEqual([2])
  })

  test('the foreign key inside some still answers', async () => {
    const sys = await db()
    expect(ids(await sys.issue.findMany({ where: { labels: { some: { labelId: 2 } } } }))).toEqual([2, 3])
  })
})
