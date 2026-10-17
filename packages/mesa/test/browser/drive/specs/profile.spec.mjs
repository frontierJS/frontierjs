/*
 * profile — a kept profile survives a relaunch, a temp one does not.
 *
 * An offline app's rows live in IndexedDB, and a drive that writes, closes and
 * reopens on a fresh profile passes whether or not the app persisted anything.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'profile — kept across a relaunch, or gone with the browser'

export async function run(t) {
  const profile = join(t.work, 'kept')
  const first = await t.openChrome({ profile })
  try {
    await first.navigate(t.origin, 'window.put')
    await first.evaluate(`return await put('written')`)
  } finally { await first.close() }
  t.ok(existsSync(profile), 'a kept profile is on disk after close')

  const second = await t.openChrome({ profile })
  try {
    await second.navigate(t.origin, 'window.get')
    t.is((await second.evaluate(`return await get()`)).v, 'written', 'and carries IndexedDB into the relaunch')
  } finally { await second.close() }

  const temp = await t.openChrome()
  try {
    await temp.navigate(t.origin, 'window.put')
    await temp.evaluate(`return await put('written')`)
  } finally { await temp.close() }

  const fresh = await t.openChrome()
  try {
    await fresh.navigate(t.origin, 'window.get')
    t.is((await fresh.evaluate(`return await get()`)).v, 'absent', 'a temp profile is gone, so the next launch starts empty')
  } finally { await fresh.close() }
}
