// src/core/local-ssh.ts — the operator's own ~/.ssh/config, read on THEIR laptop.
//
// A development affordance and nothing more: Basecamp running locally lists the
// Host aliases its operator already has, so importing a machine is a pick
// rather than retyping an address, and installing Basecamp on one is a command
// with the alias already in it (`fli deploy:setup --server <alias>`).
//
// **Off unless `LOCAL_SSH=1`, and refused under `NODE_ENV=production` even
// then.** `NODE_ENV` defaults to development, so a control plane deployed
// without setting it would otherwise list ITS server's ssh config — and run
// ssh with its agent — to any admin. The flag is opt-in for the same reason
// `ALLOW_CLOUD_SPEND` is (`core/env.ts`).
//
// Nothing here holds a key or opens a session Basecamp keeps (`FJS-D241`): the
// aliases are read, `ssh -G` resolves each one without connecting, and the
// reachability probe is one `ssh … true` with the operator's own agent.
//
// Every alias that reaches `ssh` is one this file READ from the config and
// passes as one argv element, never through a shell — a caller-supplied name
// is looked up, not interpolated.

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, isAbsolute, dirname } from 'node:path'
import { env } from './env.ts'

export type SshHost = {
  alias:    string
  hostname: string
  user:     string | null
  port:     number
}

/** Why the listing is not offered, or null when it is. */
export function localSshRefusal(e: { NODE_ENV?: string, LOCAL_SSH?: string } = env): string | null {
  if (e.NODE_ENV === 'production') return 'not offered under NODE_ENV=production'
  if (e.LOCAL_SSH !== '1')        return 'not offered — set LOCAL_SSH=1 on a Basecamp running on your own machine'
  return null
}

/** A name ssh could take as an option rather than a host. */
const SAFE_ALIAS = /^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/

/**
 * The concrete `Host` aliases a config names, in order, following `Include`.
 *
 * A pattern (`*`, `?`, `!`) is not a machine and is left out. `Match` blocks
 * name no alias. `read` and `glob` are handed in so the parse is testable
 * without a home directory.
 */
export function hostAliases(
  path: string,
  read: (p: string) => string | null = (p) => existsSync(p) ? readFileSync(p, 'utf8') : null,
  glob: (pattern: string) => string[] = (pattern) => [...new Bun.Glob(pattern).scanSync({ absolute: true, onlyFiles: true })].sort(),
  seen = new Set<string>(),
): string[] {
  if (seen.has(path)) return []
  seen.add(path)
  const text = read(path)
  if (text === null) return []

  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    const m = line.match(/^(\w+)\s*[=\s]\s*(.+)$/)
    if (!m) continue
    const [, key, value] = m
    const words = value.split(/\s+/).map(w => w.replace(/^"|"$/g, ''))
    if (/^host$/i.test(key)) {
      for (const w of words) if (!/[*?!]/.test(w) && SAFE_ALIAS.test(w) && !out.includes(w)) out.push(w)
    } else if (/^include$/i.test(key)) {
      for (const w of words) {
        const pattern = w.startsWith('~/') ? join(homedir(), w.slice(2)) : isAbsolute(w) ? w : join(dirname(path), w)
        for (const file of glob(pattern))
          for (const a of hostAliases(file, read, glob, seen)) if (!out.includes(a)) out.push(a)
      }
    }
  }
  return out
}

/** `ssh -G <alias>`'s output, reduced to what the import form takes. */
export function parseSshG(alias: string, output: string): SshHost {
  const get = (k: string) => output.match(new RegExp(`^${k} (.+)$`, 'm'))?.[1]?.trim() ?? null
  return {
    alias,
    hostname: get('hostname') ?? alias,
    user:     get('user'),
    port:     Number(get('port') ?? 22) || 22,
  }
}

// ssh finds ~ through the passwd entry and Bun through $HOME, so left to
// itself ssh can resolve aliases from a different file than the one listed.
// `-F` makes it read the file this module read — at the cost of the system-wide
// /etc/ssh/ssh_config, which -F also skips.
const configFile = (configPath: string | null) => configPath ?? join(homedir(), '.ssh', 'config')

/** Every alias, resolved by ssh itself — `Include`, `Match` and `Host *` defaults are ssh's to apply. */
export async function listSshHosts({ configPath = null, limit = 200 }: { configPath?: string | null, limit?: number } = {}): Promise<SshHost[]> {
  const file    = configFile(configPath)
  const aliases = hostAliases(file).slice(0, limit)
  return Promise.all(aliases.map(async (alias) => {
    const proc = Bun.spawn(['ssh', '-F', file, '-G', alias], { stdout: 'pipe', stderr: 'ignore' })
    const out  = await new Response(proc.stdout).text()
    await proc.exited
    return parseSshG(alias, out)
  }))
}

/**
 * Can this laptop reach the alias right now — key-only, five seconds, nothing
 * run but `true`. The alias must be one the config names; anything else is
 * refused before a process starts.
 */
export async function probeSshHost(alias: string, { configPath = null }: { configPath?: string | null } = {}) {
  const file = configFile(configPath)
  if (!hostAliases(file).includes(alias)) return { alias, reachable: false, said: `'${alias}' is not a Host in the ssh config` }
  const proc = Bun.spawn(['ssh', '-F', file, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', alias, 'true'],
    { stdout: 'ignore', stderr: 'pipe' })
  const said = (await new Response(proc.stderr).text()).trim().split('\n').pop() ?? ''
  const code = await proc.exited
  return { alias, reachable: code === 0, said: code === 0 ? '' : said }
}
