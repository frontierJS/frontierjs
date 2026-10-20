// api/test/outpost-dev.test.ts — `dev:outpost` speaks the API through the junction client.
//
// A hand `fetch` with its own bearer, X-Workspace-Id and X-Service-Method is a
// second spelling of what `createJunctionClient` owns, and it drifts: the header
// names, the `$limit` syntax and the envelope unwrap each change in one place.
// The behavior itself is driven by `verify:outpost`.

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, '..', 'src', 'providers', 'outpost-dev.ts'), 'utf8')

test('outpost-dev builds no service call by hand', () => {
  expect(src).toContain("from '@frontierjs/junction/client'")
  expect(src).not.toMatch(/x-service-method|x-workspace-id|Bearer |\$limit/i)
})
