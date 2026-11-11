// api/src/domain/laptop/ping.ts
// The ntfy topic Claude Code's Stop hook (`~/.claude/hooks/ntfy.sh`) posts to,
// kept in `~/.claude/ntfy-topic`. The hook reads that file on every turn and
// sends nothing when it is empty, so setting is the whole toggle.
//
// Not Workbench's own push topic (`push.json`): that one is minted and belongs
// to the notifications driver, this one is the user's, typed.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir }                                        from 'node:os'
import { dirname, join }                                  from 'node:path'
import type { Where }                                     from './laptop.ts'

export type Ping = { path: string, topic: string | null, url: string | null }

// The hook splices the topic into a URL, so only ntfy's own topic alphabet gets through.
const TOPIC = /^[A-Za-z0-9_-]{1,64}$/

const file = (home?: string) => join(home ?? homedir(), '.claude', 'ntfy-topic')

/** The topic the hook pings, or null when the file is missing or blank. */
export function ping({ home }: Where = {}): Ping {
  const path = file(home)
  let topic: string | null = null
  try { topic = readFileSync(path, 'utf8').trim() || null } catch {}
  return { path, topic, url: topic && `https://ntfy.sh/${topic}` }
}

/** Set the topic; an empty one removes the file, which turns the ping off. */
export function setPing(topic: string, { home }: Where = {}): Ping | { refused: string } {
  const path = file(home)
  const name = topic.trim()
  if (!name) {
    rmSync(path, { force: true })
    return ping({ home })
  }
  if (!TOPIC.test(name)) return { refused: `'${name}' is not a topic (letters, digits, - and _, up to 64)` }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, name + '\n')
  return ping({ home })
}
