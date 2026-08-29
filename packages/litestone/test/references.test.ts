// The reference catalogue is `.lite` rather than prose for one reason: a
// reference that cannot parse is a reference that is wrong, and this is the only
// format where that is checkable. So a parser rule that moves takes the
// catalogue with it, instead of leaving a folder of plausible stale examples.
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

    it(`${file} declares a model named for the file`, () => {
      const { schema } = parse(src)
      const names = (schema?.models ?? []).map((m: any) => m.name)
      expect(names.length).toBeGreaterThan(0)
      // Invariant 19's habit, applied to the catalogue: the file IS the noun.
      // A file may declare more than one model where the second exists only to
      // serve the first (Tag + TagAttachment); the first is the file's name.
      expect(names[0]).toBe(file.replace(/\.lite$/, ''))
    })

    it(`${file} is listed in the README`, () => {
      // The list is the point of the folder, so a file nobody indexed is the
      // silent failure here — it exists, it parses, and nobody looking at the
      // catalogue can see it.
      expect(README).toContain(`\`${file.replace(/\.lite$/, '')}\``)
    })
  }
})
