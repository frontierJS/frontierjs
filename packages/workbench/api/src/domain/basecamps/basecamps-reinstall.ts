// api/src/domain/basecamps/basecamps-reinstall.ts
// `fli basecamp:reinstall <host> --basecamp <name> --yes` run as a child whose
// output goes to a log file, for the Charter page to tail -- the one control
// there that touches the box (charter-to-live.md 2.2).
//
// The command takes Basecamp's backup first, and that backup is the admin
// key's: the entry's `apiKey`, never the run key beside it as `scopedKey`
// (`FJS-D2031`). `--basecamp` is always the entry itself, so the backup, and a
// fresh install's new admin key, land on that entry and nowhere else. A fresh
// install also drops the entry's `scopedKey`, which named a key on the old
// database; Charter cannot run again until a new run key is filed.
//
// `confirm: human` as `basecamp:create` is: the page asks and sends
// `approved: true` only on a yes. `plan` is `--plan`, which reads the box and
// changes nothing, and still needs the yes, as create's `dry` does.

import { entryOf }                                     from './basecamps.ts'
import { spawnFli, type CreateOptions, type Creation } from './basecamps-create.ts'
import { tail }                                        from '../workbench/workbench-run.ts'

export const REINSTALL_MODES = ['restore', 'fresh'] as const

export type ReinstallInput = {
  name:      string
  /** restore puts the backup just taken back; fresh installs an empty Basecamp. */
  mode?:     string
  /** `--plan`: read the box, print the run, change nothing. */
  plan?:     boolean
  approved?: boolean
}

let held: Creation | null = null

/** The argv after `fli.js` for an entry holding `host`, or why it cannot run. */
export function reinstallArgv(name: string, host: string, input: ReinstallInput): string[] | { refused: string } {
  const mode = input.mode ?? 'restore'
  if (!(REINSTALL_MODES as readonly string[]).includes(mode)) return { refused: `A reinstall is ${REINSTALL_MODES.join(' or ')}, not '${mode}'` }
  return [
    'basecamp:reinstall', host, '--basecamp', name, '--yes', `--${mode}`,
    ...(input.plan ? ['--plan'] : []),
  ]
}

/** Start the command, or say why not. One reinstall at a time. */
export async function startReinstall(input: ReinstallInput, opts: CreateOptions = {}): Promise<Creation | { refused: string }> {
  if (held && !held.exit) return { refused: `Already reinstalling '${held.name}' — one at a time` }
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const e    = name ? await entryOf(name, { home: opts.home }) : null
  if (!e) return { refused: `No Basecamp named '${name}' in basecamps.json` }
  if (!e.host) return { refused: `Basecamp '${name}' has no ssh Host, and a reinstall runs on its box over ssh` }
  if (!e.apiKey) return { refused: `Basecamp '${name}' has no admin API key, which takes the backup a reinstall starts with — fli basecamp:key --server ${e.host} files one` }
  const argv = reinstallArgv(name, e.host, input)
  if ('refused' in argv) return argv
  if (input.approved !== true) return { refused: 'basecamp:reinstall is confirmed by a person each run: it was not approved' }

  held = spawnFli('basecamp-reinstall', name, [...argv, '--approved'], opts)
  return { ...held }
}

/** The held run with the end of its log, or null before any. */
export function reinstallationOf(): (Creation & { lines: string[] }) | null {
  if (!held) return null
  return { ...held, lines: tail(held.log) }
}
