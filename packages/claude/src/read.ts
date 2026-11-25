// src/read.ts — what a reader of a Claude Code file hands back, and where those files live.
//
// Claude Code changes its file formats without notice, and a screen that draws a
// half-parsed file draws a wrong number. So no reader here throws and none
// guesses: it returns the value, or the reason it could not, and the screen
// shows *unavailable* with that reason.

import { homedir } from 'node:os'
import { join } from 'node:path'

export type Read<T> = { ok: true, value: T } | { ok: false, reason: string }

export const read = <T>(value: T): Read<T> => ({ ok: true, value })
export const unreadable = <T = never>(reason: string): Read<T> => ({ ok: false, reason })

/** Where Claude Code keeps its files: the option, else `CLAUDE_CONFIG_DIR`, else `<home>/.claude`. */
export function claudeConfigDir(opts: { home?: string, configDir?: string } = {}): string {
  return opts.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(opts.home ?? homedir(), '.claude')
}

/** JSON text as an object, or why not; a file Claude Code writes is always an object at the top. */
export function readJsonObject(text: string): Read<Record<string, unknown>> {
  let value: unknown
  try { value = JSON.parse(text) }
  catch (e) { return unreadable(`not JSON: ${(e as Error).message}`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unreadable('not a JSON object')
  return read(value as Record<string, unknown>)
}
