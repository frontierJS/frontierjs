// loader.ts — where an app's notifications are, and what naming one costs.
//
// Any `*.notification.ts` under `createApp({ root })` (`FJS-D1141`), so a
// notification lives in its domain folder. The root is never probed from the
// entry: under a test runner or a drive the entry is the runner, and every
// definition then threw unnamed on its first send.
//
// The file name is the type. `OrderPaid.notification.ts` is `OrderPaid` —
// verbatim, before the suffix, the same rule `<name>.job.ts` follows. A module
// exporting no factory is a warning rather than a skip, because the shape it
// is most likely to be is a notification somebody forgot to default-export.

import { resolve, basename, sep }    from 'node:path'
import { isNotificationFactory, stampType } from './define.ts'
import type { NotificationFactory }   from './define.ts'

const SUFFIX = '.notification.ts'

/** Every notification this app declares, by type. Read-only at runtime and not
 *  only in the types: a writable registry is one an app can add a type to at
 *  3am, after the snapshot was taken and after boot has decided what this build
 *  can send. `get`, `has`, `keys`, `values`, `entries`, `forEach`, `size` and
 *  iteration all work; `set`, `delete` and `clear` throw naming the file that
 *  would have to change. */
export type NotificationRegistry = ReadonlyMap<string, NotificationFactory<unknown>>

const SEALED = ['set', 'delete', 'clear'] as const

/** A Map that refuses to be written to. Not `Object.freeze`, which does nothing
 *  to a Map's internal slots — the probe for this passed `Object.isFrozen` and
 *  accepted a `set()` on the next line. */
export function sealRegistry(m: Map<string, NotificationFactory<unknown>>): NotificationRegistry {
  for (const method of SEALED) {
    Object.defineProperty(m, method, {
      value: () => {
        throw new Error(
          `[notifications] the registry is read-only — \`${method}\` is refused. ` +
          'What this app can send is decided at boot by the notification files in its ' +
          'app; adding a type at runtime makes the build ' +
          'disagree with its own snapshot and with every reader of it.'
        )
      },
    })
  }
  return m
}

async function findFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  try {
    // scan() throws when the directory is not there.
    const glob = new Bun.Glob(`**/*${SUFFIX}`)
    for await (const f of glob.scan({ cwd: dir, absolute: false }))
      if (!f.split(sep).includes('node_modules')) out.push(resolve(dir, f))
  } catch {
    return []
  }
  return out.sort()
}

export async function loadNotifications(root: string): Promise<NotificationRegistry> {
  const registry = new Map<string, NotificationFactory<unknown>>()

  for (const file of await findFiles(root)) {
    const type = basename(file, SUFFIX)

    let mod: Record<string, unknown>
    try {
      mod = await import(file) as Record<string, unknown>
    } catch (err) {
      console.error(`[notifications] failed to load: ${file}`, err)
      continue
    }

    // Default export first, then any named one — a file may export helpers
    // beside its notification, and the first factory found is the notification
    // the file is named for.
    const found = [mod.default, ...Object.values(mod)].find(isNotificationFactory)

    if (!found) {
      console.warn(
        `[notifications] ${basename(file)} exports no defineNotification — ` +
        'nothing was registered for it. A notification file must export its ' +
        'definition, normally as the default export.'
      )
      continue
    }

    // The file names it. A definition that STATED a type keeps it: that is the
    // whole reason `type:` exists, and it is reported rather than accepted in
    // silence — a divergence is either a deliberate rename or a typo, and the
    // two look identical from here.
    stampType(found, type)
    if (found.type !== type) {
      console.warn(
        `[notifications] ${basename(file)} states type "${found.type}", which is ` +
        `not its file name "${type}". The stated type wins — rename the file to ` +
        'match unless the rows were written under the stated one.'
      )
    }

    const already = registry.get(found.type)
    if (already && already !== found) {
      console.warn(
        `[notifications] two notifications answer to "${found.type}" — ` +
        `${basename(file)} is not registered. A type is a persisted value and ` +
        'must name one thing.'
      )
      continue
    }

    registry.set(found.type, found)
  }

  return sealRegistry(registry)
}
