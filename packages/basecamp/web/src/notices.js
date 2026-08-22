// src/notices.js — the attention rules.
//
// The mock's `computeNotices()` (BasecampUI.jsx) is the reference for WHAT
// deserves attention. This is that rule set against the real schema.
//
// Deliberately a **leaf module**: no imports, no resource, no client. It takes
// rows and returns notices, so it runs in plain node and is testable without a
// browser or a server — the same reason `sierra/src/junction/field-rules.js`
// is written this way. Every screen and the shell call the same function, so
// "needs attention" cannot mean two different things in two places.
//
// Times are parsed with Date.parse: litestone emits DateTime as ISO-8601 TEXT,
// never epoch-ms (CLAUDE.md § Live hazards).

export const PRIORITY_ORDER = { critical: 0, warning: 1, info: 2 }

// Tone, not colour — repo invariant 13. These map onto @frontierjs/css tones,
// so the mock's T.red / T.amber / T.blue never appear here.
export const PRIORITY_TONE = { critical: 'danger', warning: 'warning', info: 'info' }

const MINUTE = 60_000
const HEARTBEAT_OVERDUE_MS = 10 * MINUTE
const DEPLOY_STUCK_MS      = 15 * MINUTE
const CPU_WARN             = 85   // percent — the mock's thresholds
const MEM_CRITICAL         = 90

// A deployment in one of these has started and not finished.
const DEPLOY_IN_FLIGHT = ['building', 'pushing', 'deploying']

function ageLabel(ms) {
  if (!Number.isFinite(ms)) return 'unknown'
  const mins = Math.round(ms / MINUTE)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function since(iso, now) {
  const t = Date.parse(iso ?? '')
  return Number.isNaN(t) ? null : now - t
}

/**
 * @param {{servers?: object[], deployments?: object[], jobs?: object[]}} rows
 * @param {number} now epoch ms — passed in, never read from the clock, so a
 *   test can pin it and the result is a pure function of its inputs.
 * @returns {Array<{id, priority, category, title, detail, href, action}>}
 *   sorted critical → warning → info.
 */
export function computeNotices({ servers = [], deployments = [], jobs = [] } = {}, now = Date.now()) {
  const out = []
  const add = (n) => out.push(n)

  // ── Fleet ────────────────────────────────────────────────────────────────
  for (const s of servers) {
    if (s.status === 'unreachable') {
      add({
        id: `server-unreachable-${s.id}`, priority: 'critical', category: 'fleet',
        title: `${s.name} is unreachable`,
        detail: 'The outpost has not responded. Check the server or restart the outpost.',
        href: `/servers/${s.id}/`, action: 'View server',
      })
      continue  // an unreachable server's heartbeat being stale is the same fact
    }

    const beat = since(s.lastHeartbeatAt, now)
    if ((s.status === 'online' || s.status === 'ready') && beat !== null && beat > HEARTBEAT_OVERDUE_MS) {
      add({
        id: `server-heartbeat-${s.id}`, priority: 'warning', category: 'fleet',
        title: `${s.name} heartbeat overdue`,
        detail: `Last seen ${ageLabel(beat)} — it may have lost the outpost connection.`,
        href: `/servers/${s.id}/`, action: 'View server',
      })
    }

    // Pressure. `Server.health` is written by servers.heartbeat from whatever
    // the outpost reported — see the note at the foot of this file about the
    // shape not being declared anywhere.
    const cpu = Number(s.health?.cpu)
    if (Number.isFinite(cpu) && cpu >= CPU_WARN) {
      add({
        id: `server-cpu-${s.id}`, priority: 'warning', category: 'fleet',
        title: `${s.name} CPU at ${Math.round(cpu)}%`,
        detail: 'Sustained high CPU will show up as latency in the apps on it.',
        href: `/servers/${s.id}/`, action: 'View server',
      })
    }

    const mem = Number(s.health?.memory)
    if (Number.isFinite(mem) && mem >= MEM_CRITICAL) {
      add({
        id: `server-mem-${s.id}`, priority: 'critical', category: 'fleet',
        title: `${s.name} memory at ${Math.round(mem)}%`,
        detail: 'Risk of an OOM kill. Scale up or move workloads off it.',
        href: `/servers/${s.id}/`, action: 'View server',
      })
    }

    if (s.status === 'draining') {
      add({
        id: `server-draining-${s.id}`, priority: 'info', category: 'fleet',
        title: `${s.name} is still draining`,
        detail: 'Undrain it once its workloads have migrated.',
        href: `/servers/${s.id}/`, action: 'Manage server',
      })
    }
  }

  // ── Deployments ──────────────────────────────────────────────────────────
  for (const d of deployments) {
    if (d.status === 'failed') {
      add({
        id: `deploy-failed-${d.id}`, priority: 'critical', category: 'deploy',
        title: `Deploy failed${d.commitSha ? ` at ${d.commitSha.slice(0, 7)}` : ''}`,
        detail: d.commitMessage ?? 'The release did not reach the environment.',
        href: `/deployments/${d.id}/`, action: 'View deploy',
      })
    }

    if (DEPLOY_IN_FLIGHT.includes(d.status)) {
      // startedAt is null until the job picks it up, so fall back to
      // queuedAt — a release stuck IN THE QUEUE is the more alarming of the two.
      const age = since(d.startedAt ?? d.queuedAt, now)
      if (age !== null && age > DEPLOY_STUCK_MS) {
        add({
          id: `deploy-stuck-${d.id}`, priority: 'warning', category: 'deploy',
          title: `Deploy has been ${d.status} for ${ageLabel(age)}`,
          detail: 'It may be stuck on a step.',
          href: `/deployments/${d.id}/`, action: 'View progress',
        })
      }
    }
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────
  for (const j of jobs) {
    if (j.status === 'failed') {
      add({
        id: `job-failed-${j.id}`, priority: 'critical', category: 'job',
        title: `Job failed: ${j.name}`,
        detail: j.lastRunAt ? `Last run ${ageLabel(since(j.lastRunAt, now))}.` : 'It has not completed.',
        href: `/jobs/${j.id}/`, action: 'View job',
      })
    } else if (j.lastRunStatus === 'failed') {
      // The job itself is fine — its last RUN was not. A scheduled job that
      // fails every night and is retried back to pending looks healthy here
      // unless the run history is read.
      add({
        id: `job-lastrun-${j.id}`, priority: 'warning', category: 'job',
        title: `Last run failed: ${j.name}`,
        detail: j.lastRunAt ? `${ageLabel(since(j.lastRunAt, now))}.` : 'See the run history.',
        href: `/jobs/${j.id}/`, action: 'View runs',
      })
    }
  }

  return out.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
}

/** Counts for the badges the shell and the sidebar show. */
export function noticeCounts(notices) {
  return {
    total:    notices.length,
    critical: notices.filter(n => n.priority === 'critical').length,
    warning:  notices.filter(n => n.priority === 'warning').length,
  }
}

// ── What the mock computes that this cannot ────────────────────────────────
//
// Recorded here rather than dropped silently. Each is a DATA gap, not a UI one
// (docs/SCREENS.md § Gaps found while building the shell):
//
//   CPU / memory pressure IS implemented above, but on an undeclared shape.
//   `Server.health` is `Json?` in the schema and `Record<string, unknown>` in
//   `HeartbeatData` — nothing anywhere says the keys are `cpu` and `memory`.
//   That spelling is the de-facto contract because it is what `web/test/
//   verify.mjs` posts and what `servers/[id]` renders; an outpost sending `mem`
//   would satisfy both types and silently never raise a notice. The fix is a
//   declared health shape, not a rule here. `db/seed.js` also writes no health
//   at all, so a seeded fleet raises no pressure notices.
//
//   SSL certificates expiring / expired — needs a Domain model with a cert
//   status. `App.domain` is one nullable string.
//
//   Firing alert rules — `AlertRule` and `AlertEvent` are in the schema with
//   no service over them, so nothing can read them from the browser.
//
//   Disk pressure / cleanup — no model at all.
