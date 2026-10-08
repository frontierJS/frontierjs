/*
 * test/served-path-vectors.test.js — sierra's copy of *is this file inside the
 * root*, graded against the cases junction's copy is graded against
 * (`FJS-D653`), through both origins that call it.
 *
 * The cases are junction's file, read by path: junction found the hole first
 * (`FJS-746`), and it may not read anything of sierra's (Invariant 1). A case
 * either copy gets wrong is added THERE, so the other is asked it too.
 *
 * Requests go out through `node:http` with the path as written. `fetch` parses
 * the URL first, and the parser folds `..` and `%2e%2e` away, so every walk
 * case would pass without reaching `relativePathFor`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { serveSite }    from '../src/site/serve.js'
import { serveWidgets } from '../src/widget/serve.js'

const HERE    = dirname(fileURLToPath(import.meta.url))
const vectors = JSON.parse(readFileSync(join(HERE, '../../junction/test/fixtures/served-path-vectors.json'), 'utf8'))

const STATUS = { serves: [200], missing: [404], malformed: [400], refused: [400, 403, 404] }

let base

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sierra-served-path-')))
  for (const [rel, body] of Object.entries(vectors.files)) {
    mkdirSync(dirname(join(base, rel)), { recursive: true })
    writeFileSync(join(base, rel), body)
  }
  for (const [link, target] of Object.entries(vectors.links)) {
    mkdirSync(dirname(join(base, link)), { recursive: true })
    symlinkSync(join(base, target), join(base, link))
  }
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

function raw(url, path) {
  const { hostname, port } = new URL(url)
  return new Promise((resolve, reject) => {
    request({ hostname, port, path, method: 'GET' }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    }).on('error', reject).end()
  })
}

const ORIGINS = { serveSite, serveWidgets }

for (const [name, serve] of Object.entries(ORIGINS)) {
  describe(`${name} — served-path vectors`, () => {
    for (const c of vectors.cases) {
      const label = `${c.url}${c.allowOutside ? ` (allowOutside: ${c.allowOutside})` : ''} → ${c.verdict}`
      test(label, async () => {
        const server = await serve({
          dir:          join(base, vectors.root),
          allowOutside: (c.allowOutside ?? []).map(d => join(base, d)),
        })
        try {
          const { status, body } = await raw(server.url, c.url)
          expect(STATUS[c.verdict], c.why).toContain(status)
          if (c.verdict === 'serves') expect(body, c.why).toBe(vectors.files[c.body])
          else for (const bytes of Object.values(vectors.files)) expect(body, c.why).not.toContain(bytes)
        } finally {
          await server.close()
        }
      })
    }
  })
}
