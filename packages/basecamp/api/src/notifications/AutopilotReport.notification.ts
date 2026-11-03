// src/notifications/AutopilotReport.notification.ts — the morning after the loops.
//
// Every number is counted at send time by `jobs/autopilot-report.job.ts` off
// the loops' own log lines and the lanes directory (`domain/atlas/
// autopilot-report.ts`), the way the weekly digest counts its week: nothing is
// stored, so a re-run says what the logs say now. The window is the 24 hours
// before the send, half-open, and the day figures are the schedule's own
// calendar day against ~/.fli/autopilot.json's cap -- two different periods,
// each named for what it is, because the night's runs fall in both and a
// hand run yesterday evening falls in one.

import { defineNotification, inApp, mail } from '@frontierjs/notifications'
import { declaredTransports, appUrl }      from './_shared.ts'

export interface AutopilotReportPayload {
  /** ISO instants, inclusive start and exclusive end. */
  from:    string
  to:      string
  /** The switch as the file read at send time. */
  on:      boolean
  /** fix attempts and frame runs started in the window. */
  ran:     number
  closed:  number
  blocked: number
  /** Every other finished fix attempt: failed, busy, corrected. */
  failed:  number
  /** Questions a frame run framed. */
  framed:  number
  /** Dollars the window's finished runs cost. */
  spend:   number
  /** Today's scheduled runs against the day cap; a cap is null while unset. */
  day:     { attempts: number, dollars: number, capAttempts: number | null, capDollars: number | null }
  /** Patches waiting on the Dock. */
  patches: number
  /** The last tick's instant, or null where the tick job has never run. */
  tick:    string | null
  /** `loop-review`'s last report: when it was written and the lines under its headings that name a repeat. */
  review:  { modified: string, repeated: string[] } | null
}

const n     = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const money = (d: number) => `$${d.toFixed(2)}`
const when  = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** The one sentence, so the in-app line and the email's first line cannot drift. */
export function summary(p: AutopilotReportPayload): string {
  if (!p.ran) return p.tick ? `Nothing ran. Last tick ${when(p.tick)}.` : 'Nothing ran, and the tick job has never run.'
  const bits = [n(p.ran, 'run'), `${p.closed} closed`, p.blocked ? `${p.blocked} blocked` : null, p.failed ? `${p.failed} failed` : null, p.framed ? `${p.framed} framed` : null, money(p.spend)]
  return bits.filter(Boolean).join(' · ')
}

function dayLine(p: AutopilotReportPayload): string {
  const d   = p.day ?? { attempts: 0, dollars: 0, capAttempts: null, capDollars: null }
  const cap = d.capAttempts != null && d.capDollars != null ? ` of the day's ${n(d.capAttempts, 'attempt')} and ${money(d.capDollars)}` : ', no day cap set'
  return `Today's scheduled runs: ${n(d.attempts ?? 0, 'attempt')}, ${money(d.dollars ?? 0)}${cap}.`
}

export default defineNotification<AutopilotReportPayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title(`Autopilot overnight${p.on ? '' : ' (Off)'}`)
    .body(`${summary(p)} ${n(p.patches, 'patch')} on the Dock.`)
    .action('Open the town', '/atlas/autopilot/')
    .data({ ...p }),

  email: (p) => mail()
    .subject(`Autopilot overnight — ${summary(p)}`)
    .line(`${when(p.from)} to ${when(p.to)}. Autopilot is ${p.on ? 'On' : 'Off'}.`)
    .line(summary(p))
    .line(dayLine(p))
    .line(`${n(p.patches, 'patch')} on the Dock; applying one is yours.`)
    .line(p.review
      ? `The Review (${when(p.review.modified)}) says repeated:\n${p.review.repeated.map(l => `- ${l}`).join('\n') || '- nothing yet'}`
      : 'No Review has been written yet (bun run loop:review).')
    .action('Open the town', appUrl('/atlas/autopilot/')),
})
