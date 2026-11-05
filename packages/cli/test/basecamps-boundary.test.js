// basecamps-boundary.test.js — no laptop command takes a Basecamp from the environment.
//
// A `BASECAMP_URL` / `BASECAMP_API_KEY` in the shell or the global env stands in
// for a name nobody typed, so a stale one sends an admin key to the wrong
// Basecamp, and a machine with two Basecamps cannot say which one a command
// meant. The entry in `basecamps.json`, chosen by `--basecamp`, is the only
// source, and this walks the sources so a new command cannot bring the pair back.
//
// The tutor fixture is the one allowed mention: it BUILDS a box and hands
// `BASECAMP_URL` to that box's Outpost env, which is the Outpost's own variable
// and not a laptop reader of it.

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join, relative, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const ALLOWED = new Set([
  'commands/tutor/_module.md',
  'commands/tutor/_steps-fleet/05-outpost.md',
])

const PAIR = /BASECAMP_(URL|API_KEY)\b/

function* sources(dir, ext) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name)
    if (e.isDirectory()) yield* sources(path, ext)
    else if (e.name.endsWith(ext)) yield path
  }
}

describe('the Basecamp env pair', () => {
  test('no command or core source names BASECAMP_URL or BASECAMP_API_KEY, the tutor fixture aside', () => {
    const files = [...sources(join(ROOT, 'commands'), '.md'), ...sources(join(ROOT, 'core'), '.js')]
    expect(files.length).toBeGreaterThan(50)
    const hits = files
      .map(f => relative(ROOT, f))
      .filter(rel => !ALLOWED.has(rel))
      .filter(rel => PAIR.test(readFileSync(join(ROOT, rel), 'utf8')))
    expect(hits).toEqual([])
  })

  test('Workbench names neither BASECAMP_URL nor BASECAMP_KEY_ID: its Basecamp is an entry, chosen by name', () => {
    const files = [...sources(join(ROOT, '..', 'workbench', 'api', 'src'), '.ts')]
    expect(files.length).toBeGreaterThan(10)
    const hits = files.filter(f => /BASECAMP_(URL|API_KEY|KEY_ID)\b/.test(readFileSync(f, 'utf8'))).map(f => relative(ROOT, f))
    expect(hits).toEqual([])
  })

  test('the allowance is not stale: each allowed path still exists and still names the variable', () => {
    for (const rel of ALLOWED) expect(PAIR.test(readFileSync(join(ROOT, rel), 'utf8'))).toBe(true)
  })
})
