// FJS-112 (P6): buildCoFkMap is one pass over the belongsTo columns, not every model against every model.
import { test, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { buildRelationMap, buildCoFkMap } from '../src/core/schema-maps.js'

// The all-pairs walk this replaced, kept as the oracle: same map, same key order.
function reference(schema: any, relationMap: any) {
  const map: any = {}
  for (const parentModel of schema.models) {
    const parentBT: any = {}
    for (const rel of Object.values(relationMap[parentModel.name] ?? {}) as any[]) {
      if (rel.kind !== 'belongsTo') continue
      parentBT[rel.foreignKeys.join(',')] = { target: rel.targetModel, references: rel.referencedKeys.join(',') }
    }
    if (!Object.keys(parentBT).length) continue
    for (const childModel of schema.models) {
      if (childModel.name === parentModel.name) continue
      const overlaps: string[] = []
      for (const rel of Object.values(relationMap[childModel.name] ?? {}) as any[]) {
        if (rel.kind !== 'belongsTo') continue
        const p = parentBT[rel.foreignKeys.join(',')]
        if (!p || p.target !== rel.targetModel || p.references !== rel.referencedKeys.join(',')) continue
        overlaps.push(...rel.foreignKeys)
      }
      if (overlaps.length) (map[parentModel.name] ??= {})[childModel.name] = overlaps
    }
  }
  return map
}

const src = `
model Org { id Int @id }
model Region { id Int @id }
model Project { id Int @id
  orgId Int
  org Org @relation(fields: [orgId], references: [id]) }
model Task { id Int @id
  orgId Int
  org Org @relation(fields: [orgId], references: [id])
  regionId Int
  region Region @relation(fields: [regionId], references: [id]) }
model Note { id Int @id
  regionId Int
  region Region @relation(fields: [regionId], references: [id])
  orgId Int
  org Org @relation(fields: [orgId], references: [id]) }
model Lone { id Int @id }
`

test('buildCoFkMap names the models that share a parent column, in schema order', () => {
  const schema = parse(src).schema
  const rels = buildRelationMap(schema)
  const got = buildCoFkMap(schema, rels)
  expect(got).toEqual(reference(schema, rels))
  expect(got.Project).toEqual({ Task: ['orgId'], Note: ['orgId'] })
  expect(Object.keys(got.Task)).toEqual(['Project', 'Note'])
  expect(Object.keys(got)).toEqual(Object.keys(reference(schema, rels)))
  expect(got.Lone).toBeUndefined()
})

test('buildCoFkMap agrees with the all-pairs walk on a wide schema', () => {
  let wide = 'model Parent { id Int @id }\nmodel Other { id Int @id }\n'
  for (let i = 0; i < 120; i++) {
    wide += `model M${i} { id Int @id
  pId Int
  p Parent @relation(fields: [pId], references: [id])
  ${i % 3 ? 'oId Int\n  o Other @relation(fields: [oId], references: [id])' : ''} }\n`
  }
  const schema = parse(wide).schema
  const rels = buildRelationMap(schema)
  const got = buildCoFkMap(schema, rels)
  expect(JSON.stringify(got)).toBe(JSON.stringify(reference(schema, rels)))
})
