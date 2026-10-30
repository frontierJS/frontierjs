/**
 * test/doc-prelude.mjs — what a README example over `leads` runs under.
 *
 * A real Litestone client over `fixtures/doc-examples.lite`, served by a real
 * Junction app on an ephemeral port, with Sierra's page client pointed at it
 * and the schema registered as the build would. A stand-in client would agree
 * with whatever the page says, and the page is what is under test. Bun only:
 * Litestone imports `bun:sqlite`, which is why the doc examples are not in the
 * vitest suite (`test:safety` is the same split).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '../../litestone/src/index.js'
import { createApp, createStubAuth } from '../../junction/index.ts'
import { buildService } from '../../junction/src/core/service.ts'
import { generateSchemas } from '../src/build/schema-plugin.js'
import { registerSchemas, initJunction, createResource } from '../src/resource/index.js'

const SCHEMA = fileURLToPath(new URL('./fixtures/doc-examples.lite', import.meta.url))

const SERVICES = [
  ['leads', 'Lead'], ['accounts', 'Account'], ['tags', 'Tag'], ['children', 'Child'], ['people', 'Person'],
]

export async function boot() {
  const db   = await createClient({ schema: readFileSync(SCHEMA, 'utf8'), db: ':memory:' })
  const app  = createApp({ db, config: { port: 0 }, auth: createStubAuth({ users: [] }) })
  for (const [name, model] of SERVICES) app.services.register(buildService({ name, model }))
  await app.start()

  const schemas = await generateSchemas(SCHEMA, msg => { throw new Error(msg) })
  registerSchemas(schemas.defs, schemas.models, schemas.updatePatch, schemas.readPatch)
  initJunction({ url: `http://localhost:${app.http.port}` })

  return {
    createResource,
    leads: createResource('leads'),
    userLevel: 4,
    stop: () => app.stop(),
  }
}
