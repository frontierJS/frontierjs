// The reference catalog is `.lite` rather than prose for one reason: a
// reference that cannot parse is a reference that is wrong, and this is the only
// format where that is checkable. So a parser rule that moves takes the
// catalog with it, instead of leaving a folder of plausible stale examples.
//
// Two traps a reference file falls into, both measured before this was written:
//
//   1. A `@relation` to a model the file does not declare is TWO errors —
//      `unknown type 'User'` and `@relation references unknown model 'User'`.
//      So a reference carries the foreign key COLUMN and never the relation;
//      which model it points at is the installing app's answer.
//   2. A file with only prose in it parses clean and declares nothing, which
//      looks identical to a working reference from the outside.
import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { parse } from '../src/core/parser.js'

const DIR   = join(import.meta.dir, '..', 'references')
const FILES = readdirSync(DIR).filter(f => f.endsWith('.lite')).sort()
const README = readFileSync(join(DIR, 'README.md'), 'utf8')

describe('reference models', () => {
  it('there are some', () => {
    // Guards the whole suite going vacuous if the folder is moved or emptied.
    expect(FILES.length).toBeGreaterThan(0)
  })

  for (const file of FILES) {
    const src = readFileSync(join(DIR, file), 'utf8')

    it(`${file} parses`, () => {
      const { errors } = parse(src)
      const messages = (errors ?? []).map((e: any) => e.message ?? String(e))
      expect(messages).toEqual([])
    })

    it(`${file} raises no warnings`, () => {
      // Separate from the parse so a warning names itself rather than being
      // folded into "it did not parse". A reference is the one place a footgun
      // warning must not be tolerated — it is what somebody is about to copy.
      const { warnings } = parse(src)
      const messages = (warnings ?? []).map((w: any) => w.message ?? String(w))
      expect(messages).toEqual([])
    })

    it(`${file} declares a model or trait named for the file`, () => {
      const { schema } = parse(src)
      const models = (schema?.models ?? []).map((m: any) => m.name)
      const traits = (schema?.traits ?? []).map((t: any) => t.name)
      const noun = file.replace(/\.lite$/, '')
      // Invariant 19's habit, applied to the catalog: the file IS the noun.
      // A file may declare more than one model where the second exists only to
      // serve the first (Organization + Member); the first is the file's name.
      // A SHAPE that never stands alone (Grant, Interval) is a trait, which the
      // parser keeps on `schema.traits` after splicing — so the noun is found
      // there, and a trait-only file is not mistaken for one that declares
      // nothing.
      expect(models[0] ?? traits[0]).toBe(noun)
    })

    it(`${file} is listed in the README`, () => {
      // The list is the point of the folder, so a file nobody indexed is the
      // silent failure here — it exists, it parses, and nobody looking at the
      // catalog can see it.
      expect(README).toContain(`\`${file.replace(/\.lite$/, '')}\``)
    })
  }
})

// ─── A trait is imported ─────────────────────────────────────────────────────
//
// The catalog's own rule: a model is copied, a trait is imported. The first app
// to try `@@trait(Grant)` got *unknown trait*, because the folder was neither
// exported nor read by anything (FJS-2176). A host schema under test/fixtures
// installs it the way the README says, and a gated caller mints a row through
// its own create policy with the digest named in `system:` — the shape the
// trait exists for.

import { parseFile }    from '../src/core/parser.js'
import { createClient } from '../src/index.js'

describe('Grant is installed by import, and minted by the caller', () => {
  const host = join(import.meta.dir, 'fixtures', 'references', 'grant-host.lite')

  it('@@trait(Grant) resolves through the package export', () => {
    const { schema, errors } = parseFile(host)
    expect((errors ?? []).map((e: any) => e.message ?? String(e))).toEqual([])
    const link = schema.models.find((m: any) => m.name === 'PortalLink')
    expect(link.fields.map((f: any) => f.name)).toEqual(
      expect.arrayContaining(['tokenHash', 'expiresAt', 'revokedAt', 'lastUsedAt']))
    // The host's gate is the one in force — the trait states none.
    expect(link.attributes.filter((a: any) => a.kind === 'gate')).toHaveLength(1)
  })

  it('a caller the create policy admits writes the @guarded digest by naming it', async () => {
    const db: any = await createClient({ schema: host, db: ':memory:', claims: ['customerId'] })
    await db.asSystem().customer.create({ data: { id: 1, name: 'Acme' } })
    await db.asSystem().customer.create({ data: { id: 2, name: 'Other' } })

    const me = db.$setAuth({ id: 7, role: 'member', customerId: 1 })
    // Without the name the column is locked, which is the FJS-1749 trap.
    await expect(me.portalLink.create({ data: { customerId: 1, tokenHash: 'd1' } }))
      .rejects.toThrow(/"tokenHash" is @guarded/)
    const row = await me.portalLink.create({ data: { customerId: 1, tokenHash: 'd1' }, system: ['tokenHash'] })
    expect(row.customerId).toBe(1)
    // The read half stays locked.
    expect('tokenHash' in row).toBe(false)
    // The policy still grades the write: somebody else's customer is refused.
    await expect(me.portalLink.create({ data: { customerId: 2, tokenHash: 'd2' }, system: ['tokenHash'] }))
      .rejects.toThrow()
    expect(await db.asSystem().portalLink.count()).toBe(1)
  })
})
