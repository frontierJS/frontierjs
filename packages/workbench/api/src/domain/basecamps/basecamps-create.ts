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
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
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
  endedAt?:  string
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

// ─── Resume ──────────────────────────────────────────────────────────────────
// A create that bought its box and then failed names the line that finishes it
// (`fli basecamp:install <box>`), and a second create refuses while that bare
// box is at the account (`FJS-4206`). The page's resume runs that install on
// the box the log names, with the run's own domain, admin and outpost answer;
// a failed install resumes by running itself again.

// The two failures after the buy (create.md: ssh never answered, a ring-zero
// step exited). The refusal of a second create says "fli basecamp:install
// installs on it", which names no box.
const INSTALL_LINE = /(?:When it does:|and run) fli basecamp:install (\S+)/g
const BOX          = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/

const flagOf = (argv: string[], flag: string) => { const i = argv.indexOf(flag); return i < 0 ? '' : argv[i + 1] ?? '' }

/** The argv that finishes a failed, bought run, or null when nothing is left to resume. */
export function resumeArgv(rec: Pick<Creation, 'argv' | 'exit' | 'error'>, log: string): string[] | null {
  if (!rec.exit || rec.exit.code === 0 || rec.error || rec.argv.includes('--dry')) return null
  const [, verb, box] = rec.argv
  if (verb === 'basecamp:install') return rec.argv.slice(1)
  const named = [...log.matchAll(INSTALL_LINE)].pop()?.[1]
  if (verb !== 'basecamp:create' || !named || !BOX.test(named)) return null
  const admin = flagOf(rec.argv, '--admin')
  return [
    'basecamp:install', named, '--domain', flagOf(rec.argv, '--domain'),
    ...(admin ? ['--admin', admin] : []),
    ...(rec.argv.includes('--no-outpost') ? ['--no-outpost'] : []),
  ]
}

function readLog(log: string): string {
  try { return readFileSync(log, 'utf8') } catch { return '' }
}

/** Run the held failed create's install on its box, or say why not. */
export function startResume(input: { approved?: boolean }, opts: CreateOptions = {}): Creation | { refused: string } {
  if (!held) return { refused: 'No create run to resume' }
  if (!held.exit) return { refused: `'${held.name}' is still running` }
  const argv = resumeArgv(held, readLog(held.log))
  if (!argv) return { refused: `'${held.name}' has nothing to resume: its log names no box to install on` }
  if (input.approved !== true) return { refused: 'Installing on a box is confirmed by a person each run: it was not approved' }
  held = spawnFli('basecamp-install', held.name, argv, opts)
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
  child.on('error', e => { rec.exit = { code: null, signal: null }; rec.endedAt = new Date().toISOString(); rec.error = e.message })
  child.on('exit', (code, signal) => { rec.exit = { code, signal }; rec.endedAt = new Date().toISOString() })
  return rec
}

export type Step = { n: number, of: number, name: string, what: string }

// The stage header `basecamp:create` echoes as each stage opens (`stageBar` in
// cli commands/basecamp/_module.md): `  3/8 deploy:setup  docker and caddy …`.
// A stage name may hold one space (`api key`); two spaces end it.
const STEP = /^ {2}(\d+)\/(\d+) (\S+(?: \S+)?) {2}(.+)$/

/**
 * The stages a create run has reached, in order. Read from the whole log, not
 * its tail: deploy:setup's apt output alone outruns the tail, and the page
 * would lose the stages before it. A line from a child that happens to match
 * is dropped unless it is the next number of the same count.
 */
export function stepsOf(text: string): Step[] {
  const steps: Step[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = STEP.exec(line)
    if (!m) continue
    const n = Number(m[1]), of = Number(m[2])
    const last = steps[steps.length - 1]
    if (last ? (of !== last.of || n !== last.n + 1) : n !== 1) continue
    steps.push({ n, of, name: m[3], what: m[4].trim() })
  }
  return steps
}

/** The held run with its stages, the end of its log and the install a resume
 *  would run, or null before any. */
export function creationOf(): (Creation & { lines: string[], steps: Step[], resume: string[] | null }) | null {
  if (!held) return null
  const text = readLog(held.log)
  const resume = resumeArgv(held, text)
  return { ...held, lines: tail(held.log), steps: stepsOf(text), resume: resume && ['fli', ...resume] }
}
