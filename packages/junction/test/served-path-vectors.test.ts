// test/served-path-vectors.test.ts — junction's copy of *is this file inside the
// root*, graded against the cases sierra's copy is graded against (`FJS-D653`).
//
// The two copies cannot share code — junction may not import sierra
// (Invariant 1), and toolbelt cannot hold `realpath` — and each found the same
// hole alone. What they share instead is `fixtures/served-path-vectors.json`.
// A case either copy gets wrong is added THERE, so the other is asked it too.
//
// `serveStatic` is called with the raw path: a `Request` normalizes `..` and
// `%2e%2e` away before any server sees them, which would make every walk case
// pass without reaching the code it is about.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { serveStatic } from '../src/transport/static.ts'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

interface Case { url: string, verdict: 'serves' | 'missing' | 'malformed' | 'refused', body?: string, allowOutside?: string[], why: string }

const vectors = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'served-path-vectors.json'), 'utf8')) as {
  root: string, files: Record<string, string>, links: Record<string, string>, cases: Case[]
}

let base: string

beforeAll(() => {
  // realpath: a tmpdir behind a symlink (macOS) makes every root a link.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'fjs-served-path-')))
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

const STATUS = { serves: [200], missing: [404], malformed: [400], refused: [400, 403, 404] }

describe('served-path vectors', () => {
  for (const c of vectors.cases) {
    const label = `${c.url}${c.allowOutside ? ` (allowOutside: ${c.allowOutside})` : ''} → ${c.verdict}`
    it(label, async () => {
      const res = await serveStatic(new Request('http://x/'), c.url, {
        root:         join(base, vectors.root),
        allowOutside: (c.allowOutside ?? []).map(d => join(base, d)),
      } as never)
      // null is the router's 404: the static layer declined and nothing else
      // claims the path.
      const status = res?.status ?? 404
      const body   = res ? await res.text() : ''

      expect(STATUS[c.verdict], c.why).toContain(status)
      if (c.verdict === 'serves') expect(body, c.why).toBe(vectors.files[c.body!])
      else for (const bytes of Object.values(vectors.files)) expect(body, c.why).not.toContain(bytes)
    })
  }
})
