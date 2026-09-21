// test-ports.test.ts
//
// One rule, and it is the one `FJS-900` cost a day to learn: **no two test
// files in this package may name the same port**.
//
// Bun runs every file in ONE process, and an app's `stop()` does not finish
// before the next file's `start()` begins. Three files bound 3396 and four
// bound 3397, so under the full suite a socket meant for one app was answered
// by another that was already shutting down — its `Server shutting down` close
// reached the client as `Expected 101 status code`, and the suite reported it
// as the connection-cap assertion failing. It passed alone, and it grew from
// one run in three to every run as the suite gained files.
//
// The fix is `port: 0` and reading `app.http.port` back after `start()`, which
// is what `@frontierjs/testing`'s `listen: true` already does and for this
// reason. This guard is the half that keeps it: a collision is decidable from
// the source, and nothing else here would notice one until a suite went red
// somewhere unrelated.

import { describe, it, expect } from 'bun:test'
import { readdirSync } from 'node:fs'

const DIR = new URL('.', import.meta.url).pathname

/** Every four-digit port literal a file could BIND, by file. */
function portsIn(src: string): number[] {
  const out = new Set<number>()
  // Only the two spellings that reach `createApp`'s config — `port: 3397` and
  // the constant that feeds it. A `localhost:3000` in a URL is deliberately NOT
  // counted: ten files name it as the base URL of a client that never connects,
  // and nothing binds it, so counting it would report a collision that cannot
  // happen and the rule would be turned off within a week.
  for (const re of [/\bport\s*:\s*(\d{4})\b/gi, /\b\w*PORT\w*\s*=\s*(\d{4})\b/g]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) out.add(Number(m[1]))
  }
  return [...out]
}

describe('no two test files name the same port', () => {

  // This file is excluded from its own scan: the fixtures below are strings
  // ABOUT ports rather than ports, and counting them would make the guard
  // collide with whatever real file used the same number.
  const files = readdirSync(DIR).filter(f => f.endsWith('.test.ts') && f !== 'test-ports.test.ts')

  it('reads the suite at all, or this passes by checking nothing', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('every fixed port is named by at most one file', async () => {
    const byPort = new Map<number, string[]>()

    for (const f of files) {
      const src = await Bun.file(DIR + f).text()
      for (const p of portsIn(src)) byPort.set(p, [...(byPort.get(p) ?? []), f])
    }

    const shared = [...byPort].filter(([, fs]) => fs.length > 1)
      .map(([p, fs]) => `${p}: ${fs.join(', ')}`)

    expect(shared).toEqual([])
  })

  it('the check can see a collision, or it is decoration', () => {
    // A guard on the guard: the regexes have to actually match the shapes this
    // package writes, or the assertion above passes on any tree.
    const a = "const PORT = 3396\nconst app = createApp({ config: { port: PORT } })"
    expect(portsIn(a)).toContain(3396)
    // And it must NOT count a URL, or the ten files naming localhost:3000 as a
    // client base read as a collision nobody can act on.
    expect(portsIn("await fetch('http://localhost:3396/health')")).toEqual([])
    expect(portsIn('const TIMEOUT = 4000')).toEqual([])
  })
})
