/*
 * kv.test.ts
 *
 * The `store` node's port (`src/kv.ts`) over `KvEntry`, against a real
 * litestone client built from the real `db/orion.lite` and a clock this file
 * owns.
 *
 * `KvEntry` declares `@@expires(expiresAt)`, so a lapse is staged by MOVING THE
 * CLOCK — no write, no sweep. The clock starts years from the host's, which is
 * the assertion on the write side: a ttl minted from `Date.now()` would write a
 * deadline years before it, and every `set` with a ttl would be born absent.
 *
 * The two lookups that must see a lapsed row are the ones graded hardest:
 * `set` over a lapsed key has to overwrite it, since an insert collides on
 * `@@unique([scope, key])`, and `delete` has to remove it and still answer
 * *there was nothing live*.
 *
 * Litestone is imported by RELATIVE path, as `store.test.ts` explains.
 */

import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { createTestEnv } from "../../litestone/src/testing.js"
import { litestoneKeyValue } from "../src/kv"
import { createRunner } from "../src/runner"
import { litestoneHost } from "../src/tenancy"

const SCHEMA = 'database main { path "./orion.db" }\n'
  + readFileSync(join(import.meta.dir, "..", "db", "orion.lite"), "utf8")

const T0 = "2031-05-05T09:00:00.000Z"

async function staged() {
  const env: any = await createTestEnv({ schema: SCHEMA, encryptionKey: "0".repeat(64), claims: [], now: T0 })
  const sys = env.db.asSystem()
  const kv  = litestoneKeyValue(() => sys)
  return { env, sys, kv }
}

describe("an entry with a ttl lapses on the client's clock", () => {

  test("it answers, then reads as absent, with the row untouched", async () => {
    const { env, sys, kv } = await staged()
    await kv.set(null, "global", "k", { n: 1 }, 60_000)

    expect(await kv.get(null, "global", "k")).toEqual({ n: 1 })
    const row = await sys.kvEntry.findFirst({ where: { key: "k" } })
    expect(row.expiresAt).toBe("2031-05-05T09:01:00.000Z")

    env.clock.advance("2m")
    expect(await kv.get(null, "global", "k")).toBeUndefined()
    expect(await sys.kvEntry.count({ withExpired: true })).toBe(1)
  })

  test("an entry with no ttl never lapses", async () => {
    const { env, kv } = await staged()
    await kv.set(null, "global", "forever", "v")
    env.clock.advance("3650d")
    expect(await kv.get(null, "global", "forever")).toBe("v")
  })

  test("set over a lapsed key overwrites it rather than colliding", async () => {
    const { env, sys, kv } = await staged()
    await kv.set(null, "flow:f", "k", "old", 60_000)
    env.clock.advance("2m")

    await kv.set(null, "flow:f", "k", "new", 60_000)
    expect(await kv.get(null, "flow:f", "k")).toBe("new")
    expect(await sys.kvEntry.count({ withExpired: true })).toBe(1)
  })

  test("delete removes a lapsed row and answers that nothing live was there", async () => {
    const { env, sys, kv } = await staged()
    await kv.set(null, "global", "live", 1, 600_000)
    await kv.set(null, "global", "gone", 2, 60_000)
    env.clock.advance("2m")

    expect(await kv.delete(null, "global", "gone")).toBe(false)
    expect(await kv.delete(null, "global", "live")).toBe(true)
    expect(await sys.kvEntry.count({ withExpired: true })).toBe(0)
  })
})

describe("the sweep", () => {

  test("takes the lapsed entries and leaves the live ones", async () => {
    const { env, sys, kv } = await staged()
    await kv.set(null, "global", "live", 1, 600_000)
    await kv.set(null, "global", "gone", 2, 60_000)
    await kv.set(null, "global", "kept", 3)
    env.clock.advance("2m")

    // The runner's own clock is the host's here; the entries are swept on the
    // client's, the clock that already reads them as absent.
    const runner = createRunner({ host: litestoneHost({ db: env.db }), jobs: { dispatch: async () => {}, schedule: () => {} } as any, registry: {} as any })
    const { kvExpired } = await runner.sweep()

    expect(kvExpired).toBe(1)
    const left = (await sys.kvEntry.findMany({ withExpired: true })).map((r: any) => r.key).sort()
    expect(left).toEqual(["kept", "live"])
  })
})
