// src/domain/local/local-ssh.ts -- the developer's own ~/.ssh/config, read on this laptop.
//
// The Servers screen's second source (`FJS-D2006`): the machines no provider
// account lists. Read the way Basecamp's `domain/local/local-ssh.ts` reads it,
// and copied rather than imported, since no import crosses between the two apps.
//
// Nothing here connects: the aliases are read from the file and `ssh -G`
// resolves each one offline. Every alias that reaches `ssh` is one this file
// READ from the config, passed as one argv element and never through a shell.

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, isAbsolute, dirname } from 'node:path'
import { childEnv } from '@frontierjs/junction'
import { env } from '../../core/env.ts'

export type SshHost = {
  alias:    string
  hostname: string
  user:     string | null
  port:     number
}

/** A name ssh could take as an option rather than a host. */
const SAFE_ALIAS = /^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/

/**
 * The concrete `Host` aliases a config names, in order, following `Include`.
 * A pattern (`*`, `?`, `!`) is not a machine and is left out. `read` and
 * `glob` are handed in so the parse is testable without a home directory.
 */
export function hostAliases (
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

/** `ssh -G <alias>`'s output, reduced to what the screen shows. */
export function parseSshG (alias: string, output: string): SshHost {
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
// `-F` makes it read the file this module read -- at the cost of the
// system-wide /etc/ssh/ssh_config, which -F also skips.
const configFile = (configPath: string | null) => configPath ?? join(homedir(), '.ssh', 'config')

/** Every alias, resolved by ssh itself -- `Include`, `Match` and `Host *` defaults are ssh's to apply. */
export async function listSshHosts ({ configPath = null, limit = 200 }: { configPath?: string | null, limit?: number } = {}): Promise<SshHost[]> {
  const file    = configFile(configPath)
  const aliases = hostAliases(file).slice(0, limit)
  return Promise.all(aliases.map(async (alias) => {
    const proc = Bun.spawn(['ssh', '-F', file, '-G', alias], { env: childEnv(env), stdout: 'pipe', stderr: 'ignore' })
    const out  = await new Response(proc.stdout).text()
    await proc.exited
    return parseSshG(alias, out)
  }))
}
