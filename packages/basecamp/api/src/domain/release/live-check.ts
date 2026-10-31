// src/domain/release/live-check.ts — why is this App not live.
//
// Pure: no database, no DNS, no fetch. `apps.service.ts`'s `liveCheck` reads
// the rows and hands in two lookups; this module decides in what order to ask
// and what each answer means (`domain/monitor/probe.ts` is the same split).
//
// ─── Why a chain that stops ──────────────────────────────────────────────
//
// An App that is not live has several causes stacked, and each hides the next:
// a hostname with no DNS record has no certificate (the ACME challenge cannot
// resolve it), and a hostname with no certificate cannot say what its App
// answers. Reporting all three at once names two causes that are only symptoms.
// So a chain is walked in order, stops at the first `fail`, and the steps after
// it are `skip`, saying which step they wait on.
//
// There are two chains. The App-wide one (a release succeeded, a machine takes
// the traffic) failing means no hostname can be live, so every hostname's chain
// is skipped without being asked. Each hostname then has its own: ingress zone,
// public DNS, HTTPS. The lookups are passed as functions so a chain that stops
// never makes the request a skipped step would have made.

export type StepStatus = 'pass' | 'fail' | 'warn' | 'skip'

export interface StepFix { href: string; label: string }

export interface LiveStep {
  key:    string
  label:  string
  status: StepStatus
  detail: string
  fix:    StepFix | null
}

/** What a public resolver answered for a hostname. `nxdomain` is the name not
 *  existing, which is its own case: it is the cause, where `error` is only a
 *  lookup that did not finish. */
export type DnsAnswer =
  | { addresses: string[] }
  | { nxdomain: true }
  | { error: string }

/** What `GET https://host/` produced: a status line, or why it never got one. */
export type HttpsAnswer =
  | { status: number }
  | { error: string }

export interface LiveHost {
  hostname:   string
  redirectTo: string | null
  proxied:    boolean
  /** Asked only when the step before it passed or warned. */
  dns:        () => Promise<DnsAnswer>
  https:      () => Promise<HttpsAnswer>
}

export interface LiveFacts {
  /** The App's newest Deployment, or null when it has never been released. */
  release:   { status: string } | null
  /** `servingAddresses` — the online machines holding a running placement. */
  addresses: string[]
  /** Why a push would be refused for want of an ingress zone, or null. */
  ingress:   string | null
  hosts:     LiveHost[]
}

export interface LiveHostResult {
  hostname:   string
  redirectTo: string | null
  steps:      LiveStep[]
}

export interface LiveCheck {
  /** `live` only when every step of every chain passed; `warn` when none failed. */
  status: 'live' | 'warn' | 'down'
  steps:  LiveStep[]
  hosts:  LiveHostResult[]
}

const step = (key: string, label: string, status: StepStatus, detail: string, fix: StepFix | null = null): LiveStep =>
  ({ key, label, status, detail, fix })

const skipped = (key: string, label: string, waitingOn: string): LiveStep =>
  step(key, label, 'skip', `waiting on ${waitingOn}`)

const RELEASES: StepFix = { href: '?tab=releases', label: 'Open releases' }
const SERVERS:  StepFix = { href: '/servers/',      label: 'Open servers' }
const DNS:      StepFix = { href: '/dns/',          label: 'Open DNS' }
const DOMAINS:  StepFix = { href: '?tab=domains',   label: 'Open domains' }

export function gradeRelease(release: LiveFacts['release']): LiveStep {
  const label = 'Release'
  if (!release) return step('release', label, 'fail', 'This App has never been released.', RELEASES)
  if (release.status === 'success') return step('release', label, 'pass', 'The latest release succeeded.')
  return step('release', label, 'fail', `The latest release is ${release.status}, not success.`, RELEASES)
}

export function gradePlacement(addresses: string[]): LiveStep {
  const label = 'Placement'
  if (!addresses.length)
    return step('placement', label, 'fail',
      'The App runs on no online machine — nothing is serving it.', SERVERS)
  return step('placement', label, 'pass', `Served from ${addresses.join(', ')}.`)
}

export function gradeZone(ingress: string | null): LiveStep {
  const label = 'Ingress zone'
  if (ingress) return step('zone', label, 'fail', ingress, DNS)
  return step('zone', label, 'pass', 'The workspace has an ingress zone to publish records in.')
}

/**
 * A proxied hostname answers from the vendor's own addresses, so any answer
 * proves the record exists; an unproxied one must point at the machines that
 * serve the App, and a record that exists but points elsewhere is a warning
 * naming both sides rather than a failure, since the lookup itself worked.
 */
export function gradeDns(answer: DnsAnswer, proxied: boolean, addresses: string[]): LiveStep {
  const label = 'DNS'
  if ('nxdomain' in answer)
    return step('dns', label, 'fail', 'No record — nothing points this name anywhere.', DNS)
  if ('error' in answer)
    return step('dns', label, 'warn', `The public lookup did not finish: ${answer.error}.`, DNS)
  const have = [...answer.addresses].sort()
  if (!have.length)
    return step('dns', label, 'fail', 'The name exists but has no address record.', DNS)
  if (proxied)
    return step('dns', label, 'pass', `Resolves to ${have.join(', ')} (proxied — the vendor's addresses, not the machine's).`)
  if (have.some(a => addresses.includes(a)))
    return step('dns', label, 'pass', `Resolves to ${have.join(', ')}.`)
  return step('dns', label, 'warn',
    `Resolves to ${have.join(', ')} but the App is served from ${addresses.join(', ')}.`, DNS)
}

export function gradeHttps(answer: HttpsAnswer): LiveStep {
  const label = 'HTTPS'
  if ('error' in answer)
    return step('https', label, 'fail',
      `${answer.error} — Caddy obtains the certificate only once the name resolves to this machine.`, DOMAINS)
  const code = answer.status
  if (code >= 200 && code < 400) return step('https', label, 'pass', `Answered ${code}.`)
  const hint = code === 404 || code === 405
    ? ' The App may serve only an API (for example under /api) — is a web half deployed?'
    : ''
  return step('https', label, 'warn', `Answered ${code}.${hint}`, RELEASES)
}

/** Steps of a chain, in order, each run only while no earlier one failed. */
async function walk(
  links: Array<{ key: string; label: string; run: () => LiveStep | Promise<LiveStep> }>,
  waitingOn?: string,
): Promise<LiveStep[]> {
  const out: LiveStep[] = []
  let stop = waitingOn
  for (const link of links) {
    if (stop) { out.push(skipped(link.key, link.label, stop)); continue }
    const done = await link.run()
    out.push(done)
    if (done.status === 'fail') stop = done.label
  }
  return out
}

export async function runLiveCheck(facts: LiveFacts): Promise<LiveCheck> {
  const steps = await walk([
    { key: 'release',   label: 'Release',   run: () => gradeRelease(facts.release) },
    { key: 'placement', label: 'Placement', run: () => gradePlacement(facts.addresses) },
  ])
  const blocked = steps.find(s => s.status === 'fail')

  const hosts: LiveHostResult[] = []
  for (const host of facts.hosts) {
    // A redirect domain answers with its target's redirect, not with the App,
    // so it has no chain of its own to grade.
    if (host.redirectTo) {
      hosts.push({ hostname: host.hostname, redirectTo: host.redirectTo, steps: [] })
      continue
    }
    hosts.push({
      hostname:   host.hostname,
      redirectTo: null,
      steps: await walk([
        { key: 'zone',  label: 'Ingress zone', run: () => gradeZone(facts.ingress) },
        { key: 'dns',   label: 'DNS',          run: async () => gradeDns(await host.dns(), host.proxied, facts.addresses) },
        { key: 'https', label: 'HTTPS',        run: async () => gradeHttps(await host.https()) },
      ], blocked?.label),
    })
  }

  const all = [...steps, ...hosts.flatMap(h => h.steps)]
  const status = all.some(s => s.status === 'fail') ? 'down'
    : all.some(s => s.status === 'warn') ? 'warn'
    : 'live'
  return { status, steps, hosts }
}
