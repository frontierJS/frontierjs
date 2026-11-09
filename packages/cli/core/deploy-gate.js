// ─── deploy-gate.js — Basecamp ships what was pushed and graded ──────────────
//
// `fli deploy` ships `git archive HEAD`, so a commit that no remote holds and
// no full CI run passed could reach yuma, the machine every other app's
// releases pass through (`FJS-4118`, `FJS-D2040`). The deploy refuses, and
// `--unverified` is the named way past it: it prints what it skipped.
//
// `gateVerdict` is the rule over facts; `readGateFacts` is the one place that
// asks git and `.cache/ci-last.txt`. The check belongs in the deploy rather
// than in a hook because concurrent sessions share a tree and a commit can
// land between a check and a deploy.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitOut } from './git.js'

const BASECAMP = '@frontierjs/basecamp'

export function isBasecampApp(root) {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === BASECAMP }
  catch { return false }
}

// `.cache/ci-last.txt`: a header `# <iso> · <short sha> · ci <args>`, the
// summary, and a last line `✓ CI passed in Ns` or `✗ CI failed in Ns`. A fast
// tier run says so on its pass line, because it ran no suite.
export function parseCiRecord(text) {
  const lines = String(text ?? '').split('\n').map(l => l.trimEnd()).filter(Boolean)
  const header = /^# (\S+) · (\S+) · ci\b(.*)$/.exec(lines[0] ?? '')
  if (!header) return null
  const last = lines[lines.length - 1] ?? ''
  return {
    at:     header[1],
    head:   header[2],
    passed: /^✓ CI passed/.test(last),
    fast:   /\(fast tier/.test(last) || /(^|\s)--fast\b/.test(header[3]),
  }
}

// facts: { head, pushedTo: [remote refs holding head], ci: parsed record with
// `head` resolved to a full sha, or null }. → { ok, refusals, skipped }
export function gateVerdict({ head, pushedTo = [], ci = null, unverified = false }) {
  const refusals = []
  if (!pushedTo.length)
    refusals.push(`${short(head)} is not on any remote branch — push it first`)
  if (!ci)
    refusals.push('no CI record at .cache/ci-last.txt — run `bun run ci` on this commit')
  else if (ci.head !== head)
    refusals.push(`the last CI run graded ${short(ci.head)}, not ${short(head)} — run \`bun run ci\` on this commit`)
  else if (ci.fast)
    refusals.push(`the last CI run on ${short(head)} was the fast tier, which ran no suite — run \`bun run ci\``)
  else if (!ci.passed)
    refusals.push(`CI failed on ${short(head)} — detail in .cache/ci-last.txt`)
  if (unverified) return { ok: true, refusals: [], skipped: refusals }
  return { ok: !refusals.length, refusals, skipped: [] }
}

const short = (sha) => String(sha ?? '?').slice(0, 9)

export function readGateFacts(root) {
  const head = gitOut(root, ['rev-parse', 'HEAD'])?.trim() || null
  const top  = gitOut(root, ['rev-parse', '--show-toplevel'])?.trim() || root
  const pushedTo = head
    ? (gitOut(root, ['for-each-ref', '--contains', head, '--format=%(refname:short)', 'refs/remotes']) ?? '')
        .split('\n').map(s => s.trim()).filter(s => s && !s.endsWith('/HEAD'))
    : []
  const file = join(top, '.cache', 'ci-last.txt')
  const ci = existsSync(file) ? parseCiRecord(readFileSync(file, 'utf8')) : null
  if (ci) ci.head = gitOut(root, ['rev-parse', '--verify', '--quiet', `${ci.head}^{commit}`])?.trim() || ci.head
  return { head, pushedTo, ci }
}

// → { ok, lines: [[level, text]] } for the preflight to print.
export function checkDeployGate(root, { unverified = false } = {}) {
  const verdict = gateVerdict({ ...readGateFacts(root), unverified })
  const lines = []
  for (const r of verdict.refusals) lines.push(['error', r])
  if (verdict.refusals.length) lines.push(['error', 'Or pass --unverified to deploy it anyway; the run then prints what it skipped.'])
  for (const s of verdict.skipped) lines.push(['warn', `--unverified skipped: ${s}`])
  return { ok: verdict.ok, lines }
}
