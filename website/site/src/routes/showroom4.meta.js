// site/src/routes/showroom4.meta.js — the loop's six phases, built.
//
// Every phase, its terminal transcript, its facts and its packages are in the
// emitted page. The hand-written version rendered one at a time from
// JavaScript, so the transcripts — which are the page — were in no file.

import { PHASES } from '../data/showroom4.js'
import { esc } from '../data/code.js'

export async function load() {
  return {
    phases: PHASES.map((p) => ({
      id:    p.id,
      n:     p.n,
      t:     p.t,
      s:     p.s,
      badge: p.badge,
      tone:  p.tone,
      say:   p.say,
      // Escaped here rather than interpolated in the page: a transcript line is
      // shell text and may hold a `<`. `&nbsp;` keeps a blank line's height.
      term:  p.term.map(([kind, text]) => ({ kind, html: esc(text) || '&nbsp;' })),
      facts: p.facts.map(([b, t]) => ({ b, t })),
      pkgs:  p.pkgs,
    })),
    first: PHASES[0].id,
  }
}
