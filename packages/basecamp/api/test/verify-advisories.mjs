/*
 * verify-advisories.mjs — every row of the component table, asked of the live
 * source it names (IDEAS/server-posture.md 7.1).
 *
 *   bun run verify:advisories
 *
 * A stale name in `domain/host/components.ts` answers "no advisories", which
 * reads exactly like a clean component. So each graded row is asked about a
 * version known to be affected and must name the advisory it is known for, and
 * the GitHub rows must leave nothing unread at that version, because one unread
 * advisory grades the component `unknown` on every machine.
 *
 * Needs the network: OSV and api.github.com, unauthenticated. GitHub allows 60
 * requests an hour without a token, and a run spends one per repository;
 * GITHUB_TOKEN is sent when set.
 */

import { COMPONENTS, lookupFor, matchOsv, matchGithub } from '../src/domain/host/components.ts'

const BASE = { osv: 'https://api.osv.dev', github: 'https://api.github.com' }

async function ask(lookup) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' }
  if (lookup.source === 'github' && process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const r = await fetch(BASE[lookup.source] + lookup.path, {
    method: lookup.method, headers, body: lookup.body ? JSON.stringify(lookup.body) : undefined,
  })
  if (!r.ok) throw new Error(`${lookup.source} ${lookup.path}: ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

let failed = 0
const fail = (msg) => { failed++; console.log(`  ✗ ${msg}`) }

for (const c of COMPONENTS) {
  if (!c.source) { console.log(`  · ${c.id}: shown, not graded`); continue }
  const version = c.known?.version ?? '0.0.1'
  const lookup  = lookupFor(c, version)
  let answer
  try { answer = await ask(lookup) } catch (e) { fail(`${c.id}: ${e.message}`); continue }
  const m = c.source.kind === 'osv' ? matchOsv(answer) : matchGithub(c.source, answer, version)

  if (m.unread.length) fail(`${c.id}@${version}: unread advisories ${m.unread.join(', ')}`)
  if (!c.known) { console.log(`  ✓ ${c.id}: answered, ${m.ids.length} at ${version} (no known advisory to prove)`); continue }
  if (!m.ids.includes(c.known.advisory)) fail(`${c.id}@${version}: ${c.known.advisory} not among ${m.ids.length} [${m.ids.join(', ')}]`)
  else console.log(`  ✓ ${c.id}@${version}: ${c.known.advisory} (${m.ids.length} in all)`)
}

console.log(failed ? `\n${failed} failed` : '\nall rows answer')
process.exit(failed ? 1 : 0)
