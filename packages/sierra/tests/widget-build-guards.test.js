/**
 * tests/widget-build-guards.test.js — what the build refuses, and what it
 * leaves behind.
 *
 * Three failures that all end on somebody else's page rather than here:
 *
 *   • a widget whose computed tag has no dash. `assertTag` catches it — in the
 *     RUNTIME, at module scope, on the customer's site. The name and the prefix
 *     are both known to the build, so it is decidable before the first Vite
 *     call and the error belongs to the author.
 *   • a build that FAILS after Vite has already written that widget's chunk, so
 *     `dist/embeds` holds a broken script beside three good ones and the next
 *     `COPY dist/embeds` ships it.
 *   • a widget deleted from `src/Embeds/` that keeps shipping forever, because
 *     `emptyOutDir: false` is necessary (N builds, one directory) and nothing
 *     compensates for it.
 *
 * `viteBuild` is injected by design — `buildWidgets` takes it as a parameter so
 * this module is testable without spawning a build — and a recorder is the
 * right tool for the first claim in particular: the assertion is that the
 * refusal happens BEFORE any build is started, which a real Vite cannot state.
 * The real build is covered by `bun run test:widgets`, which builds this
 * package's fixture with Vite and drives it in Chrome.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildWidgets } from '../src/build/widget-build.js'
import { tmpDir } from './tmp.js'

let root
const embeds = () => join(root, 'src/Embeds')
const out    = () => join(root, 'dist/embeds')

/** A recorder standing in for Vite: what was asked for, and nothing built. */
const recorder = () => {
  const calls = []
  const fn = async (config) => { calls.push(config) }
  fn.calls = calls
  return fn
}

const widget = (name, body = '<script module>\n  export const widget = {}\n</script>\n') => {
  mkdirSync(embeds(), { recursive: true })
  writeFileSync(join(embeds(), `${name}.mesa`), body)
}

beforeEach(() => { root = tmpDir('widget-guards-') })

describe('a tag a browser will not register', () => {
  test('a one-word widget under the default prefix fails the BUILD', async () => {
    widget('Solo')
    const viteBuild = recorder()
    await expect(buildWidgets({ root, viteBuild, prefix: '' })).rejects.toThrow(/<solo>/)
    // Before the first build, not after three of them.
    expect(viteBuild.calls).toEqual([])
  })

  test('the same widget under a prefix builds', async () => {
    // The negative control, and it is the test: a rule that refused `Solo`
    // outright would satisfy the assertion above and be wrong. The refusal is
    // about the DASH, which is what the prefix supplies.
    widget('Solo')
    const viteBuild = recorder()
    const built = await buildWidgets({ root, viteBuild, prefix: 'mt-' })
    expect(built.map(b => b.name)).toEqual(['Solo'])
    expect(viteBuild.calls).toHaveLength(1)
  })

  test('a two-word widget needs no prefix', async () => {
    widget('LeadForm')
    const built = await buildWidgets({ root, viteBuild: recorder(), prefix: '' })
    expect(built.map(b => b.name)).toEqual(['LeadForm'])
  })

  test('a widget that names its own tag is left to the runtime', async () => {
    // The build cannot evaluate `<script module>`, so a widget declaring a legal
    // tag there would be failed on a tag it does not use. The runtime's own
    // assertTag still guards the value it actually gets.
    widget('Solo', '<script module>\n  export const widget = { tag: \'my-solo\' }\n</script>\n')
    const built = await buildWidgets({ root, viteBuild: recorder(), prefix: '' })
    expect(built.map(b => b.name)).toEqual(['Solo'])
  })
})

describe('what a failed build leaves on disk', () => {
  test('the chunk Vite wrote before failing is removed', async () => {
    widget('Counter')
    mkdirSync(out(), { recursive: true })
    const viteBuild = async () => {
      // Vite's own order: the chunk is written, then something after it throws.
      writeFileSync(join(out(), 'Counter.js'), 'broken')
      throw new Error('unresolvable import')
    }
    await expect(buildWidgets({ root, viteBuild, prefix: 'mt-' })).rejects.toThrow('unresolvable import')
    // An absent file is loud. A stale one is a page that half works.
    expect(existsSync(join(out(), 'Counter.js'))).toBe(false)
  })

  test('a widget that built earlier in the same run is untouched', async () => {
    // Only the failing widget's output is withdrawn — the run threw, and
    // deleting the widgets that did build would make a partial failure
    // indistinguishable from a total one.
    widget('Aaa'); widget('Zzz')
    mkdirSync(out(), { recursive: true })
    const viteBuild = async (cfg) => {
      const name = cfg.build.lib.fileName()
      writeFileSync(join(out(), name), 'built')
      if (name === 'Zzz.js') throw new Error('boom')
    }
    await expect(buildWidgets({ root, viteBuild, prefix: 'mt-' })).rejects.toThrow('boom')
    expect(readFileSync(join(out(), 'Aaa.js'), 'utf8')).toBe('built')
    expect(existsSync(join(out(), 'Zzz.js'))).toBe(false)
  })
})

describe('what the origin still serves', () => {
  test('a script no widget claims is named', async () => {
    widget('Counter')
    mkdirSync(out(), { recursive: true })
    writeFileSync(join(out(), 'Ghost.js'), 'a widget deleted from src/Embeds')
    const lines = []
    await buildWidgets({ root, viteBuild: recorder(), prefix: 'mt-', log: m => lines.push(m) })
    expect(lines.join('\n')).toMatch(/Ghost\.js/)
    // Reported, not deleted: a host page has that URL pasted into it, and this
    // build cannot know whether anybody still loads it.
    expect(existsSync(join(out(), 'Ghost.js'))).toBe(true)
  })

  test('a directory holding only the widgets built says nothing', async () => {
    widget('Counter')
    mkdirSync(out(), { recursive: true })
    writeFileSync(join(out(), 'Counter.js'), 'built')
    const lines = []
    await buildWidgets({ root, viteBuild: recorder(), prefix: 'mt-', log: m => lines.push(m) })
    expect(lines.filter(l => l.includes('built by no widget'))).toEqual([])
  })
})
