// site/src/routes/showroom2.meta.js — the walkthrough's fifteen steps, built.
//
// Every step is highlighted here and every one is in the emitted page. The
// hand-written version rendered one step at a time from JavaScript, so the file
// a crawler read contained none of the fifteen files the walkthrough is about.

import { ACTS, STEPS } from '../data/showroom2.js'
import { line, block, langFor } from '../data/code.js'

export async function load() {
  const actOf = (id) => ACTS.find((a) => a.id === id)
  const short = (pkg) => pkg.replace('@frontierjs/', '')

  return {
    acts: ACTS.map((a) => ({
      ...a,
      pkgShort: short(a.pkg),
      // The rail groups steps under their act, and a step's number is its
      // index in the WHOLE list — that is what the counter and the hash mean.
      steps: STEPS.map((s, n) => ({ n, title: s.title, act: s.act }))
        .filter((s) => s.act === a.id),
    })),
    steps: STEPS.map((s, n) => {
      const a = actOf(s.act)
      return {
        n,
        title:  s.title,
        say:    s.say,
        file:   s.file,
        act:    a.name,
        tone:   a.tone,
        pkg:    short(a.pkg),
        // One node per line — the step lights the ones that are new.
        lines:  s.code.map((l, i) => ({ html: line(l, langFor(s.file)), fresh: s.fresh.includes(i) })),
        nocode: s.nocode ?? null,
        rlabel: s.rlabel,
        result: block(s.result, s.rlang ?? 'js'),
      }
    }),
    total: STEPS.length,
  }
}
