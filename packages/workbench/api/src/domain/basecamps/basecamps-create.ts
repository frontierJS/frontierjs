// api/src/domain/basecamps/basecamps-create.ts
// `fli basecamp:create --yes` run as a child whose output goes to a log file,
// for the New Basecamp page to tail. Buying and installing a box takes minutes,
// so the call returns at once and the page polls `creationOf`.
//
// The command is `confirm: human`: run anywhere but a terminal it is refused
// unless it carries `--approved`. The page is where the person is, so it asks
// and sends `approved: true` only on a yes, the way `fli gui` does; without it
// this module refuses before it spawns. A plan-only run (`dry`) still needs it,
// because whether a dry run buys nothing is the command's promise, not fli's.
//
// The child is the cli's own `bin/fli.js` under this process's bun, never a
// `fli` on PATH (a global install of another vintage), and it is detached with
// its output on a file descriptor: the API is `bun --watch`, and a restart
// mid-purchase must not kill a half-bought box's installer. The record is in
// memory only, so a restart forgets it and the log file is what is left.
//
// Nothing here reads a cloud token: the cli reads its own from
// `~/.config/fli/.env`, and no secret is ever in the argv shown to the page.

import { spawn }                                   from 'node:child_process'
import { closeSync, mkdirSync, openSync }          from 'node:fs'
import { dirname, join, resolve }                  from 'node:path'
import { fileURLToPath }                           from 'node:url'
import { workbenchDir }                            from '../../core/env.ts'
import { entryOf }                                 from './basecamps.ts'
import { tail }                                    from '../workbench/workbench-run.ts'

export const CLOUD_KINDS = ['hetzner', 'digitalocean'] as const

export type CreateInput = {
  domain:      string
  name:        string
  cloud?:      string
  size?:       string
  region?:     string
  admin?:      string
  reservedIp?: boolean
  backups?:    boolean
  outpost?:    boolean
  /** Plan only: `--dry`, which buys nothing. */
  dry?:        boolean
  /** The person said yes to this exact command line. */
  approved?:   boolean
}

export type Creation = {
  name:      string
  argv:      string[]
  startedAt: string
  pid:       number | null
  exit:      { code: number | null, signal: string | null } | null
  log:       string
  /** The spawn itself failed, so there is no exit code to wait for. */
  error?:    string
}

export type CreateOptions = {
  /** Workbench's own directory; the log goes under `logs/`. */
  dir?:  string
  /** Where `basecamps.json` is read from; the cli's default when absent. */
  home?: string
  /** The child's environment; this process's by default. */
  env?:  Record<string, string | undefined>
}

let held: Creation | null = null

// Resolved from a module the sibling file already imports, so it works wherever
// that does; the package's own `exports` need not list `package.json`.
function fliBin(): string {
  const core = fileURLToPath(import.meta.resolve('@frontierjs/cli/core/basecamps.js'))
  return resolve(dirname(core), '..', 'bin', 'fli.js')
}

const logDir = (dir?: string) => join(dir || workbenchDir(), 'logs')

// A value that begins with `-` would be read as a flag of its own.
const WORD   = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const HOST   = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/
const EMAIL  = /^[A-Za-z0-9][^\s@]*@[^\s@]+\.[^\s@]+$/
const clean  = (v: unknown) => typeof v === 'string' ? v.trim() : ''

/** The argv the command runs with after `fli.js`, or why it cannot. */
export function createArgv(input: CreateInput): string[] | { refused: string } {
  const domain = clean(input.domain), name = clean(input.name)
  const cloud  = clean(input.cloud),  size = clean(input.size), region = clean(input.region), admin = clean(input.admin)
  if (!domain) return { refused: 'Basecamp needs a domain' }
  if (!name)   return { refused: 'The box needs a name' }
  if (!HOST.test(domain)) return { refused: `'${domain}' is not a hostname` }
  if (!WORD.test(name))   return { refused: `'${name}' is not a usable box name: letters, digits, dots and dashes` }
  if (cloud && !(CLOUD_KINDS as readonly string[]).includes(cloud)) return { refused: `--cloud takes ${CLOUD_KINDS.join(' or ')}, not '${cloud}'` }
  if (size && !WORD.test(size))     return { refused: `'${size}' is not a size` }
  if (region && !WORD.test(region)) return { refused: `'${region}' is not a region` }
  if (admin && !EMAIL.test(admin))  return { refused: `'${admin}' is not an email address` }
  return [
    'basecamp:create', '--yes',
    '--domain', domain, '--name', name,
    ...(cloud  ? ['--cloud', cloud]   : []),
    ...(size   ? ['--size', size]     : []),
    ...(region ? ['--region', region] : []),
    ...(admin  ? ['--admin', admin]   : []),
    ...(input.reservedIp === false ? ['--no-reserved-ip'] : []),
    ...(input.backups    === false ? ['--no-backups']     : []),
    ...(input.outpost    === false ? ['--no-outpost']     : []),
    ...(input.dry ? ['--dry'] : []),
  ]
}

/** Start the command, or say why not. One box at a time. */
export async function startCreate(input: CreateInput, opts: CreateOptions = {}): Promise<Creation | { refused: string }> {
  if (held && !held.exit) return { refused: `Already creating '${held.name}' — one box at a time` }
  const argv = createArgv(input)
  if ('refused' in argv) return argv
  if (input.approved !== true) return { refused: 'basecamp:create is confirmed by a person each run: it was not approved' }
  const name = clean(input.name)
  if (await entryOf(name, { home: opts.home })) return { refused: `A Basecamp named '${name}' is already in basecamps.json` }

  held = spawnFli('basecamp-create', name, [...argv, '--approved'], opts)
  return { ...held }
}

/** Start `fli <argv>` detached, its output to a log under Workbench's directory; answers the record it updates on exit. */
export function spawnFli(verb: string, name: string, full: string[], opts: CreateOptions = {}): Creation {
  const dir  = logDir(opts.dir)
  const log  = join(dir, `${verb}.${name}.${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
  mkdirSync(dir, { recursive: true })
  const rec: Creation = { name, argv: ['fli', ...full], startedAt: new Date().toISOString(), pid: null, exit: null, log }

  const fd = openSync(log, 'a')
  let child
  try {
    child = spawn(process.execPath, [fliBin(), ...full], {
      detached: true, stdio: ['ignore', fd, fd],
      env: { ...(opts.env ?? process.env), NO_COLOR: '1' } as NodeJS.ProcessEnv,
    })
  } finally { closeSync(fd) }
  child.unref()
  rec.pid = child.pid ?? null
  child.on('error', e => { rec.exit = { code: null, signal: null }; rec.error = e.message })
  child.on('exit', (code, signal) => { rec.exit = { code, signal } })
  return rec
}

/** The held run with the end of its log, or null before any. */
export function creationOf(): (Creation & { lines: string[] }) | null {
  if (!held) return null
  return { ...held, lines: tail(held.log) }
}
