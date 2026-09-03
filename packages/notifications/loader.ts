// loader.ts — where an app's notifications are, and what naming one costs.
//
// PROBED, not derived, and the reasoning is junction's own (`FJS-458`): the
// flat layout puts `notifications/` beside the entry, the layout this framework
// scaffolds puts it at `src/notifications/`, and a missing directory is a
// silent no-op — the app boots, sends nothing, and says nothing. Both layouts
// are one probe apart. A DECLARED path is never probed around: a relative path
// resolved against the wrong working directory lands on nothing and looks
// exactly like an app that has no notifications.
//
// The file name is the type. `OrderPaid.notification.ts` is `OrderPaid` —
// verbatim, before the suffix, the same rule `<name>.job.ts` follows. A module
// exporting no factory is a warning rather than a skip, because the shape it
// is most likely to be is a notification somebody forgot to default-export.

import { resolve, dirname, basename } from 'node:path'
import { existsSync, statSync }       from 'node:fs'
import { isNotificationFactory, stampType } from './define.ts'
import type { NotificationFactory }   from './define.ts'

const SUFFIX = '.notification.ts'

const isDir = (p: string): boolean => {
  try { return existsSync(p) && statSync(p).isDirectory() } catch { return false }
}

export type NotificationsDirSource =
  'disabled' | 'declared' | 'declared-missing' | 'probed' | 'none'

export interface NotificationsDirResolution {
  dir:       string | null
  source:    NotificationsDirSource
  declared?: string
  probed:    string[]
}

export function resolveNotificationsDir(opts: {
  entry?:    string | null | undefined
  declared?: string | false | null | undefined
  cwd?:      string
}): NotificationsDirResolution {
  const { entry, declared, cwd = process.cwd() } = opts

  if (declared === false) return { dir: null, source: 'disabled', probed: [] }

  if (declared) {
    const abs = resolve(cwd, declared)
    return isDir(abs)
      ? { dir: abs,  source: 'declared',         declared, probed: [abs] }
      : { dir: null, source: 'declared-missing', declared, probed: [abs] }
  }

  if (!entry) return { dir: null, source: 'none', probed: [] }

  const base   = dirname(entry)
  const probed = [resolve(base, 'notifications'), resolve(base, 'src', 'notifications')]
  const found  = probed.find(isDir)

  return found
    ? { dir: found, source: 'probed', probed }
    : { dir: null,  source: 'none',   probed }
}

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
          'What this app can send is decided at boot by the files in its ' +
          'notifications directory; adding a type at runtime makes the build ' +
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
    // Bun.Glob handles the recursion; scan() throws when the directory is not
    // there, which resolveNotificationsDir has already ruled out for a probed
    // path and has NOT for a declared one that vanished between the two.
    const glob = new Bun.Glob(`**/*${SUFFIX}`)
    for await (const f of glob.scan({ cwd: dir, absolute: false })) out.push(resolve(dir, f))
  } catch {
    return []
  }
  return out.sort()
}

export async function loadNotifications(dir: string): Promise<NotificationRegistry> {
  const registry = new Map<string, NotificationFactory<unknown>>()

  for (const file of await findFiles(dir)) {
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
