// FJS-3456: a drive that starts its own API must move that API's sinks to the
// test tier. Left alone the API binds the dev defaults (8111 mail, 8112 psp,
// 8114 stripe) and exits on "port already answering" whenever a dev API or
// another lane's drive holds them, so the drive's readiness poll never answers.
import { test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIRS = ['web/test', 'site/test', 'extension/test']

// A call that starts the app: `start('bun', ['run', 'api/index.ts'], …)` or a
// `spawn('bun', ['run', 'api/index.ts'], …)`. A comment naming the file is not one.
const STARTS_API = /\b(start|spawn)\(\s*'bun',\s*\['run', 'api\/index\.ts'\]/

const drives = DIRS.flatMap(dir =>
  readdirSync(join(ROOT, dir))
    .filter(name => name.endsWith('.mjs'))
    .map(name => join(dir, name)))
  .filter(file => STARTS_API.test(readFileSync(join(ROOT, file), 'utf8')))

test('the drives that start the API are found', () => {
  expect(drives.length).toBeGreaterThan(10)
})

for (const file of drives) {
  test(`${file} hands its API the test-tier sink ports`, () => {
    expect(readFileSync(join(ROOT, file), 'utf8')).toContain('...TEST_SINK_ENV')
  })
}
