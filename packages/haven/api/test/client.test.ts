// api/test/client.test.ts
// GET /haven/client names the package this server runs, read from its own
// manifest (`FJS-D982`). `fli haven` installs what it says before anyone is
// signed in, so it answers without a session.

import { test, expect, afterEach } from 'bun:test'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../src/app.ts'
import { CLIENT_PATH } from '../src/client.ts'

const SCHEMA   = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const MANIFEST = await Bun.file(join(import.meta.dir, '..', '..', 'package.json')).json()

let env: any

afterEach(async () => { await env?.close?.() })

test('the server states the package and version it runs, to a caller with no session', async () => {
  env = await createTestEnv({
    schema: SCHEMA,
    listen: true,
    api:    ({ db }: { db: any }) => buildHavenApp({ db, sessionKey: 'k', port: 0 }),
  })
  const res = await fetch(`http://localhost:${env.port}${CLIENT_PATH}`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ package: MANIFEST.name, version: MANIFEST.version })
})
