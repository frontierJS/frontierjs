// api/src/domain/laptop/settings.ts
// The things Settings shows about fli: the global environment
// (`~/.config/fli/.env`) with every value masked, each profile
// (`~/.config/fli/profiles/<name>.env`) the same way, and the user's own commands.
//
// The file format is `core/global-env.js`'s -- set, unset and the key list all
// go through it, so a line written here is a line `fli eset --global` reads.
// A value is masked HERE, before it leaves the domain: the page and the log
// only ever see dots and, for a long value, its last two characters.

import { createProfile, globalEnvPath, listGlobal, listProfile, profileMode, profileNames, profilePath, storeKey, unsetGlobal, unsetProfileKey, badProfileName } from '@frontierjs/cli/core/global-env.js'
import { projectsNaming }                                from '@frontierjs/cli/core/utils.js'
import { userCommands }                                from '@frontierjs/cli/core/registry.js'
import { keyOwners }                                   from './services.ts'
import { homedir }                                       from 'node:os'
import { dirname, join }                                 from 'node:path'
import type { Where }                                  from './laptop.ts'

export type EnvKey  = { key: string, masked: string, usedBy: string[] }
export type ProfileView = {
  name: string, path: string, keys: EnvKey[]
  /** The file's mode as octal; `open` when others can read it. */
  mode: string | null, open: boolean
  /** The projects whose `.env` names it. */
  projects: string[]
}
export type Command = { name: string, description: string, alias: string | null, filePath: string }

const KEY = /^[A-Z_][A-Z0-9_]*$/
const pinned = (home?: string) => home === undefined ? {} : { home }

// Too short to show any of it: a 4-character value minus two is a guess in two.
const mask = (v: string) => v.length > 6 ? '••••' + v.slice(-2) : '•'.repeat(Math.max(v.length, 4))

/** The global env's keys, values masked, each with the services (`core/services.js`) that read it. */
export function globalEnv({ home }: Where = {}): { path: string, keys: EnvKey[] } {
  const owners = keyOwners()
  return { path: globalEnvPath(home), keys: listGlobal(pinned(home)).map(({ key, value }) => ({ key, masked: mask(value), usedBy: owners[key] ?? [] })) }
}

/** The profiles this machine holds, by name. */
export function profileList({ home }: Where = {}): { names: string[] } {
  return { names: profileNames(pinned(home)) }
}

/**
 * Every profile with its key names masked, its mode and the projects naming
 * it, read off the `.env` files under `root` (`~/code` as `fli profiles` has it).
 */
export function profiles({ home, root }: Where & { root?: string } = {}): { dir: string, profiles: ProfileView[] } {
  const owners = keyOwners()
  const base   = root ?? join(home ?? homedir(), 'code')
  const naming = projectsNaming(base) as Array<{ dir: string, name: string }>
  return {
    dir: dirname(profilePath('x', home)),
    profiles: profileNames(pinned(home)).map(name => {
      const mode = profileMode(name, pinned(home))
      return {
        name, path: profilePath(name, home),
        keys: listProfile(name, pinned(home)).map(({ key, value }) => ({ key, masked: mask(value), usedBy: owners[key] ?? [] })),
        mode, open: mode !== null && (parseInt(mode, 8) & 0o077) !== 0,
        projects: naming.filter(p => p.name === name).map(p => p.dir),
      }
    }),
  }
}

/** Make an empty profile; refused for a name that is not one, and when the file is already there. */
export function addProfile(name: string, { home }: Where = {}): { name: string } | { refused: string } {
  const bad = badProfileName(name)
  if (bad) return { refused: bad }
  return createProfile(name, pinned(home)).made ? { name } : { refused: `profile '${name}' already exists` }
}

const known = (name: string, home?: string) => {
  const bad = badProfileName(name)
  if (bad) return bad
  return profileNames(pinned(home)).includes(name) ? null : `no profile named '${name}'`
}

/** Set one key in a profile that exists, under the same rules as the global env. */
export function setProfileEnv(name: string, key: string, value: string, { home }: Where = {}): { name: string, key: string } | { refused: string } {
  const unknown = known(name, home)
  if (unknown)               return { refused: unknown }
  if (!KEY.test(key))        return { refused: `'${key}' is not an env name (A-Z, 0-9, _; no leading digit)` }
  if (!value)                return { refused: 'a value is required; use Unset to remove a key' }
  if (/[\r\n]/.test(value))  return { refused: 'a value is one line' }
  storeKey(key, value, { ...pinned(home), profile: name })
  return { name, key }
}

/** Remove one key from a profile; refused when the file does not hold it. */
export function unsetProfileEnv(name: string, key: string, { home }: Where = {}): { name: string, key: string } | { refused: string } {
  const unknown = known(name, home)
  if (unknown)        return { refused: unknown }
  if (!KEY.test(key)) return { refused: `'${key}' is not an env name` }
  return unsetProfileKey(name, key, pinned(home)) ? { name, key } : { refused: `${key} is not set in profile '${name}'` }
}

/** Set one key. The key must look like an env name and the value must be one line. */
export function setGlobalEnv(key: string, value: string, { home }: Where = {}): { key: string } | { refused: string } {
  if (!KEY.test(key))        return { refused: `'${key}' is not an env name (A-Z, 0-9, _; no leading digit)` }
  if (!value)                return { refused: 'a value is required; use Unset to remove a key' }
  // A newline would write a second line, and with it a second key the caller never named.
  if (/[\r\n]/.test(value))  return { refused: 'a value is one line' }
  storeKey(key, value, pinned(home))
  return { key }
}

/** Remove one key; refused when the file does not hold it. */
export function unsetGlobalEnv(key: string, { home }: Where = {}): { key: string } | { refused: string } {
  if (!KEY.test(key)) return { refused: `'${key}' is not an env name` }
  return unsetGlobal(key, pinned(home)) ? { key } : { refused: `${key} is not set in the global environment` }
}

/** The commands in the user's own commands folder, read only. */
export function commands({ home }: Where = {}): Command[] {
  return userCommands(pinned(home)) as Command[]
}
