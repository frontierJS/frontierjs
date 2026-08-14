// Studio's "🎲 Random" button — the SERVER half.
//
//   bun bench/studio-factory.mjs
//
// Copies basecamp's db to a tmpdir first, so it never writes to the real one.
// The claim under test is not "a row appeared" but "a row appeared WITH its
// required parents, graded by the gate, and the response said which tables it
// touched" — a generated row that silently writes six tables is the shape that
// stops a scratch database being one.
import { spawn } from 'node:child_process'
import { mkdtempSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const R = '/home/j/code/FRONTIER/frontierjs'
const PORT = 7503
let fails = 0
const ok = (n, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  → ' + x)); if (!c) fails++ }

// copy basecamp's db so the drive never writes to the real one
const work = mkdtempSync(join(tmpdir(), 'factory-'))
cpSync(`${R}/packages/basecamp/db`, work, { recursive: true })

const studio = spawn('bun', [`${R}/packages/litestone/src/tools/cli.js`, 'studio', `--port=${PORT}`],
  { cwd: work, env: { ...process.env, ENCRYPTION_KEY: 'a'.repeat(64) }, stdio: ['ignore','pipe','pipe'] })
let slog = ''; studio.stdout.on('data', d => slog += d); studio.stderr.on('data', d => slog += d)
const api = (p, b) => fetch(`http://127.0.0.1:${PORT}/api${p}`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(b) }).then(r => r.json())

try {
  let up = false
  for (let i = 0; i < 60 && !up; i++) { await new Promise(r => setTimeout(r, 250)); if (studio.exitCode !== null) break
    up = await fetch(`http://127.0.0.1:${PORT}/`).then(r => r.ok).catch(() => false) }
  if (!up) { console.log('studio down\n' + slog.slice(0, 900)); process.exit(1) }

  // ── a model with a deep required-FK chain ────────────────────────────────
  const before = await api('/table', { table: 'deployment', pageSize: 1 })
  const r = await api('/factory', { table: 'deployment' })
  ok('deployment generated', r.ok === true, r.error)
  ok('a row came back', !!r.row?.id, JSON.stringify(r.row)?.slice(0, 160))
  ok('reports what it created', Array.isArray(r.created) && r.created.length > 0, JSON.stringify(r.created))
  ok('withParents wrote OTHER tables', (r.created ?? []).some(c => c.table !== 'deployment'),
     JSON.stringify(r.created))
  console.log('     created:', (r.created ?? []).map(c => `${c.count}×${c.table}`).join(', '))
  const after = await api('/table', { table: 'deployment', pageSize: 1 })
  ok('row count went up', (after.total ?? 0) === (before.total ?? 0) + 1, `${before.total} → ${after.total}`)

  // ── two clicks differ (the seed counter) ─────────────────────────────────
  const a = await api('/factory', { table: 'user' })
  const b = await api('/factory', { table: 'user' })
  ok('two clicks give different rows', a.row?.email !== b.row?.email, `${a.row?.email} vs ${b.row?.email}`)
  ok('fake words, not filler', /[a-z]{3,}/i.test(String(a.row?.name ?? a.row?.email ?? '')), JSON.stringify(a.row)?.slice(0,120))
  console.log('     sample:', JSON.stringify(a.row)?.slice(0, 200))

  // ── the gate is a real answer, not a bug ─────────────────────────────────
  const gated = await api('/factory', { table: 'server', auth: { id: 999999, email: 'nobody@x.com' } })
  ok('runs as the selected principal', gated.ok === true || /requires .* access|denied|not allowed/i.test(gated.error ?? ''),
     gated.error ?? 'created as that principal')
  console.log('     as stranger →', gated.ok ? 'created' : gated.error?.slice(0, 110))

  // ── an append-only model is refused by name ──────────────────────────────
  // ── pins: one Account, reused at every depth of the chain ────────────────
  const acct = (await api('/table', { table: 'account', pageSize: 1 })).items?.[0]
  ok('an account exists to pin', !!acct?.id, JSON.stringify(acct)?.slice(0, 80))
  const accountsBefore = (await api('/table', { table: 'account', pageSize: 1 })).total
  const pinned = await api('/factory', { table: 'deployment', pins: { Account: acct.id } })
  ok('generates with a pin', pinned.ok === true, pinned.error)
  const accountsAfter = (await api('/table', { table: 'account', pageSize: 1 })).total
  ok('the pin created no new Account', accountsAfter === accountsBefore, `${accountsBefore} → ${accountsAfter}`)
  ok('and no account appears in the tally', !(pinned.created ?? []).some(c => c.table === 'account'),
     JSON.stringify(pinned.created))
  console.log('     with pin:', (pinned.created ?? []).map(c => `${c.count}×${c.table}`).join(', '))

  const stale = await api('/factory', { table: 'deployment', pins: { Account: 'no-such-id' } })
  ok('an unreadable pin is refused, not ignored', !stale.ok && /not visible/.test(stale.error ?? ''), stale.error)

  const ghost = await api('/factory', { table: 'workspace', pins: { NoSuchModel: '1' } })
  ok('a pin for a vanished model is skipped', ghost.ok === true, ghost.error)

  // ── the refusal offers exactly one retry, and only for a refusal ─────────
  const denied = await api('/factory', { table: 'server', auth: { id: 999999, email: 'nobody@x.com' } })
  ok('a gate refusal offers the retry', denied.retryAsSystem === true, JSON.stringify(denied))
  const retried = await api('/factory', { table: 'server', auth: { id: 999999, email: 'nobody@x.com' }, asSystem: true })
  ok('retry as system succeeds', retried.ok === true, retried.error)
  ok('the response admits it bypassed', retried.asSystem === true, JSON.stringify(retried.asSystem))
  ok('a system retry offers no further retry', retried.retryAsSystem === undefined || retried.retryAsSystem === false, JSON.stringify(retried.retryAsSystem))
  const badRow = await api('/factory', { table: 'nope2' })
  ok('a non-access error offers no retry', !badRow.retryAsSystem, JSON.stringify(badRow))

  const log = await api('/factory', { table: 'auditLogs' })
  ok('logger model refused by name', !log.ok && /append-only|Unknown table/.test(log.error ?? ''), log.error)

  const bad = await api('/factory', { table: 'nope' })
  ok('unknown table refused', !bad.ok && /Unknown table/.test(bad.error ?? ''), bad.error)
} finally { studio.kill('SIGKILL') }
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
