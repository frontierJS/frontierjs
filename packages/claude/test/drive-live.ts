/*
 * test/drive-live.ts — does the installed `claude` still speak the recorded protocol?
 *
 *   bun run drive:live
 *
 * Runs the read-only recording again against the installed `claude` (one haiku
 * run, a fraction of a cent) and compares it with test/fixtures/read-only.jsonl:
 * the set of events it wrote and the keys of its `result`. Values are not
 * compared; a new key, a missing one or a renamed event is what breaks a reader
 * written against the fixtures. Exits 1 and names each difference.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { census, load, resultOf } from './census.ts'
import recorded from './fixtures/version.json'
import { readOnly, version } from './record.ts'

const root = mkdtempSync(join(tmpdir(), 'claude-drive-'))
mkdirSync(root, { recursive: true })
writeFileSync(join(root, 'notes.txt'), 'The launch is on Tuesday.\nBring the blue folder.\n')

console.log(`installed claude: ${await version()}`)
console.log(`fixtures recorded on: ${recorded.claude}`)

let live
try {
  live = await readOnly(root)
} finally {
  const transcripts = join(homedir(), '.claude', 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'))
  if (existsSync(transcripts)) rmSync(transcripts, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
}

const fixture = load('read-only.jsonl')
const problems: string[] = []

const diff = (what: string, want: string[], got: string[]) => {
  for (const x of got) if (!want.includes(x)) problems.push(`${what}: new in the live run: ${x}`)
  for (const x of want) if (!got.includes(x)) problems.push(`${what}: recorded but not in the live run: ${x}`)
}

// These frames appear in some runs and not others on one version, so a strict
// comparison fails a drive when nothing in the protocol changed.
const SOMETIMES = ['out system/ui_invalidate', 'out system/thinking_tokens']
const steady = (kinds: string[]) => kinds.filter(k => !SOMETIMES.includes(k))

diff('event', steady(census(fixture)), steady(census(live.frames)))
diff('result key', Object.keys(resultOf(fixture) ?? {}).sort(), Object.keys(resultOf(live.frames) ?? {}).sort())

if (problems.length) {
  console.error(`\nthe protocol differs from the fixtures:\n${problems.map(p => `  ${p}`).join('\n')}`)
  console.error('\nre-record with `bun test/record.ts`, read the diff, and update the census pinned in test/fixtures.test.ts')
  process.exit(1)
}
console.log(`ok: ${census(live.frames).length} event kinds and ${Object.keys(resultOf(live.frames) ?? {}).length} result keys match the fixture`)
