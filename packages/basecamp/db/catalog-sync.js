// db/catalog-sync.js — add to a live catalog what `db/blueprints.js` has gained
// (`bun run db:catalog-sync`).
//
// The catalog is written once, by `db:seed`, and a hub whose database predates
// a blueprint never shows it: `db:seed` rebuilds the whole database and a dev
// or live hub holds fleet rows no seed recreates. This creates each slug the
// database lacks, blueprint-then-params as the service makes a caller do, and
// touches no row that exists — a param changed in code is not carried over.
// Run twice, it changes nothing.

import { createBasecampDb } from '../api/src/core/db.ts'
import { BLUEPRINTS }       from './blueprints.js'

const db  = await createBasecampDb()
const sys = db.asSystem()

const have = new Set((await sys.blueprint.findMany({ select: { slug: true } })).map(b => b.slug))
let added = 0

for (const bp of BLUEPRINTS) {
  if (have.has(bp.slug)) continue
  const { params, ...columns } = bp
  const row = await sys.blueprint.create({ data: columns })
  for (const [position, p] of params.entries()) {
    await sys.blueprintParam.create({
      data: {
        blueprintId:  row.id,
        key:          p.key,
        label:        p.label,
        hint:         p.hint ?? null,
        defaultValue: p.defaultValue ?? null,
        required:     p.required === true,
        secret:       p.secret   === true,
        generate:     p.generate ?? null,
        position,
      },
    })
  }
  console.log(`added ${bp.slug} (${params.length} params)`)
  added++
}

console.log(added ? `${added} blueprint(s) added` : 'catalog already holds every blueprint')
process.exit(0)
