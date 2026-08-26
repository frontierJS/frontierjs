// site/src/routes/landscape.meta.js — the related-projects register, built.
//
// `website/projects.json` is checked-in data, so it is read at BUILD time and
// baked in. The hand-written page fetched it, which cost a round trip, an error
// path, and — because a `file://` fetch is blocked — a whole branch explaining
// that the page could not be opened from disk. None of that survives here.
//
// The register and the twenty-one detail cards are prerendered; only the word
// cloud is built at runtime, because it is packed by measurement.

import data from '../../../projects.json' with { type: 'json' }

// Tier is 1 (nearest) → 3 (furthest), so it is inverted into a magnitude the
// cloud can size by. The other two are already 0–100.
const PROXIMITY = { 1: 100, 2: 60, 3: 25 }

export const FACTORS = [
  { key: 'closeness',   label: 'how close it is',
    help: 'How literally similar the code and vocabulary are.' },
  { key: 'inspiration', label: 'how much was taken',
    help: 'How much of it actually ended up in FrontierJS.' },
  { key: 'proximity',   label: 'how near the thesis',
    help: 'Tier — 1 is the same argument, 3 is a mental-model ancestor.' },
]

export async function load() {
  const stances = data.scales?.stance ?? {}
  // "Taken as it is — same shape, same vocabulary" → a chip label and its help.
  const label = (k) => (stances[k] ?? k).split('—')[0].trim()
  const help  = (k) => (stances[k] ?? '').split('—').slice(1).join('—').trim()

  const projects = (data.projects ?? []).map((p) => ({
    ...p,
    proximity:   PROXIMITY[p.tier] ?? 25,
    stanceLabel: label(p.stance),
    stanceHelp:  help(p.stance),
    host:        hostOf(p.url),
  }))

  const counts = {}
  for (const p of projects) counts[p.stance] = (counts[p.stance] ?? 0) + 1

  return {
    projects,
    factors: FACTORS,
    // The file's own scale order, so the filter row never reshuffles.
    stances: [
      { key: 'all', label: 'All', help: '', n: projects.length },
      ...Object.keys(stances)
        .filter((k) => counts[k])
        .map((k) => ({ key: k, label: label(k), help: help(k), n: counts[k] })),
    ],
  }
}

function hostOf(u) {
  try { return new URL(u).host.replace(/^www\./, '') } catch { return u }
}
