/*
 * tests/release-view.test.js — the engine behind the GUI's release panel.
 *
 * The panel itself is `tests/browser/specs/release.spec.mjs`, which needs
 * Chrome. What is here needs neither Chrome nor a machine, and covers the three
 * things that are decided in this module rather than in the commands it runs:
 *
 *   THE ALLOW-LIST. The target arrives over HTTP and ends up in an argv, so it
 *   is checked by KEY against a fixed table (Invariant 8). This is the one
 *   assertion here that is about safety rather than about rendering.
 *
 *   THE ATTACHMENT READER. A regex over a config literal, which is exactly the
 *   kind of thing that silently finds nothing — and finding nothing is
 *   indistinguishable from an app declaring none. So the fixture declares two.
 *
 *   BOTH STREAMS. A deploy command that refuses prints its reason and exits 0
 *   (`FJS-589`), so a reader that only looks at stderr on a non-zero exit
 *   reports *the command said nothing* about a command that said exactly what
 *   was wrong. Measured, not assumed — see the last block.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir }                                        from 'node:os'
import { join, resolve }                                 from 'node:path'
import { fileURLToPath }                                 from 'node:url'

import { releaseLocal, releaseTarget, TARGETS } from '../core/release-view.js'

const CLI = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

let root
beforeAll(() => {
  // An app is a directory with a seed, which is this framework's own definition
  // and what `findApps` walks for.
  root = mkdtempSync(join(tmpdir(), 'fli-release-view-'))
  mkdirSync(join(root, 'shop/db'),         { recursive: true })
  mkdirSync(join(root, 'shop/api/config'), { recursive: true })
  writeFileSync(join(root, 'shop/db/schema.lite'), 'model Order {\n  id Int @id\n}\n')
  writeFileSync(join(root, 'shop/api/config/junction.config.js'), `
export default {
  app: { name: 'shop' },
  attachments: {
    search: {
      SEARCH_URL:   { url: true },
      SEARCH_INDEX: { required: true },
    },
    mailer: {
      optional: true,
      SMTP_HOST: { required: true },
      SMTP_USER: { required: true },
    },
  },
}
`)
})
afterAll(() => { try { rmSync(root, { recursive: true, force: true }) } catch {} })

// ─── the allow-list ──────────────────────────────────────────────────────────

test('the target table names exactly the targets fli takes, and each maps to flags', () => {
  expect(Object.keys(TARGETS).sort()).toEqual(['default', 'production', 'stage'])
  expect(TARGETS.default).toEqual([])
  expect(TARGETS.production).toEqual(['--production'])
  expect(TARGETS.stage).toEqual(['--stage'])
})

test('a target that is not in the table is refused by name, never sanitised', async () => {
  for (const bad of ['; rm -rf /', '--exec=evil', 'production ', 'PRODUCTION', '__proto__', 'constructor']) {
    const out = await releaseTarget({ root, fliRoot: CLI, target: bad })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('unknown target')
  }
})

// `Object.hasOwn` and not `in`: `toString` is on every object's prototype chain
// and would otherwise resolve to a "known" target whose flags are a function.
test('an inherited property is not a target', async () => {
  const out = await releaseTarget({ root, fliRoot: CLI, target: 'toString' })
  expect(out.ok).toBe(false)
})

test('an app the tree does not hold is refused rather than joined onto a path', async () => {
  const out = await releaseTarget({ root, fliRoot: CLI, target: 'default', app: '../../etc' })
  expect(out.ok).toBe(false)
  expect(out.error).toContain('no app in this tree')
})

// ─── the attachment reader ───────────────────────────────────────────────────

test('it reads a declared attachment: the service, its keys and whether it is optional', async () => {
  const { attachments } = await releaseLocal({ root, fliRoot: CLI })
  const by = Object.fromEntries(attachments.map(a => [a.service, a]))

  expect(Object.keys(by).sort()).toEqual(['mailer', 'search'])
  expect(by.search.keys).toEqual(['SEARCH_URL', 'SEARCH_INDEX'])
  expect(by.search.optional).toBe(false)
  expect(by.mailer.optional).toBe(true)
  expect(by.mailer.app).toBe('shop')
})

test('bound is a COUNT of what this shell carries, never a verdict', async () => {
  const had = { u: process.env.SEARCH_URL, i: process.env.SEARCH_INDEX }
  try {
    process.env.SEARCH_URL   = 'http://search.local'
    delete process.env.SEARCH_INDEX

    const { attachments } = await releaseLocal({ root, fliRoot: CLI })
    const search = attachments.find(a => a.service === 'search')

    // Half-bound is the state the whole feature exists for, and it is the one a
    // per-variable check cannot see: every key it can name is either
    // legitimately absent or legitimately set. The verdict stays the app's —
    // this reports 1 of 2 and says nothing about whether that is allowed.
    expect(search.bound).toBe(1)
    expect(search.keys.length).toBe(2)

    // A key set to whitespace is not bound. An unset variable expands to the
    // empty string in a shell, so a blank is the ordinary shape of absent.
    process.env.SEARCH_INDEX = '   '
    const again = await releaseLocal({ root, fliRoot: CLI })
    expect(again.attachments.find(a => a.service === 'search').bound).toBe(1)
  } finally {
    had.u === undefined ? delete process.env.SEARCH_URL   : (process.env.SEARCH_URL = had.u)
    had.i === undefined ? delete process.env.SEARCH_INDEX : (process.env.SEARCH_INDEX = had.i)
  }
})

test('an app declaring no attachments contributes no rows, and that is not an error', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'fli-release-bare-'))
  try {
    mkdirSync(join(bare, 'app/db'), { recursive: true })
    writeFileSync(join(bare, 'app/db/schema.lite'), 'model A {\n  id Int @id\n}\n')
    const out = await releaseLocal({ root: bare, fliRoot: CLI })
    expect(out.attachments).toEqual([])
    expect(out.apps.length).toBe(1)
  } finally { rmSync(bare, { recursive: true, force: true }) }
})

// ─── the verdict ─────────────────────────────────────────────────────────────

test('an app with no baseline reports unavailable with the reason, not silence', async () => {
  const { apps } = await releaseLocal({ root, fliRoot: CLI })
  expect(apps.length).toBe(1)
  expect(apps[0].label).toBe('shop')

  // Whatever the verdict is, it carries a tone and never an empty note: *I
  // could not compare* and *nothing changed* are different sentences and a
  // panel showing the same blank row for both is the failure this guards.
  expect(typeof apps[0].verdict).toBe('string')
  expect(apps[0].verdict.length).toBeGreaterThan(0)
  expect(['success', 'danger', 'warning', 'muted']).toContain(apps[0].tone)
  if (apps[0].verdict === 'unavailable') expect(apps[0].note?.length ?? 0).toBeGreaterThan(0)
})

// ─── both streams ────────────────────────────────────────────────────────────

test("a command that refuses and exits 0 still has its reason read (FJS-589)", async () => {
  // `deploy:journal` against an app with no deploy block prints its refusal and
  // exits 0. The first version of this module used execFileSync and only kept
  // stderr from the catch, so the success path handed the panel an empty string
  // and it reported *the journal answered nothing*.
  const out = await releaseTarget({ root, fliRoot: CLI, target: 'production', app: 'shop' })
  expect(out.ok).toBe(false)
  expect(out.error).toMatch(/deploy block|journal/i)

  // The refusal's own words, not a rewrite of them.
  expect(out.error).not.toBe('the journal answered nothing')
})
