/**
 * The app behind test/palette-source.test.js — junction's `searchService` over a
 * real litestone client, spawned as a bun subprocess because junction is
 * Bun-only and sierra's vitest runs under node.
 *
 * Four `@@fts` models, three mounted. `ProductVariant` and `Person` are there
 * for their names: the group and the default link both come from inflecting
 * them, and a one-word regular model cannot tell `productVariants` from
 * `productvariants`, or `people` from `persons` (`FJS-2841`).
 *
 *   bun test/fixtures/palette-source-server.ts <port>
 */

import { createClient }  from '../../../litestone/src/index.js'
import { createApp }     from '../../../junction/src/core/app.ts'
import { searchService } from '../../../junction/src/plugins/search/index.ts'

const port = Number(process.argv[2] ?? 7928)

const SCHEMA = `
model User {
  id String @id
  @@auth
}

model Issue {
  id    String @id
  title String
  key   String @unique
  @@fts([title])
  @@label(title)
}

model ProductVariant {
  id   Int    @id
  name String
  @@fts([name])
  @@label(name)
}

model Person {
  id   Int    @id
  name String
  @@fts([name])
  @@label(name)
}

model Secret {
  id   String @id
  name String
  @@fts([name])
  @@label(name)
}
`

const TOKEN = 'ana-token'

const db  = await createClient({ db: ':memory:', schema: SCHEMA }) as any
const sys = db.asSystem()
await sys.user.create({ data: { id: 'ana' } })
await sys.issue.create({ data: { id: 'i/1', title: 'quasar lattice', key: 'ENG-1' } })
await sys.productVariant.create({ data: { id: 7, name: 'quasar blue' } })
await sys.person.create({ data: { id: 3, name: 'quasar keeper' } })
await sys.secret.create({ data: { id: 's1', name: 'quasar launch codes' } })

const app = createApp({
  db,
  config: { port },
  auth: {
    verifySession: async (token: string) => token === TOKEN
      ? { userId: 'ana', userType: 'user', authMethod: 'session', verifiedAt: 'x', activatedAt: 'x' }
      : null,
  },
  logLevel: 'silent',
} as any)
app.services.register(searchService({ models: ['issue', 'productVariant', 'person'] }))
app.get('/ping', (ctx: any) => ctx.json({ ok: true }))
await app.start()

console.log(`READY ${port}`)
