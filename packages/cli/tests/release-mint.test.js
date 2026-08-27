// ─── release-mint.test.js — what a Release IS ────────────────────────────────
//
// Phase 1b of IDEAS/release-transitions.md. The property the whole design rests
// on is that a Release id is a pure function of its terms: the same tree and the
// same bindings mint the same id anywhere, which is what makes *build once,
// promote a digest* a sentence you can say rather than a hope.
//
// So the tests are mostly about what DOES and DOES NOT move the id.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir }                             from 'os'
import { join }                               from 'path'

import { bindingSet, schemaSurfaceHash, mintRelease, formatRelease,
         BindingError, RELEASE_FORMAT }       from '../core/release.js'

const base = (over = {}) => ({
  app: 'shop', environment: 'production',
  bindingsHash: 'bh', schemaHash: 'sh', pivot: 'expand', ...over,
})

describe('the id is the terms and nothing else', () => {
  test('the same terms mint the same id', () => {
    expect(mintRelease(base()).id).toBe(mintRelease(base()).id)
  })

  // One artefact promotes from staging to production unchanged and only its
  // bindings differ (invariant 1), so the environment is on the row and never
  // in the hash. If this ever flips, promotion becomes a rebuild.
  test('the environment does NOT move it', () => {
    expect(mintRelease(base({ environment: 'stage' })).id)
      .toBe(mintRelease(base({ environment: 'production' })).id)
  })

  test('who minted it and when do not move it', () => {
    expect(mintRelease(base({ createdBy: 'sam' })).id)
      .toBe(mintRelease(base({ createdBy: 'alex' })).id)
  })

  test.each([
    ['the bytes',        { digest: 'sha256:aaa' }],
    ['the bindings',     { bindingsHash: 'other' }],
    ['the data boundary',{ schemaHash: 'other' }],
    ['the verdict',      { pivot: 'contract' }],
  ])('%s moves it', (_label, over) => {
    expect(mintRelease(base(over)).id).not.toBe(mintRelease(base()).id)
  })

  // The format is in the id, so a change to what a term MEANS mints a different
  // Release for one tree — which is correct: two ids computed by different rules
  // are not the same claim.
  test('the format version is carried on the row', () => {
    expect(mintRelease(base()).formatVersion).toBe(RELEASE_FORMAT)
  })

  test('a Release with no app is refused by name', () => {
    expect(() => mintRelease(base({ app: null }))).toThrow(/app id/)
  })
})

describe('bindings', () => {
  test('per-target beats app-wide, and both are in the hash', () => {
    const wide = bindingSet({ bindings: { LOG: 'info' } }, 'production')
    const over = bindingSet({ bindings: { LOG: 'info' }, production: { bindings: { LOG: 'warn' } } }, 'production')

    expect(over.values.LOG).toBe('warn')
    expect(over.hash).not.toBe(wide.hash)
  })

  // An app that binds nothing has a binding set. It is a set, and it hashes.
  test('an empty set is a set', () => {
    const a = bindingSet({}, 'dev')
    expect(a.count).toBe(0)
    expect(a.hash).toBe(bindingSet(undefined, 'dev').hash)
  })

  // Everything in a binding set reaches a process as text, so the canonical
  // form coerces — otherwise `PORT: 3000` and `PORT: '3000'` are two Releases
  // describing one deployment.
  test('key order and value type do not move the hash', () => {
    expect(bindingSet({ bindings: { A: '1', B: 2 } }, 'dev').hash)
      .toBe(bindingSet({ bindings: { B: '2', A: 1 } }, 'dev').hash)
  })

  test('a value and a secret reference are different terms', () => {
    expect(bindingSet({ bindings: { K: 'v' } }, 'dev').hash)
      .not.toBe(bindingSet({ secrets: { K: 'v' } }, 'dev').hash)
  })

  // A secret is resolved when a process starts, so `latest` means two instances
  // of one immutable Release hold two different values.
  test.each(['name@latest', 'name:latest', 'LATEST'])('an unpinned reference (%s) is refused by name', (ref) => {
    let err = null
    try { bindingSet({ secrets: { K: ref } }, 'dev') } catch (e) { err = e }
    expect(err).toBeInstanceOf(BindingError)
    expect(err.key).toBe('K')
    expect(err.message).toMatch(/pinned/)
  })

  test('a pinned reference is accepted', () => {
    expect(bindingSet({ secrets: { K: 'shop-db-key@3' } }, 'dev').secretRefs.K).toBe('shop-db-key@3')
  })

  // The split exists to keep secret VALUES out of a Release. A long opaque
  // string in the reference slot is the mistake it exists to make visible.
  test('a value in the reference slot is refused', () => {
    expect(() => bindingSet({ secrets: { K: 'x'.repeat(300) } }, 'dev')).toThrow(/VALUE, not a reference/)
  })
})

describe('the schema term', () => {
  test('is the committed release surface, hashed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fli-surface-'))
    try {
      writeFileSync(join(dir, 'release.snapshot.md'), '# Release surface\n')
      const a = schemaSurfaceHash(dir)
      expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(a.source).toContain('release.snapshot.md')

      writeFileSync(join(dir, 'release.snapshot.md'), '# Release surface\nmoved\n')
      expect(schemaSurfaceHash(dir).hash).not.toBe(a.hash)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // An app may legitimately have no schema, so this is reported and not thrown
  // — but a Release with no data boundary in its id is a weaker claim, and the
  // caller has to be able to say so.
  test('a missing surface is reported, not thrown', () => {
    const r = schemaSurfaceHash(mkdtempSync(join(tmpdir(), 'fli-nosurface-')))
    expect(r.hash).toBeNull()
    expect(r.missing).toContain('release.snapshot.md')
  })
})

describe('what it says', () => {
  // A tag is not an identity — two hosts at one commit hold two images with the
  // same name — so an absent digest says so rather than showing the tag.
  test('an unbuilt Release says so instead of showing a tag', () => {
    const out = formatRelease(mintRelease(base({ imageRef: 'shop:abc1234' })))
    expect(out).toContain('not built')
    expect(out).toContain('a name, not an identity')
  })

  test('a contract says the pivot out loud', () => {
    expect(formatRelease(mintRelease(base({ pivot: 'contract' })))).toContain('only forward')
  })
})
