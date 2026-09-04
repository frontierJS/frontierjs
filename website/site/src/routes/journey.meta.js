// site/src/routes/journey.meta.js — the journey board, built.
//
// The seventeen steps, the two nodes, the key and all seventeen explanations
// are in the emitted page. What cannot be prerendered is the connectors: they
// are measured from where the boxes actually land, so the island draws them at
// mount and again on resize.

import { T, STEPS, NODES } from '../data/journey.js'

export async function load() {
  return {
    steps: STEPS.map((s, i) => ({
      i,
      n:    i + 1,
      lane: s.lane,
      row:  s.row,
      tint: T[s.tone],
      t:    s.t,
      f:    s.f,
      what: s.what,
      why:  s.why,
    })),
    nodes: NODES.map((n) => ({ lane: n.lane, row: n.row, t: n.t, s: n.s })),
    key: [
      ['Transport boundary', T.transport], ['Framework core', T.core],
      ['Data boundary', T.data], ['SQL', T.sql], ['Event / channel', T.event],
    ].map(([label, color]) => ({ label, color })),
    total: STEPS.length,
  }
}
