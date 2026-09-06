// tiers.js — which corpus fixtures exist, and on whose machine.
//
// The corpus is real schemas nobody here wrote, and it arrives three ways. The
// distinction is not bookkeeping: it decides what a test may DEMAND, because a
// fixture that is downloaded on request is absent on every fresh clone and
// present on every machine that has ever run `fetch.mjs`.
//
// A roster written twice is how that goes wrong quietly. `introspect-roundtrip`
// held its own copy, mixed the tiers together and asked for eight of them — a
// count only reachable with the fetched pair present, so the suite passed for
// everyone here and could not pass on a runner at all, which is the whole of
// why CI had never gone green (`FJS-009`). The same copy had drifted the other
// way too: `hrms` is committed and its list never named it, so nothing swept it.
//
//   committed — in git. Every clone has these, so a floor may be built on them.
//   fetched   — `bun fetch.mjs`, needs the network. Swept when present, skipped
//               BY NAME when not; never counted toward a floor.
//   local     — a private schema converted by hand that nobody else can
//               regenerate. Read from `$FJS_CORPUS_LOCAL` when the tree does not
//               hold it, so a source file `.gitignore` would have to hide stays
//               out of the tree and the target still runs.
//
// `fixtures/corpus/README.md` § What is committed says why the split falls where
// it does. Adding a fixture means adding it HERE, and both readers pick it up.

export const COMMITTED = ['triggerdev', 'discourse', 'mastodon', 'lago', 'erpnext', 'hrms']
export const FETCHED   = ['calcom', 'documenso']
export const LOCAL     = ['maidtech']

// `fixtures/scale/openmrp.lite` is committed and is not corpus: it asks whether
// the Data realm survives SIZE, where the corpus asks whether it survives shapes
// this project did not invent. It is listed here because the round-trip property
// runs over both, and a floor that forgot it would be one fixture loose.
export const SCALE = ['openmrp']
