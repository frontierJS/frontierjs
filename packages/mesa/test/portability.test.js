/**
 * The portability report's counting (`scripts/portability.js`), over a fixed
 * set of files rather than the corpus, so a tally is checked against an
 * answer worked out by hand. The corpus figures move with every commit; these
 * do not, and a double count or a child that is not followed fails here.
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler.js'
import { resolveMesa, callsOf, follow, lowering, plan } from '../scripts/portability.js'

const PACKAGES = new Set(['ui', 'email-kit'])

const file = (name, shapes = [], calls = []) => ({
  file: name,
  offenses: shapes.map((shape) => ({ what: shape, shape, loc: `${name}:1:1` })),
  calls: calls.map((c) => ({ name: c, loc: `${name}:1:1`, imported: c !== 'Auto', file: c === 'Auto' ? null : c })),
})

//  App   calls Card and Icon; passes on its own
//  Card  calls Icon; refused for X
//  Icon  refused for Y
//  Tree  calls itself; passes
//  Ring1 and Ring2 call each other; pass
//  Page  calls a component with no import; passes otherwise
//  Lone  refused for X and Y
//  Ok    passes
const FILES = [
  file('App',   [],         ['Card', 'Icon']),
  file('Card',  ['X'],      ['Icon']),
  file('Icon',  ['Y']),
  file('Tree',  [],         ['Tree']),
  file('Ring1', [],         ['Ring2']),
  file('Ring2', [],         ['Ring1']),
  file('Page',  [],         ['Auto']),
  file('Lone',  ['X', 'Y']),
  file('Ok'),
]

describe('portability counting', () => {
  it('makes a call it cannot follow an offense of the caller', () => {
    const page = follow(FILES).find((f) => f.file === 'Page')
    expect(page.offenses.map((o) => [o.what, o.shape])).toEqual([['<Auto>', 'component with no import']])
    expect(page.calls).toEqual([])
    const outside = follow([file('A', [], ['Gone'])])[0]
    expect(outside.offenses.map((o) => o.shape)).toEqual(['component outside the corpus'])
  })

  it('lowers a file only when every component it calls lowers, cycles included', () => {
    const files = follow(FILES)
    expect([...lowering(files)].sort()).toEqual(['Ok', 'Ring1', 'Ring2', 'Tree'])
    // Y lowers Icon; Card still needs X, so App stays held by Card.
    expect([...lowering(files, new Set(['Y']))].sort()).toEqual(['Icon', 'Ok', 'Ring1', 'Ring2', 'Tree'])
    expect([...lowering(files, new Set(['X', 'Y']))].sort()).toEqual(['App', 'Card', 'Icon', 'Lone', 'Ok', 'Ring1', 'Ring2', 'Tree'])
  })

  it('counts what a shape alone unlocks, and orders greedily by the running total', () => {
    const { rows, order } = plan(follow(FILES))
    expect(rows.map((r) => [r.shape, r.files, r.unlocks, r.uses])).toEqual([
      ['Y', 2, 1, 2],
      ['X', 2, 0, 2],
      ['component with no import', 1, 1, 1],
    ])
    // Y first (+1, Icon) beats the no-import tie on files; then X unlocks
    // Card, App and Lone together, each counted once.
    expect(order).toEqual([
      { shape: 'Y', gain: 1, lower: 5 },
      { shape: 'X', gain: 3, lower: 8 },
      { shape: 'component with no import', gain: 1, lower: 9 },
    ])
  })

  it('resolves a relative path, a workspace package and the app alias', () => {
    expect(resolveMesa('example/web/src/routes/index.mesa', '../lib/Card.mesa', PACKAGES)).toBe('example/web/src/lib/Card.mesa')
    expect(resolveMesa('example/web/src/a.mesa', '@frontierjs/ui/components/forms/Button.mesa', PACKAGES))
      .toBe('packages/ui/components/forms/Button.mesa')
    expect(resolveMesa('example/web/src/routes/x/index.mesa', '@/resources/Order.mesa', PACKAGES)).toBe('example/web/src/resources/Order.mesa')
    expect(resolveMesa('a/b.mesa', '@frontierjs/site-kit/X.mesa', PACKAGES)).toBe(null)
  })

  it('reads the calls off a real compile, inside slots and blocks', async () => {
    const source = `<script>
  import Card from './Card.mesa'
  import Button from '@frontierjs/ui/components/forms/Button.mesa'
  let on = true
</script>
<Card>{#if on}<Button />{/if}<Auto /></Card>
`
    const { ir } = await compile(source, { filename: 'web/src/P.mesa', dev: false, warning: () => {} })
    expect(callsOf('web/src/P.mesa', source, ir, PACKAGES)).toEqual([
      { name: 'Card',   loc: 'web/src/P.mesa:6:1',  imported: true,  file: 'web/src/Card.mesa' },
      { name: 'Button', loc: 'web/src/P.mesa:6:15', imported: true,  file: 'packages/ui/components/forms/Button.mesa' },
      { name: 'Auto',   loc: 'web/src/P.mesa:6:30', imported: false, file: null },
    ])
  })
})
