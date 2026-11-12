// api/src/domain/laptop/settings.ts
// The two things Settings shows about fli: the global environment
// (`~/.config/fli/.env`) with every value masked, and the user's own commands.
//
// The file format is `core/global-env.js`'s -- set, unset and the key list all
// go through it, so a line written here is a line `fli eset --global` reads.
// A value is masked HERE, before it leaves the domain: the page and the log
// only ever see dots and, for a long value, its last two characters.

import { globalEnvPath, listGlobal, storeKey, unsetGlobal } from '@frontierjs/cli/core/global-env.js'
import { userCommands }                                from '@frontierjs/cli/core/registry.js'
import { keyOwners }                                   from './services.ts'
import type { Where }                                  from './laptop.ts'

export type EnvKey  = { key: string, masked: string, usedBy: string[] }
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
