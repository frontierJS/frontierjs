/*
 * src/client/profiles.ts — where a signed-in CLI keeps its credential.
 *
 * One file per app under `$XDG_CONFIG_HOME/<app>/` (`~/.config/<app>/`), one
 * entry per profile: the app's MCP endpoint, the key (`FJS-D402`), and — for an
 * app whose tenant travels as a header — the current tenant (`FJS-D399`).
 *
 * The file holds a live credential, so it is written 0600 and replaced whole by
 * a rename: a crash mid-write leaves the old file rather than half a JSON
 * document that fails every later run with a parse error naming no cause. A
 * keyring would be better where one exists and is not built.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir }       from 'node:os'
import { dirname, join } from 'node:path'

export interface Profile {
  url:     string
  token?:  string
  tenant?: string
}

export interface ProfileFile {
  current?: string
  profiles: Record<string, Profile>
}

export interface ProfileStore {
  /** Where it lives, for a message that tells the person which file. */
  where: string
  read():  ProfileFile
  write(file: ProfileFile): void
}

export function configPath(app: string, env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config')
  return join(base, app, 'profiles.json')
}

export function fileStore(path: string): ProfileStore {
  return {
    where: path,
    read() {
      if (!existsSync(path)) return { profiles: {} }
      let parsed: ProfileFile
      try { parsed = JSON.parse(readFileSync(path, 'utf8')) }
      catch { throw new Error(`${path} is not JSON — fix it or delete it and sign in again`) }
      return { profiles: {}, ...parsed }
    },
    write(file) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, path)
    },
  }
}

/** A key shown in a listing: enough to tell two apart, never enough to use. */
export function maskToken(token: string | undefined): string {
  if (!token) return '(none)'
  return token.length <= 12 ? '…' : `${token.slice(0, 6)}…${token.slice(-4)}`
}
