// api/test/flags.test.ts
// The bucketing rule, and it is a CONTRACT rather than an implementation.
//
// `rollout` was stored and applied by nothing (`FJS-124`), so a flag at 10%
// behaved as on-or-off. What closes that is an agreement: the server and every
// SDK have to land on the same answer for the same user, in whatever language
// the SDK is written in, or the percentage names a different tenth in each.
//
// So the canonical MurmurHash3 vectors are asserted first. They are what makes
// "use a stock murmur3" a sufficient instruction — an implementation that
// passes them and follows `<flagKey>:<unitId>` mod 100 agrees with this one by
// construction, and one that does not is caught here rather than by a user
// getting a feature in staging and losing it in production.
//
// The three properties below it are the ones a rollout is USED for, and none of
// them follows from the hash being correct:
//
//   • even spread — a rollout at 10 reaches about a tenth
//   • independence — two flags at 10% do not pick the same tenth
//   • monotonicity — raising 10 to 20 never takes the feature off anyone
//
// No app, no database: these are pure functions and a fixture would only slow
// the one test that has to run everywhere an SDK is ported.

import { test, expect, describe } from 'bun:test'
import { murmur3, bucketFor, variantFor, decideFor, resolveIn }
  from '../src/services/flags/flags.service.ts'

describe('murmur3 — the canonical x86 32-bit vectors, seed 0', () => {
  // Wrong here and every SDK disagrees with the server, silently and for one
  // user at a time. Published values, not values read back off this code.
  const VECTORS: [string, number][] = [
    ['',                                            0x00000000],
    ['a',                                           0x3c2569b2],
    ['abc',                                         0xb3dd93fa],
    ['abcd',                                        0x43ed676a],
    ['Hello, world!',                               0xc0363e43],
    ['The quick brown fox jumps over the lazy dog', 0x2e4ff723],
  ]

  for (const [text, want] of VECTORS) {
    test(`murmur3(${JSON.stringify(text)})`, () => {
      expect(murmur3(text)).toBe(want)
    })
  }

  test('the input is bytes, not code units', () => {
    // An SDK in another language hashes the encoded bytes. A JS implementation
    // walking `charCodeAt & 0xff` agrees with it on ASCII and diverges
    // everywhere else — a bug nobody finds until an id has an accent in it.
    //
    // U+0100 is the discriminator: two UTF-8 bytes (C4 80), and one masked byte
    // of 0x00 under the broken reading — which is what a NUL hashes to. Equal
    // here means the encoder was skipped.
    expect(murmur3('\u0100')).not.toBe(murmur3('\u0000'))
    expect(new TextEncoder().encode('\u0100')).toHaveLength(2)
  })
})

describe('bucketFor', () => {
  const IDS = Array.from({ length: 20_000 }, (_, i) => `user-${i}`)

  test('is 0–99 and deterministic', () => {
    for (const id of IDS.slice(0, 500)) {
      const b = bucketFor('checkout-v2', id)
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThan(100)
      expect(bucketFor('checkout-v2', id)).toBe(b)
    }
  })

  test('spreads evenly — a rollout at 10 reaches about a tenth', () => {
    const inRollout = IDS.filter(id => bucketFor('checkout-v2', id) < 10).length
    // ±20% of the expectation. Loose on purpose: this is a smoke test for a
    // catastrophically skewed hash, not a statistical claim.
    expect(inRollout).toBeGreaterThan(IDS.length * 0.08)
    expect(inRollout).toBeLessThan(IDS.length * 0.12)
  })

  test('two flags at 10% do not pick the same tenth', () => {
    // The flag key is in the hash for exactly this. Hashing the unit alone
    // gives every flag one cohort, so a staged rollout tests the same unlucky
    // group over and over and the rest of the population is never exercised.
    const a = new Set(IDS.filter(id => bucketFor('flag-a', id) < 10))
    const b = new Set(IDS.filter(id => bucketFor('flag-b', id) < 10))
    const overlap = [...a].filter(id => b.has(id)).length

    // Independent ⇒ about 1% of the population is in both.
    expect(overlap).toBeLessThan(IDS.length * 0.02)
    // …and NOT zero, which would mean they were correlated the other way.
    expect(overlap).toBeGreaterThan(IDS.length * 0.004)
  })

  test('raising the percentage only ever adds units', () => {
    // The property that makes a staged rollout safe: nobody has the feature
    // taken away at 20% who had it at 10%. It holds because the bucket is a
    // property of the unit and the threshold is what moves.
    const at10 = IDS.filter(id => bucketFor('grow', id) < 10)
    const at20 = new Set(IDS.filter(id => bucketFor('grow', id) < 20))
    expect(at10.every(id => at20.has(id))).toBe(true)
    expect(at20.size).toBeGreaterThan(at10.length)
  })

  test('the same unit lands in the same bucket everywhere', () => {
    // No environment in the hash, deliberately: the cohort tested in staging is
    // the cohort that gets it in production.
    expect(bucketFor('checkout-v2', 'u-1')).toBe(bucketFor('checkout-v2', 'u-1'))
  })
})

describe('decideFor', () => {
  const off  = { isEnabled: false, rollout: 100, variantKey: null, source: 'default' as const }
  const full = { isEnabled: true,  rollout: 100, variantKey: null, source: 'default' as const }
  const none = { isEnabled: true,  rollout: 0,   variantKey: null, source: 'default' as const }

  test('the switch wins over the percentage', () => {
    // isEnabled: false at 100% is off. A rollout is how far a feature has got,
    // not whether it is on.
    expect(decideFor(off, 'f', 'u-1', 'boolean', null).on).toBe(false)
    expect(decideFor(off, 'f', 'u-1', 'boolean', null).inRollout).toBe(true)
  })

  test('100 is everyone and 0 is nobody', () => {
    for (const id of ['u-1', 'u-2', 'u-3', 'u-99']) {
      expect(decideFor(full, 'f', id, 'boolean', null).on).toBe(true)
      expect(decideFor(none, 'f', id, 'boolean', null).on).toBe(false)
    }
  })

  test('reports the bucket, which is what makes a percentage explicable', () => {
    const d = decideFor(full, 'checkout-v2', 'u-1', 'boolean', null)
    expect(d.bucket).toBe(bucketFor('checkout-v2', 'u-1'))
    expect(d.unitId).toBe('u-1')
  })

  test('isEnabled is kept beside `on` — they answer different questions', () => {
    const d = decideFor(none, 'f', 'u-1', 'boolean', null)
    expect(d.isEnabled).toBe(true)    // what somebody set
    expect(d.on).toBe(false)          // what this unit gets
  })
})

describe('variantFor', () => {
  const VARIANTS = [
    { key: 'control', weight: 50 },
    { key: 'blue',    weight: 30 },
    { key: 'green',   weight: 20 },
  ]

  test('splits by weight', () => {
    const ids    = Array.from({ length: 20_000 }, (_, i) => `u-${i}`)
    const counts: Record<string, number> = { control: 0, blue: 0, green: 0 }
    for (const id of ids) counts[variantFor('ab', id, VARIANTS)!]!++

    expect(counts.control! / ids.length).toBeGreaterThan(0.45)
    expect(counts.control! / ids.length).toBeLessThan(0.55)
    expect(counts.blue!    / ids.length).toBeGreaterThan(0.25)
    expect(counts.green!   / ids.length).toBeLessThan(0.25)
  })

  test('is independent of the rollout bucket', () => {
    // Salted apart. Sharing one bucket would put everyone at the front of the
    // rollout into the first variant, so the first cohort to see a feature
    // would never see the other arms of the experiment it is testing.
    const ids   = Array.from({ length: 20_000 }, (_, i) => `u-${i}`)
    const early = ids.filter(id => bucketFor('ab', id) < 10)
    const control = early.filter(id => variantFor('ab', id, VARIANTS) === 'control').length
    expect(control / early.length).toBeGreaterThan(0.4)
    expect(control / early.length).toBeLessThan(0.6)
  })

  test('a pinned variant beats the split', () => {
    const pinned = { isEnabled: true, rollout: 100, variantKey: 'green', source: 'override' as const }
    expect(decideFor(pinned, 'ab', 'u-1', 'variant', VARIANTS).variantKey).toBe('green')
  })

  test('no variant for a unit the rollout excludes', () => {
    const d = decideFor({ isEnabled: true, rollout: 0, variantKey: null, source: 'default' as const },
                        'ab', 'u-1', 'variant', VARIANTS)
    expect(d.on).toBe(false)
    expect(d.variantKey).toBe(null)
  })

  test('an empty list answers null rather than throwing', () => {
    expect(variantFor('ab', 'u-1', [])).toBe(null)
  })
})

describe('the default rollout is 100, and that is the half that makes it usable', () => {
  test('a flag carrying only the column default is on for everyone once enabled', () => {
    // `isEnabled` is the switch and `rollout` narrows it, so the pair a new
    // flag starts with has to mean "off, and when you turn it on, everyone".
    // At @default(0) enabling a flag did nothing for anybody the moment an SDK
    // started bucketing, with the screen showing it on — a percentage feature
    // whose default percentage is nobody.
    const fresh = { isEnabled: true, rollout: 100 }   // the schema's own defaults, enabled
    for (const id of ['u-1', 'u-2', 'u-3'])
      expect(decideFor(resolveIn(fresh, null), 'f', id, 'boolean', null).on).toBe(true)
  })

  test('rolling out to nobody is `isEnabled: false`, which already says it', () => {
    const off = { isEnabled: false, rollout: 100 }
    expect(decideFor(resolveIn(off, null), 'f', 'u-1', 'boolean', null).on).toBe(false)
  })

  test('a stated 0 is still a real 0 — the fallback only fires on an absent column', () => {
    // `??` on a present zero would read as absent, which is Invariant 9's shape.
    expect(resolveIn({ isEnabled: true, rollout: 0 }, null).rollout).toBe(0)
    expect(resolveIn({ isEnabled: true }, null).rollout).toBe(100)
  })
})

describe('resolveIn is untouched by any of this', () => {
  test('an override still wins outright', () => {
    const flag = { isEnabled: true, rollout: 100 }
    const over = { isEnabled: false, rollout: 25, variantKey: null }
    expect(resolveIn(flag, over)).toEqual({
      isEnabled: false, rollout: 25, variantKey: null, source: 'override',
    })
  })
})
