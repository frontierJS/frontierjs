// web/src/session.js reaches the API through the Junction client and nowhere else (FJS-2351).
// A hand fetch carries its own copy of the bearer header, origin and error
// envelope, and the next change to how a call is authenticated leaves it behind.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../web/src/session.js', import.meta.url), 'utf8')
  .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')

test('session.js makes no global fetch and builds no bearer header', () => {
  expect(src).not.toMatch(/(^|[^.\w])fetch\(/)
  expect(src).not.toMatch(/Bearer/)
})

test('the workspace list is the workspaces service, not a raw GET', () => {
  expect(src).not.toMatch(/['"`]\/workspaces['"`]/)
  expect(src).toMatch(/service\('workspaces'\)\.findData\(/)
})
