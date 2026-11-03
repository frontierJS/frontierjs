// src/notifications/AutopilotAsk.notification.ts — a ruling asked of the owner.
//
// Sent by `domain/atlas/autopilot-post.ts` for a decidable question nobody has
// asked yet. The buttons are decided there, not here (`buttonsFor`): which of
// them may rule depends on the ntfy rung and the paper's recommendation, and a
// formatter that guessed would put a ruling button on a public topic. This
// file only draws what it is handed. A payload carries no secret (the
// notifications package's rule), and the reply a ruling button posts is
// `{id, letter}` and nothing else.

import { defineNotification, inApp, push, type PushAction } from '@frontierjs/notifications'

export interface AutopilotAskPayload {
  id:        string
  question:  string
  /** The paper's recommendation; `letter` alone does not make it a button, the qualifier does. */
  recommend: { letter: string, text: string } | null
  options:   Array<{ letter: string, text: string }>
  file:      string
  line:      number
  buttons:   PushAction[]
}

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one
}

/** The one sentence, so the in-app line and the push body cannot drift. */
export function summary(p: AutopilotAskPayload): string {
  const letters = p.options.map(o => o.letter).join(', ')
  return p.recommend ? `Options ${letters}. Recommended: ${p.recommend.letter} — ${clip(p.recommend.text, 100)}` : `Options ${letters}. No recommendation.`
}

export default defineNotification<AutopilotAskPayload>({
  via: () => ['inApp', 'push'],

  inApp: (p) => inApp()
    .title(`Ruling asked: ${clip(p.question, 80)}`)
    .body(`${p.id} · ${summary(p)}`)
    .action('Open the bench', '/atlas/decide/')
    .data({ ...p }),

  push: (p) => {
    const msg = push()
      .title(`Ruling asked: ${clip(p.question, 80)}`)
      .body(`${p.id} · ${summary(p)}`)
      .tags('scales')
    for (const b of p.buttons) b.body === undefined ? msg.action(b.label, b.url) : msg.post(b.label, b.url, b.body)
    // A tap on the body goes where the Open button does; the first view button is that link.
    const open = p.buttons.find(b => b.body === undefined)
    if (open) msg.url(open.url)
    return msg.build()
  },
})
