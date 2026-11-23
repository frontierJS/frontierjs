/*
 * test/census.ts — what a recording is made of, as one sorted list.
 *
 * The fixture test pins this list per recording and the live drive compares it
 * with a fresh run, so a renamed or added event shows as a changed line rather
 * than as a reader that quietly ignores it. Counts are left out: how many text
 * deltas a reply streams as changes from run to run.
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Frame = { dir: 'in' | 'out', line: Record<string, any> }

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

export function load(file: string): Frame[] {
  return readFileSync(join(FIXTURES, file), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Frame)
}

// A control frame is named by its request or response subtype, a stream event
// by the Messages API event it carries, any other frame by `type/subtype`.
export function kind({ dir, line }: Frame): string {
  const type = String(line.type)
  const detail =
    type === 'control_request'  ? `:${line.request?.subtype}` :
    type === 'control_response' ? `:${line.response?.subtype}` :
    type === 'stream_event'     ? `:${line.event?.type}` :
    line.subtype                ? `/${line.subtype}` : ''
  return `${dir} ${type}${detail}`
}

export function census(frames: Frame[]): string[] {
  return [...new Set(frames.map(kind))].sort()
}

export function resultOf(frames: Frame[]): Record<string, any> | undefined {
  return frames.find(f => f.dir === 'out' && f.line.type === 'result')?.line
}
