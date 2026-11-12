// shared/band.js — the loft's band as sound, target-neutral and pure over the wall
// clock: sample `s` is the same on every screen, so two members in the loft
// hear one beat with nothing sent, the way `sky.js` gives them one sky.
//
// The clock is cut into songs of `SONG_MS`, and song `k` is drawn from `k`:
// each choice — key, progression (grammar or menu), chord colour, tempo, drum feel, and a style for the
// bass, guitar, keys and singer — is picked from a short list of options
// that each work, and `VETO` rerolls the pairings that do not. One song in
// `STRINGS_ODDS` is not the band at all: a slow piece for a bowed voice over
// a pad and a held bass, with no drums or guitar, drawn from a generator of
// its own so the band's songs keep their numbers. What makes any
// draw sound right is what is never drawn: one key for everyone, a
// pentatonic melody that lands on a chord tone each downbeat, and each part
// in its own register. Everything is synthesized; there are no samples.
//
// A song has a form (`song.form`, read by `sectionOf`): an intro, verses and
// choruses, a middle holding a solo, a last chorus and an outro, each a
// section of whole bars with a fill into the next and a level (`VOL`), so a
// song swells and drops. `plays` says which parts sound in a bar, and
// `song.dropouts` are the rows drawn into it. The chorus swaps the guitar's
// and the keys' style for a second pair drawn from `k`, and the singer sings
// the `hook`, two bars drawn once for the song and sung at every chorus: a
// tune is what comes back. Each hit is loosened by a few ms and a few percent,
// odd steps swing by the feel's `swing`, and a snare ghosts on an offbeat, all
// from the bar's own numbers, so every screen loosens alike.
//
// `createBand().samples(from, n)` is what `#sound` pulls, `from` counted from
// the epoch at `RATE`, as `[left, right]`. A bar is rendered whole with `TAIL` bars of ring after
// it (a crash outlasts a fast bar), so a sample is its own bar plus the tails
// of the ones before. A pull also renders one part of the bar after the one
// playing (then the mix and reverb, a pass of its own), so a bar is whole before
// it is needed and no pull pays for a whole bar: five parts and a mix take 19+
// pulls and a bar lasts that many. A song plays whole bars and an ending bar,
// then rests until the next window opens.
//
// A request (`/song 42`, `api/src/setlist.ts`) moves where the count starts:
// a `cue` is song `first` starting at wall-clock `at`, the next one `SONG_MS`
// after it, and the clock's own is song 0 at the epoch. The server picks `at`
// on a bar line of the song playing, far enough ahead that every screen has
// the cue before a sample of it is pulled.

export const RATE    = 44100
export const SONG_MS = 180000

/** The parts, in the order the loft's stage stands them, left to right. */
export const PARTS = ['guitar', 'singer', 'drums', 'bass', 'keys']
const PART = Object.fromEntries(PARTS.map((p, i) => [p, i]))
/** Where each part stands on the stage: -1 is hard left, 1 hard right. */
const PAN  = { guitar: -0.55, singer: -0.12, drums: 0.15, bass: 0.08, keys: 0.55 }
/** What each part sends to the reverb, against its own level: the bass stays dry. */
const SEND = { guitar: 0.30, singer: 0.35, drums: 0.10, bass: 0, keys: 0.28 }

const SONG_N = (SONG_MS / 1000) * RATE
const TAIL   = 2
const BLOCK  = RATE / 100   // 10 ms, the grain `levels` reads a part's loudness at

// ─── the menus ────────────────────────────────────────────────────────────

const M = 'maj'
const m = 'min'

// A chord is [semitones above the tonic, quality, true for a secondary dominant]; `all7` makes every chord a dominant 7.
const PROGRESSIONS = [
  { name: 'aeolian',  mode: m, chords: [[0, m], [8, M], [3, M], [10, M]] },
  { name: 'minor iv', mode: m, chords: [[0, m], [5, m], [10, M], [3, M]] },
  { name: 'dorian',   mode: m, chords: [[0, m], [5, M], [0, m], [5, M]] },
  { name: 'epic',     mode: m, chords: [[0, m], [10, M], [8, M], [10, M]] },
  { name: 'pop',      mode: M, chords: [[0, M], [7, M], [9, m], [5, M]] },
  { name: 'doo-wop',  mode: M, chords: [[0, M], [9, m], [5, M], [7, M]] },
  { name: 'two-five', mode: M, chords: [[2, m], [7, M], [0, M], [0, M]] },
  { name: 'blues',    mode: M, all7: true, chords: [0, 0, 0, 0, 5, 5, 0, 0, 7, 5, 0, 7].map((d) => [d, M]) },
]
const BLUES = PROGRESSIONS[PROGRESSIONS.length - 1].chords
const KEYS   = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const TEMPOS = [84, 92, 100, 108, 116, 124]
const SCALES = { [M]: [0, 2, 4, 7, 9], [m]: [0, 3, 5, 7, 10] }

const euclid = (k, n, rot = 0) => Array.from({ length: n }, (_, i) => (((i + rot) * k) % n) < k)
const steps  = (bools) => bools.flatMap((on, i) => (on ? [i] : []))
const EIGHTS = [0, 2, 4, 6, 8, 10, 12, 14]

// `swing` is how far an odd step is pushed late, in steps.
const FEELS = [
  { name: 'tresillo', kick: steps(euclid(3, 8).concat(euclid(3, 8))), snare: [4, 12], hat: steps(euclid(7, 16, 2)), open: [14], swing: 0.12 },
  { name: 'rock',     kick: [0, 8, 10],     snare: [4, 12], hat: EIGHTS, open: [],             swing: 0 },
  { name: 'disco',    kick: [0, 4, 8, 12],  snare: [4, 12], hat: [],     open: [2, 6, 10, 14], swing: 0 },
  { name: 'half-time', kick: [0, 10],       snare: [8],     hat: EIGHTS, open: [14],           swing: 0.15 },
  { name: 'bossa',    kick: [0, 3, 8, 11],  rim: [0, 3, 6, 10, 12],      hat: EIGHTS, open: [], swing: 0.08 },
]
const BASSES  = ['on the kick', 'eighths', 'walking']
const BASS_VOICES = ['round', 'growl']
const VOICES  = ['soprano', 'alto', 'tenor']
const VOWELS  = ['a', 'e', 'i', 'o', 'u']
const GUITARS = ['arpeggio', 'running', 'strummed']
const KEYSETS = ['stabs', 'backbeat', 'pad']
// What a chord adds to its triad: nothing, a seventh, a ninth, or a 2nd or 4th held for half a bar over the third.
const COLOURS = ['none', 'sevenths', 'add9', 'sus']
// The slow piece (`ensemble: 'strings'`): the tempos and progressions a band's
// song is never drawn at, and a singer who holds a note a bar or two.
const STRINGS_ODDS = 0.15
const SLOW_TEMPOS  = [54, 60, 66, 72]
const LAMENTS      = PROGRESSIONS.filter((p) => p.name !== 'blues')
const BOWED        = { name: 'bowed', phrases: [[[0, 6], [6, 2], [8, 8]], [[0, 8], [8, 4], [12, 4]], [[0, 12], [12, 4]]] }
const SINGERS = [
  { name: 'busy',  phrases: [[[0, 4], [4, 2], [6, 2], [8, 6]], [[0, 2], [2, 2], [4, 8]]] },
  { name: 'long',  phrases: [[[0, 6], [8, 6]], [[0, 4], [4, 4], [8, 8]]] },
  { name: 'call',  phrases: [[[0, 2], [2, 2], [4, 2], [6, 2]], [[8, 8]]] },
]
const LONG = SINGERS[1]   // the bridge's singer, whoever the song's is

/** Each section's level; the intro climbs to its own over its four bars, the outro falls from the last chorus's to its own. */
const VOL = { intro: 0.9, verse: 0.9, prechorus: 1, chorus: 1, bridge: 0.72, breakdown: 0.8, solo: 0.95, last: 1, outro: 0.6 }

// What a stop's silence is filled with and the soloist's pick.
const FILLERS   = ['drums', 'bass', 'keys', 'singer']
const SOLOISTS  = ['guitar', 'keys', 'bass', 'singer']
// every middle holds a solo: a song without one would leave nobody standing alone
const MIDDLES   = [['solo'], ['bridge', 'solo'], ['breakdown', 'solo']]
const FORM_CODE = { intro: 'I', verse: 'V', prechorus: 'P', chorus: 'C', bridge: 'B', breakdown: 'K', solo: 'S', last: 'L', outro: 'O' }

// Pairings that draw a song nobody would keep.
const VETO = [
  (s) => s.feel.name === 'half-time' && s.bpm < 100,   // a crawl
  (s) => s.feel.name === 'disco' && s.bpm < 100,
  (s) => s.bass === 'walking' && s.bpm > 116,           // a scramble
  (s) => s.progression.name === 'blues' && s.feel.name === 'disco',
]

const ADJECTIVES = ['Rusty', 'Copper', 'Velvet', 'Crooked', 'Lantern', 'Midnight', 'Hollow', 'Salt', 'Amber', 'Last', 'Low', 'Silver']
const NOUNS      = ['Moon', 'Lantern', 'Road', 'Kettle', 'Harbor', 'Stair', 'Rain', 'Barrel', 'Fiddle', 'Ferry', 'Hour', 'Candle']

// ─── a song, drawn ────────────────────────────────────────────────────────

function rng(seed) {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)]
const shuffle = (rand, list) => {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// ─── a progression, drawn ─────────────────────────────────────────────────

// A phrase runs tonic, subdominant, dominant, tonic (Rohrmeier 2011), each region one chord or two,
// so a phrase is 4 or 8 chords. A menu entry is kept one song in `MENU_ODDS`; the blues is always rewritten.
const MENU_ODDS = 1 / 3
const maj = (d) => [d, M]
const min = (d) => [d, m]
const PHRASES = {
  [M]: {
    tonic: { one: [maj(0), maj(0), maj(0), min(9), min(4)], two: [[maj(0), min(9)], [maj(0), min(4)], [min(9), maj(0)]] },
    sub:   { one: [maj(5), maj(5), min(2)],                 two: [[min(9), maj(5)], [min(2), maj(5)], [maj(5), min(2)]] },
    dom:   { one: [maj(7)],                                 two: [[maj(7), maj(7)]] },
    end:   { one: [maj(0), maj(0), min(9)],                 two: [[maj(0), maj(0)], [maj(0), min(9)]] },
  },
  [m]: {
    tonic: { one: [min(0), min(0), min(0), maj(3), maj(8)], two: [[min(0), maj(3)], [min(0), maj(8)], [min(0), min(0)]] },
    sub:   { one: [min(5), min(5), maj(8), maj(10)],        two: [[min(5), maj(8)], [maj(8), min(5)], [min(5), maj(10)]] },
    dom:   { one: [maj(7), maj(7), min(7), maj(10)],        two: [[maj(7), maj(7)], [min(7), maj(7)], [maj(10), maj(7)]] },
    end:   { one: [min(0), min(0), maj(8)],                 two: [[min(0), min(0)], [maj(3), min(0)]] },
  },
}
// A substitution at the phrase's end answers `[index, chord]`, or null where it does not fit; `r` holds where
// the subdominant (`d - 1` is its last chord), dominant and last tonic regions start. A V/x is flagged `true`.
const SUBS = {
  [M]: [
    (c, r) => (c[r.t - 1][0] === 7 ? [r.t - 2, [2, M, true]] : null),
    (c, r) => {
      for (let i = r.t - 1; i > 0; i--) if (c[i + 1][0] === 9 && c[i + 1][1] === m) return [i, [4, M, true]]
      return null
    },
    (c, r) => [r.d - 1, maj(10)],
    (c, r) => (c[r.d - 1][0] === 5 && c[r.d - 1][1] === M ? [r.d - 1, min(5)] : null),
    (c, r, rand) => (c[r.t - 1][0] === 7 ? [r.t - 1, maj(pick(rand, [8, 4]))] : null),
  ],
  [m]: [
    (c, r) => (c[r.t - 1][0] === 7 && c[r.t - 1][1] === M ? [r.t - 2, [2, M, true]] : null),
  ],
}

const NUMERALS = ['I', 'bII', 'II', 'bIII', 'III', 'IV', '#IV', 'V', 'bVI', 'VI', 'bVII', 'VII']
const numeral  = ([deg, q, dom]) => (q === m ? NUMERALS[deg].toLowerCase() : NUMERALS[deg]) + (dom ? '7' : '')

// The blues' rewrites (Steedman 1984), over today's twelve bars: each group is one place and its variants,
// `[name, first bar, chords]`.
const BLUES_REWRITES = [
  [['quick change', 1, [maj(5)]]],
  [['ii–V', 8, [min(2), maj(7)]], ['V–V', 8, [maj(7), maj(7)]]],
  [['vi', 7, [min(9)]], ['VI7', 7, [maj(9)]]],
  [['no turnaround', 10, [maj(0), maj(0)]]],
]

// One object a phrase, so the voicing table built for it is found again when its song is drawn again.
const DRAWN = new Map()
const drawn = (key, make) => {
  if (!DRAWN.has(key)) DRAWN.set(key, make())
  return DRAWN.get(key)
}

function phraseOf(rand, mode) {
  const g       = PHRASES[mode]
  const two     = rand() < 0.5
  const regions = ['tonic', 'sub', 'dom', 'end'].map((kind) => {
    const e = pick(rand, g[kind][two ? 'two' : 'one'])
    return (two ? e : [e]).map((c) => [...c])
  })
  const chords  = regions.flat()
  const r       = { d: regions[0].length + regions[1].length, t: chords.length - regions[3].length }
  const touched = new Set()
  const want    = pick(rand, [0, 1, 1, 2])
  for (const sub of shuffle(rand, SUBS[mode])) {
    if (touched.size >= want) break
    const hit = sub(chords, r, rand)
    if (!hit || touched.has(hit[0])) continue
    touched.add(hit[0])
    chords[hit[0]] = hit[1]
  }
  return drawn(chords.map(numeral).join('–'), () => ({ name: chords.map(numeral).join('–'), mode, chords }))
}

function bluesOf(rand) {
  const groups = shuffle(rand, BLUES_REWRITES).slice(0, 1 + Math.floor(rand() * 3))
  const made   = groups.map((g) => pick(rand, g)).sort((a, b) => a[1] - b[1])
  const names  = made.map(([name]) => name)
  return drawn(`blues ${names}`, () => {
    const chords = BLUES.map((c) => [...c])
    for (const [, at, list] of made) list.forEach((c, i) => { chords[at + i] = [...c] })
    return { name: 'blues', mode: M, all7: true, rewrites: names, chords }
  })
}

/** The song's progression: `start`, the menu's pick, kept one song in `MENU_ODDS`, else a phrase of its mode; the blues is rewritten. */
function progressionOf(rand, start) {
  const keep = rand() < MENU_ODDS
  if (start.name === 'blues') return bluesOf(rand)
  return keep ? start : phraseOf(rand, start.mode)
}

/** The count with nothing requested: song `k` fills window `k` of the clock. */
export const CLOCK = { first: 0, at: 0 }

/** The highest song number a request may name; `Math.imul` seeds take no more. */
export const MAX_SONG = 2 ** 31 - 1

/** The song playing at wall-clock `ms` under `cue`. */
export const songAt = (ms, cue = CLOCK) => cue.first + Math.floor((ms - cue.at) / SONG_MS)

/** When song `k` of `cue`'s count starts, in wall-clock ms. */
export const startOf = (k, cue = CLOCK) => cue.at + (k - cue.first) * SONG_MS

/** The cue that starts song `k` on the first bar line of `cue`'s song at or after `ms`. */
export function cueAt(ms, k, cue = CLOCK) {
  const now   = songOf(songAt(ms, cue))
  const start = startOf(now.k, cue)
  const barMs = (now.barN / RATE) * 1000
  return { first: k, at: Math.ceil(start + Math.ceil((ms - start) / barMs) * barMs) }
}

/** Song `k`: every choice, its name, and the numbers a bar is rendered from. */
export function songOf(k) {
  const rand = rng(Math.imul(k, 0x9e3779b1) ^ 0x5eed)
  let s
  do {
    s = {
      progression: pick(rand, PROGRESSIONS),
      tonic:       Math.floor(rand() * 12),
      bpm:         pick(rand, TEMPOS),
      feel:        pick(rand, FEELS),
      bass:        pick(rand, BASSES),
      guitar:      pick(rand, GUITARS),
      keys:        pick(rand, KEYSETS),
      singer:      pick(rand, SINGERS),
    }
  } while (VETO.some((v) => v(s)))
  const name    = `${pick(rand, ADJECTIVES)} ${pick(rand, NOUNS)}`
  // The chorus lifts by changing two parts' styles; the same style twice would lift nothing.
  const chorus  = { guitar: pick(rand, GUITARS.filter((g) => g !== s.guitar)), keys: pick(rand, KEYSETS.filter((x) => x !== s.keys)) }
  const hook    = hookOf(rand, s)
  const slow    = rng(Math.imul(k, 0x27d4eb2f) ^ 0x57121)
  const bassVoice = pick(rng(Math.imul(k, 0x165667b1) ^ 0xb455), BASS_VOICES)
  const sung    = rng(Math.imul(k, 0x2c1b3c6d) ^ 0x51d6)
  const voice   = pick(sung, VOICES)
  const vowel   = pick(sung, VOWELS)
  const tint    = rng(Math.imul(k, 0x3c6ef372) ^ 0xc010)
  const colour  = pick(tint, COLOURS)
  const sus     = colour === 'sus' ? pick(tint, [2, 4]) : null
  const strings = slow() < STRINGS_ODDS
  if (strings) {
    s.progression = pick(slow, LAMENTS)
    s.tonic       = Math.floor(slow() * 12)
    s.bpm         = pick(slow, SLOW_TEMPOS)
    s.singer      = BOWED
    s.keys        = 'pad'
  } else {
    s.progression = progressionOf(rng(Math.imul(k, 0x7f4a7c15) ^ 0x6a3e), s.progression)
  }
  const stepMs  = 60000 / s.bpm / 4
  const barN    = Math.round((stepMs * 16 / 1000) * RATE)
  const length  = s.progression.chords.length
  const key     = `${KEYS[s.tonic]} ${s.progression.mode === M ? 'major' : 'minor'}`
  const coda    = { mode: s.progression.mode, all7: s.progression.all7, chords: [[0, s.progression.mode]] }
  const tinted  = colour === 'sus' ? `sus${sus}` : colour
  const called  = s.progression.rewrites ? `${s.progression.name} (${s.progression.rewrites.join(', ')})` : s.progression.name
  // Whole bars, the last the ending, with room after it for its ring.
  const bars    = Math.floor(SONG_N / barN) - TAIL
  const shape   = strings ? null : shapeOf(rng(Math.imul(k, 0x6a09e667) ^ 0xf0a3), bars - 1)
  const formCode = shape?.form.map((x) => FORM_CODE[x.kind]).join(' ')
  const lifted   = shape?.lift.semis ? `, last chorus up ${shape.lift.semis}` : ''
  return {
    ...s, k, name, chorus, hook, stepMs, barN, key, bassVoice, voice, vowel, bars, colour, sus, coda,
    ...shape, formCode,
    ensemble: strings ? 'strings' : 'band',
    cycle: length >= 8 ? length * 2 : length * 4,
    about: strings
      ? `${name} — ${key}, ${called} (${tinted}), ${s.bpm} bpm strings; held ${bassVoice} bass, keys pad, singer ${s.singer.name}`
      : `${name} — ${key}, ${called} (${tinted}), ${s.bpm} bpm ${s.feel.name}; ${bassVoice} bass ${s.bass}, guitar ${s.guitar}, keys ${s.keys}, singer ${s.singer.name} (${voice} on ${vowel}); chorus guitar ${chorus.guitar}, keys ${chorus.keys}; form ${formCode}, ${shape?.soloist} solos${lifted}`,
  }
}

// ─── a form, drawn ────────────────────────────────────────────────────────

/** The bars a form of `f` takes before its outro. */
const formBars = (f) => f.intro + 32 + f.pre[0] + f.pre[1] + f.mids.reduce((n, m) => n + m, 0) + (f.extra ? 16 + f.pre[2] : 0) + 8

/**
 * The form's sections, `[{ kind, from, bars }]`, filling exactly `total` bars: an intro, two rounds of
 * verse, an optional pre-chorus and a chorus, a middle, perhaps one more round, the last chorus, and
 * an outro of whatever is left. The sizes are drawn, then the nearest set that leaves the outro 2 to 11
 * bars is taken (an 8-bar intro counts as four changes, so only a form that cannot fit otherwise has one).
 */
function formOf(rand, total) {
  const kinds = pick(rand, MIDDLES)
  const want  = {
    intro: 4,
    pre:   [0, 1, 2].map(() => (rand() < 0.5 ? 4 : 0)),
    mids:  kinds.map(() => (rand() < 0.5 ? 4 : 8)),
    extra: rand() < 0.5,
  }
  const sets = []
  const sizes = (n) => (n ? sizes(n - 1).flatMap((r) => [[...r, 4], [...r, 8]]) : [[]])
  for (const intro of [4, 8]) for (const extra of [false, true]) for (const mids of sizes(kinds.length)) {
    for (let bits = 0; bits < 8; bits++) {
      const pre = [0, 1, 2].map((i) => (bits >> i) & 1 ? 4 : 0)
      if (!extra && pre[2]) continue
      const f = { intro, pre, mids, extra }
      const left = total - formBars(f)
      if (left < 2 || left > 11) continue
      const apart = (intro === want.intro ? 0 : 4) + pre.filter((x, i) => x !== want.pre[i]).length + mids.filter((x, i) => x !== want.mids[i]).length + (extra === want.extra ? 0 : 1)
      sets.push({ f, apart })
    }
  }
  const near = Math.min(...sets.map((x) => x.apart))
  const f    = pick(rand, sets.filter((x) => x.apart === near)).f
  const list = [['intro', f.intro]]
  const round = (i) => list.push(['verse', 8], ...(f.pre[i] ? [['prechorus', f.pre[i]]] : []), ['chorus', 8])
  round(0)
  round(1)
  kinds.forEach((kind, i) => list.push([kind, f.mids[i]]))
  if (f.extra) round(2)
  list.push(['last', 8], ['outro', total - formBars(f)])
  let from = 0
  return list.map(([kind, bars]) => {
    const section = { kind, from, bars }
    from += bars
    return section
  })
}

/**
 * The drop-out rows drawn into `form`, each `{ kind, from, bars, ... }` over the bars it takes. A row that
 * lands on a bar an earlier one holds is dropped, so two never stack.
 */
function dropoutsOf(rand, form) {
  const some = (...kinds) => form.filter((x) => kinds.includes(x.kind))
  const lastAt   = form.findIndex((x) => x.kind === 'last')
  const stripped = form.filter((x, n) => x.kind === 'verse' && n < lastAt).pop()
  const row = {
    // the singer never sits out the last chorus; the drums and the bass never both leave one, since one row sits out one part
    sitout() {
      const x = pick(rand, some('verse', 'prechorus', 'chorus', 'bridge', 'last'))
      return { kind: 'sitout', part: pick(rand, x.kind === 'last' ? ['guitar', 'keys'] : PARTS), from: x.from, bars: x.bars }
    },
    stop() {
      const x = pick(rand, some('verse', 'prechorus'))
      return { kind: 'stop', filler: pick(rand, FILLERS), from: x.from + x.bars - 1, bars: 1 }
    },
    duo() {
      const x = pick(rand, some('verse', 'chorus'))
      return { kind: 'duo', from: x.from, bars: x.kind === 'chorus' ? 4 : x.bars }
    },
    build() {
      const x = pick(rand, some('chorus', 'last'))
      return { kind: 'build', from: x.from - 1, bars: 1 }
    },
    drop() {
      const x = pick(rand, some('chorus'))
      return { kind: 'drop', from: x.from - (rand() < 0.5 ? 1 : 0), bars: 1 }
    },
    strip() {
      return { kind: 'strip', parts: pick(rand, [['guitar', 'keys'], ['drums']]), from: stripped.from, bars: stripped.bars }
    },
  }
  const kinds = shuffle(rand, Object.keys(row))
  const taken = new Set()
  const rows  = []
  for (const kind of kinds.slice(0, 2 + Math.floor(rand() * 3))) {
    const r = row[kind]()
    const held = Array.from({ length: r.bars }, (_, i) => r.from + i)
    if (held.some((x) => taken.has(x))) continue
    held.forEach((x) => taken.add(x))
    rows.push(r)
  }
  return rows
}

/**
 * What a breakdown holds: the soloist alone one time in three, else the soloist and one other part,
 * the drums as hats only half the time they are that part. The soloist always plays, so it is never silent.
 */
function breakdownOf(rand, soloist) {
  if (rand() < 1 / 3) return { name: `${soloist} alone`, parts: [soloist] }
  const other = pick(rand, PARTS.filter((p) => p !== soloist))
  return { name: `${soloist} and ${other}`, parts: [soloist, other], hats: other === 'drums' && rand() < 0.5 }
}

/** What a band's song is arranged as: its form, its soloist and breakdown, its drop-outs and its last chorus's lift. */
function shapeOf(rand, total) {
  const form      = formOf(rand, total)
  const soloist   = pick(rand, SOLOISTS)
  // a generator of its own, so the lift and the drop-outs drawn after it keep their numbers
  const breakdown = breakdownOf(rng(Math.floor(rand() * 4294967296)), soloist)
  const semis     = pick(rand, [0, 0, 1, 2])
  return {
    form, soloist, breakdown,
    lift:       { semis, from: form[form.length - 2].from },
    outroOrder: shuffle(rand, PARTS),
    dropouts:   dropoutsOf(rand, form),
  }
}

/** The pentatonic of the song's key from `lo` to `hi`, the singer's register by default, as MIDI notes. */
function melodyOf(song, lo = 62, hi = 81) {
  const scale  = SCALES[song.progression.mode].map((d) => (song.tonic + d) % 12)
  const melody = []
  for (let n = lo; n <= hi; n++) if (scale.includes(n % 12)) melody.push(n)
  return melody
}

/**
 * Two bars of the singer's phrases walked once: `[at, len, index]` into
 * `melodyOf`, the index so the downbeat can still be pulled to the bar's chord.
 */
function hookOf(rand, song) {
  const melody = melodyOf(song)
  let mel = Math.floor(rand() * melody.length)
  return [0, 1].map((i) => song.singer.phrases[i % song.singer.phrases.length].map(([at, len]) => {
    mel = Math.max(0, Math.min(melody.length - 1, mel + Math.round(rand() * 4 - 2)))
    return [at, len, mel]
  }))
}

/**
 * The section of `song.form` bar `b` is in, with where in it: `index` bars from its start, `n` its place in the
 * form, `first` and `last` whether `b` opens or closes it. The ending bar and a strings piece have none.
 */
export function sectionAt(song, b) {
  if (!song.form || b < 0 || b >= song.bars - 1) return null
  const n     = song.form.findIndex((x) => b < x.from + x.bars)
  const x     = song.form[n]
  const index = b - x.from
  return { ...x, n, index, first: index === 0, last: index === x.bars - 1 }
}

/** The kind of section bar `b` is in, or null. */
export const sectionOf = (song, b) => sectionAt(song, b)?.kind ?? null

// What stays under each soloist: the pad and a light kick-and-hat, the pad alone, the bass and a rim.
const BACKING = { guitar: ['keys', 'drums'], keys: ['drums'], bass: ['keys'], singer: ['bass', 'drums'] }

/**
 * Which of `PARTS` sound in bar `b`: the section's own mix, less what a drop-out row takes
 * out. A stop leaves only the part that fills it. A strings piece has no mask.
 */
export function plays(song, b) {
  if (song.ensemble === 'strings') return null
  const on  = Object.fromEntries(PARTS.map((p) => [p, true]))
  const out = (...parts) => parts.forEach((p) => { on[p] = false })
  const x   = sectionAt(song, b)
  if (x?.kind === 'intro') out('singer', ...(x.index < 2 ? ['guitar'] : []))
  if (x?.kind === 'solo') out(...PARTS.filter((p) => p !== song.soloist && !BACKING[song.soloist].includes(p)))
  if (x?.kind === 'breakdown') out(...PARTS.filter((p) => !song.breakdown.parts.includes(p)))
  if (x?.kind === 'outro') out(...song.outroOrder.slice(0, Math.floor(x.index / 4)))
  for (const r of song.dropouts) {
    if (b < r.from || b >= r.from + r.bars) continue
    if (r.kind === 'sitout') out(r.part)
    if (r.kind === 'duo') out('guitar', 'keys', 'bass')
    if (r.kind === 'drop') out('drums')
    if (r.kind === 'strip') out(...r.parts)
    if (r.kind === 'stop') {
      out(...PARTS)
      on[r.filler] = true
    }
  }
  return on
}

/** The drop-out row of `kind` that holds bar `b`, if any. */
const rowAt = (song, b, kind) => song.dropouts?.find((r) => r.kind === kind && b >= r.from && b < r.from + r.bars)

/** The first slow piece after song `k`. */
export function stringsAfter(k) {
  for (let n = k + 1; n <= MAX_SONG; n++) if (songOf(n).ensemble === 'strings') return n
  return null
}

// ─── one bar, rendered ────────────────────────────────────────────────────

const hz = (n) => 440 * 2 ** ((n - 69) / 12)

// Freeverb's tuning at 44.1 kHz (Jezar Wakefield's tuning.h): the right channel's
// delays are SPREAD samples longer. `ROOM` is the comb feedback and `DAMP` how
// much of the highs each pass through a comb keeps out; RT_SAMPLES is where the
// tail is under -60 dB, past which a bar stops running the reverb.
const COMBS      = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const ALLPASSES  = [556, 441, 341, 225]
const SPREAD     = 23
const ROOM       = 0.84
const DAMP       = 0.2
const FIXED_GAIN = 0.015
const WET        = 2.5
const RT_SAMPLES = 1.5 * RATE

// The master clip: a chorus reaches 0.9-1.0 before it and the loudest hit 1.7,
// where tanh rounds them off; a verse stays under 0.6, where it is near linear.
const MASTER_DRIVE = 1
const MASTER_CEIL  = 0.9

// Four delay lines a pass, stepped together: each line wraps at its own length, so
// a run is cut at the nearest wrap and runs without a bounds check. The same sums as
// one line a pass, in a third less time.

/** Four combs over `send[from..from + n)`, written to `acc` or added to it. */
function combs(send, from, n, lens, acc, add) {
  const [N0, N1, N2, N3] = lens
  const b0 = new Float32Array(N0)
  const b1 = new Float32Array(N1)
  const b2 = new Float32Array(N2)
  const b3 = new Float32Array(N3)
  let i0 = 0, i1 = 0, i2 = 0, i3 = 0
  let h0 = 0, h1 = 0, h2 = 0, h3 = 0
  for (let i = 0; i < n;) {
    const e = i + Math.min(N0 - i0, N1 - i1, N2 - i2, N3 - i3, n - i)
    for (let j = i; j < e; j++, i0++, i1++, i2++, i3++) {
      const x  = send[from + j] * FIXED_GAIN
      const y0 = b0[i0]
      const y1 = b1[i1]
      const y2 = b2[i2]
      const y3 = b3[i3]
      h0 = y0 * (1 - DAMP) + h0 * DAMP
      h1 = y1 * (1 - DAMP) + h1 * DAMP
      h2 = y2 * (1 - DAMP) + h2 * DAMP
      h3 = y3 * (1 - DAMP) + h3 * DAMP
      b0[i0] = x + h0 * ROOM
      b1[i1] = x + h1 * ROOM
      b2[i2] = x + h2 * ROOM
      b3[i3] = x + h3 * ROOM
      acc[j] = (add ? acc[j] : 0) + y0 + y1 + y2 + y3
    }
    i = e
    if (i0 === N0) i0 = 0
    if (i1 === N1) i1 = 0
    if (i2 === N2) i2 = 0
    if (i3 === N3) i3 = 0
  }
}

/** Four allpasses in series over `acc`, added into `o[from..]` at `WET`. */
function allpasses(acc, n, lens, o, from) {
  const [N0, N1, N2, N3] = lens
  const b0 = new Float32Array(N0)
  const b1 = new Float32Array(N1)
  const b2 = new Float32Array(N2)
  const b3 = new Float32Array(N3)
  let i0 = 0, i1 = 0, i2 = 0, i3 = 0
  for (let i = 0; i < n;) {
    const e = i + Math.min(N0 - i0, N1 - i1, N2 - i2, N3 - i3, n - i)
    for (let j = i; j < e; j++, i0++, i1++, i2++, i3++) {
      let x = acc[j]
      let y = b0[i0]
      b0[i0] = x + y * 0.5
      x = y - x
      y = b1[i1]
      b1[i1] = x + y * 0.5
      x = y - x
      y = b2[i2]
      b2[i2] = x + y * 0.5
      x = y - x
      y = b3[i3]
      b3[i3] = x + y * 0.5
      o[from + j] += (y - x) * WET
    }
    i = e
    if (i0 === N0) i0 = 0
    if (i1 === N1) i1 = 0
    if (i2 === N2) i2 = 0
    if (i3 === N3) i3 = 0
  }
}

/** `send[from..to)` through a stereo Freeverb from zero state, added into `out`'s two channels. */
function reverb(send, from, to, out) {
  const n   = to - from
  const acc = new Float32Array(n)
  for (let c = 0; c < 2; c++) {
    const at = (list) => list.map((N) => N + c * SPREAD)
    combs(send, from, n, at(COMBS.slice(0, 4)), acc, false)
    combs(send, from, n, at(COMBS.slice(4)), acc, true)
    allpasses(acc, n, at(ALLPASSES), out[c], from)
  }
}

/** A memoryless saturator that leaves a full-scale input at full scale. */
const drive = (d) => {
  const norm = Math.tanh(d)
  return (x) => Math.tanh(d * x) / norm
}
const SAT = { round: drive(1.4), growl: drive(2.2), kick: drive(1.4), tom: drive(1.3), bell: drive(1.2) }

// The bass's voice: the filter's resonance and where its envelope starts, ends
// and how fast it falls, the drive after it, and a fifth above at `fifth` of the
// saw's level (only the growl has one). `gain` sets both voices to one peak.
const BASS_TONE = {
  round: { gain: 0.32, Q: 0.8, peak: 900,  floor: 160, decay: 12, fifth: 0,    sat: SAT.round },
  growl: { gain: 0.32, Q: 1.6, peak: 2400, floor: 180, decay: 7,  fifth: 0.25, sat: SAT.growl },
}

// The drums' fixed numbers: the kick's start above its resting pitch (2.5 octaves,
// as a ratio less one) and its click's level; the noise band a snare is struck at,
// by how hard; the 808's six square waves in cycles a sample, the hat's bands and
// the trims that give each new voice the level the old noise had; the toms' pitches.
const KICK_SWEEP  = 2 ** 2.5 - 1
const KICK_CLICK  = 0.5
const SNARE_BANDS = [2000, 2800, 3400, 4000]
const SNARE_NOISE = 2.5
const HAT_SQUARES = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => f / RATE)
const HAT_BANDS   = [7000, 8000, 9000]
const HAT_TRIM    = 0.3
const TOM         = { high: 220, mid: 160, low: 110 }

// A bell's partials, as ratios of its note, in the order a struck bell's modes
// fall, each dying faster than the one under it and sounding softer. The gains:
// the ending bar's bell with the singer, and the strings piece's under the bowed voice.
const BELL      = [1, 2.76, 5.40, 8.93, 11.34, 13.34].map((ratio, i) => ({ ratio, level: 0.6 ** i, decay: 1.2 + 0.6 * i }))
const BELL_END  = 0.07
const BELL_SOFT = 0.05

// The electric piano's tine: a 14:1 modulator at `index`, its burst falling at
// `decay` a second, mixed under the body at `mix`.
const EP_TINE = { index: 0.8, decay: 16, mix: 0.3 }

// The singer's vowels, Csound's formant tables: five formants a vowel, each
// [centre Hz, level dB, bandwidth Hz]. `l` is where a la starts, F1 and F2 only.
const FORMANTS = {
  soprano: {
    a: [[800, 0, 80], [1150, -6, 90], [2900, -32, 120], [3900, -20, 130], [4950, -50, 140]],
    e: [[350, 0, 60], [2000, -20, 100], [2800, -15, 120], [3600, -40, 150], [4950, -56, 200]],
    i: [[270, 0, 60], [2140, -12, 90], [2950, -26, 100], [3900, -26, 120], [4950, -44, 120]],
    o: [[450, 0, 40], [800, -11, 80], [2830, -22, 100], [3800, -22, 120], [4950, -50, 120]],
    u: [[325, 0, 50], [700, -16, 60], [2700, -35, 170], [3800, -40, 180], [4950, -60, 200]],
  },
  alto: {
    a: [[800, 0, 80], [1150, -4, 90], [2800, -20, 120], [3500, -36, 130], [4950, -60, 140]],
    e: [[400, 0, 60], [1600, -24, 80], [2700, -30, 120], [3300, -35, 150], [4950, -60, 200]],
    i: [[350, 0, 50], [1700, -20, 100], [2700, -30, 120], [3700, -36, 150], [4950, -60, 200]],
    o: [[450, 0, 70], [800, -9, 80], [2830, -16, 100], [3500, -28, 130], [4950, -55, 135]],
    u: [[325, 0, 50], [700, -12, 60], [2530, -30, 170], [3500, -40, 180], [4950, -64, 200]],
  },
  tenor: {
    a: [[650, 0, 80], [1080, -6, 90], [2650, -7, 120], [2900, -8, 130], [3250, -22, 140]],
    e: [[400, 0, 70], [1700, -14, 80], [2600, -12, 100], [3200, -14, 120], [3580, -20, 120]],
    i: [[290, 0, 40], [1870, -15, 90], [2800, -18, 100], [3250, -20, 120], [3540, -30, 120]],
    o: [[400, 0, 70], [800, -10, 80], [2600, -12, 100], [2800, -12, 130], [3000, -26, 135]],
    u: [[350, 0, 40], [600, -20, 60], [2700, -17, 100], [2900, -14, 120], [3300, -26, 120]],
  },
}
// A sung note: the syllable's consonant, then the vowel. The glottal pulse's open
// and closing fractions of a period, vibrato (Hz, depth, onset s), jitter (a random
// point every 100 ms, joined), breath noise against the pulse, the gain that puts the
// voice at the old singer's level, the l's glide (s, F1 and F2 Hz) and the d's burst (s, Hz, level).
const SYLLABLES = ['la', 'da', 'ooh']
const GLOTTIS   = { open: 0.4, close: 0.16 }
const VIBRATO   = { rate: 5.5, depth: 0.005, onset: 0.3 }
const JITTER    = 0.003
const BREATH    = 0.2
const SING_GAIN = 0.11
const L_GLIDE   = { time: 0.035, from: [350, 1000] }
const D_BURST   = { time: 0.01, hz: 3500, level: 0.6 }

// The strings piece: four bowed voices a few cents apart, each a few ms late and
// vibrating at its own rate, then a chorus (a delay of `delay` s swung `depth` s
// at `rate` Hz, mixed under the dry sound at `mix`).
const ENSEMBLE  = [{ cents: -9, late: 0, rate: 4.9 }, { cents: -3, late: 0.014, rate: 5.2 }, { cents: 4, late: 0.027, rate: 5.5 }, { cents: 10, late: 0.038, rate: 5.8 }]
const BOW_GAIN  = 0.035
const CHORUS    = { delay: 0.012, depth: 0.003, rate: 0.35, mix: 0.8 }

// The guitar's string (extended Karplus-Strong, Jaffe & Smith): the damping zero's
// weight on the older sample, where in the string the pick lands as a fraction of
// its length, and the dispersion allpass's coefficient with the note below which
// it stiffens the string.
const STRING_S    = 0.5
const PICKS       = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35]
const STIFFNESS   = 0.8
const STIFF_BELOW = 60
const pickAt      = (rand) => PICKS[Math.floor(rand() * PICKS.length)]

/** The samples of delay a first-order allpass `(a + z^-1) / (1 + a z^-1)` gives frequency `w` (radians a sample). */
const allpassDelay = (a, w) => -(Math.atan2(-Math.sin(w), a + Math.cos(w)) - Math.atan2(-a * Math.sin(w), 1 + a * Math.cos(w))) / w

// Intervals above a chord's root as small-number ratios; the minor seventh is 9/5 over
// the dominant's 7/4, which clashes with the equal-tempered bass.
const JUST = { 0: 1, 2: 9 / 8, 3: 6 / 5, 4: 5 / 4, 5: 4 / 3, 7: 3 / 2, 10: 9 / 5, 11: 15 / 8 }

/** `note`'s Hz in `chord`: a tone of the chord is its interval's ratio over the root, anything else equal-tempered. */
function tuned(note, chord) {
  const above = (((note % 12) - chord.pcs[0]) % 12 + 12) % 12
  return chord.reach.has(above) ? hz(note - above) * JUST[above] : hz(note)
}

/**
 * `buf[from..to)` with a modulated delay of itself mixed in, whose swing reads the
 * song-local sample index (`at` is the bar's first), so a bar sounds alike whenever it
 * is rendered. Answers where the delayed sound ends.
 */
function thicken(buf, from, to, at) {
  const dry  = buf.slice()
  const end  = Math.min(buf.length, to + Math.ceil((CHORUS.delay + CHORUS.depth) * RATE) + 1)
  const knot = (n) => (CHORUS.delay + CHORUS.depth * Math.sin((2 * Math.PI * CHORUS.rate * (at + n)) / RATE)) * RATE
  let d0 = knot(from)
  let d1 = d0
  for (let n = from; n < end; n++) {
    if (((n - from) & 31) === 0) {
      d0 = d1
      d1 = knot(n + 32)
    }
    const d = d0 + ((d1 - d0) * ((n - from) & 31)) / 32
    const x = Math.floor(n - d)
    const f = n - d - x
    buf[n] = dry[n] + CHORUS.mix * (x >= 0 ? dry[x] * (1 - f) + dry[x + 1] * f : 0)
  }
  return end
}

/**
 * A zero-delay-feedback state-variable filter (Simper's form of Zavalishin's
 * TPT): `f(x, fc)` takes a sample and a cutoff in Hz that may change every sample,
 * and answers the low-pass, leaving `f.band` and `f.high` for the same sample.
 */
function svf(Q) {
  const k = 1 / Q
  let ic1 = 0
  let ic2 = 0
  let fcPrev = 0
  let a1 = 0
  let a2 = 0
  let a3 = 0
  const f = Object.assign((x, fc) => {
    if (fc !== fcPrev) {
      const g = Math.tan((Math.PI * fc) / RATE)
      a1 = 1 / (1 + g * (g + k))
      a2 = g * a1
      a3 = g * a2
      fcPrev = fc
    }
    const v3 = x - ic2
    const v1 = a1 * ic1 + a2 * v3
    const v2 = ic2 + a2 * ic1 + a3 * v3
    ic1 = 2 * v1 - ic1
    ic2 = 2 * v2 - ic2
    f.band = v1
    f.high = x - k * v1 - v2
    return v2
  }, { band: 0, high: 0 })
  return f
}

// A build's filter on the keys: a low-pass opening from `from` to `to` Hz over one bar.
const SWEEP = { from: 300, to: 9000, Q: 0.7 }

/** `buf[from..to)` through the build's low-pass, the cutoff a function of the sample's place in a bar of `barN`. */
function sweep(buf, from, to, barN) {
  const lp = svf(SWEEP.Q)
  let fc = SWEEP.from
  for (let n = from; n < to; n++) {
    if ((n & 31) === 0 && n < barN + 32) fc = SWEEP.from * (SWEEP.to / SWEEP.from) ** Math.min(1, n / barN)
    buf[n] = lp(buf[n], fc)
  }
}

// ─── voice leading ────────────────────────────────────────────────────────

/** The intervals above its root a chord sounds on the keys: the triad, then the colour tone. The V, a flagged secondary dominant and an `all7` chord take a dominant seventh, whatever the colour; an `all7` minor chord a minor seventh. */
function tonesOf(song, deg, q, flagged) {
  const all7  = song.progression.all7
  const dom   = q === M && (deg === 7 || all7 || flagged)
  const tones = [0, q === M ? 4 : 3, 7]
  if (dom || all7 || song.colour === 'sevenths') tones.push(q === M && !dom ? 11 : 10)
  else if (song.colour === 'add9') tones.push(2)
  return tones
}

/** Semitones of motion from voicing `a` to `b` under the best pairing; where one has fewer notes, a note of it serves two voices. */
function motion(a, b) {
  const [big, small] = a.length >= b.length ? [a, b] : [b, a]
  const all = (1 << small.length) - 1
  let best = Infinity
  const go = (i, used, sum) => {
    if (sum >= best) return
    if (i === big.length) {
      if (used === all) best = sum
      return
    }
    for (let j = 0; j < small.length; j++) go(i + 1, used | (1 << j), sum + Math.abs(big[i] - small[j]))
  }
  go(0, 0, 0)
  return best
}

const mean = (notes) => notes.reduce((n, x) => n + x, 0) / notes.length

/** Every closed voicing of the pitch classes `pcs` (each once, within an octave) between MIDI `lo` and `hi`, low to high. */
function closed(pcs, lo, hi) {
  const out = []
  const go = (i, notes) => {
    if (i === pcs.length) {
      const sorted = notes.toSorted((x, y) => x - y)
      if (sorted[sorted.length - 1] - sorted[0] <= 11) out.push(sorted)
      return
    }
    for (let n = lo; n <= hi; n++) if (n % 12 === pcs[i]) go(i + 1, [...notes, n])
  }
  go(0, [])
  return out
}

/**
 * One voicing per chord of `sets` (pitch classes, root first), each the closed voicing in `lo..hi` with the least
 * motion from the one before. It starts from the first chord's root position nearest the register's middle, then
 * the first is chosen again for the least motion from the last, and the chain run once more. A pitch class two
 * chords share is the same note in both. `seam` is the motion left from the last chord to the first.
 */
function leading(sets, lo, hi) {
  const mid   = (lo + hi) / 2
  const cands = sets.map((pcs) => closed(pcs, lo, hi))
  const near  = (prev, list) => list.reduce((best, c) => {
    const d = motion(prev, c) - motion(prev, best)
    return d < 0 || (d === 0 && Math.abs(mean(c) - mid) < Math.abs(mean(best) - mid)) ? c : best
  })
  const chain = (first) => cands.map((_, i) => i).reduce((out, i) => (i ? [...out, near(out[i - 1], cands[i])] : [first]), [])
  const roots = cands[0].filter((v) => v[0] % 12 === sets[0][0])
  let notes = chain(roots.reduce((best, c) => (Math.abs(mean(c) - mid) < Math.abs(mean(best) - mid) ? c : best)))
  notes = chain(near(notes[notes.length - 1], cands[0]))
  return { notes, seam: motion(notes[notes.length - 1], notes[0]), mid, mean: mean(notes.flat()) }
}

const VOICED = new WeakMap()

/**
 * The cycle's voicings for the keys (the chord and its colour tone, MIDI 55-72) and the guitar (the triad, 62-79), as
 * notes above a tonic of 0, and under a sus colour each chord's third swapped for the 2nd or 4th by the nearest note.
 * A table is the progression's and its colour's alone, so any list of chords gets one.
 */
function voicingsOf(song) {
  const { progression: prog, colour, sus } = song
  const tag = `${colour}${sus}`
  const kept = VOICED.get(prog) ?? new Map()
  VOICED.set(prog, kept)
  if (kept.has(tag)) return kept.get(tag)
  const tones = prog.chords.map(([deg, q, flagged]) => tonesOf(song, deg, q, flagged))
  const swap  = (notes, [deg, q]) => {
    const from = q === M ? 4 : 3
    const to   = sus === 4 ? 5 : 2
    return notes.map((n) => (((n - deg) % 12 + 12) % 12 === from ? n + ((to - from + 18) % 12) - 6 : n))
  }
  const part  = (rel, lo, hi) => {
    const v = leading(prog.chords.map(([deg], i) => rel(i).map((t) => (deg + t) % 12)), lo, hi)
    return { ...v, sus: sus ? v.notes.map((n, i) => swap(n, prog.chords[i])) : null }
  }
  const keys   = part((i) => tones[i], 55, 72)
  const guitar = part((i) => tones[i].slice(0, 3), 62, 79)
  const table  = {
    tones, keys, guitar,
    reach: tones.map((t, i) => new Set(sus ? [...t, sus === 4 ? 5 : 2] : t)),
  }
  kept.set(tag, table)
  return table
}

/**
 * The chord of bar `b`: its pitch classes root first, the intervals it tunes (`reach`), and its voicings. Under a
 * sus colour `sus` is the same chord with the third held up by a 2nd or 4th, for the bar's first half; the
 * chord itself is what the second half resolves to.
 */
function chordOf(song, b) {
  const { chords } = song.progression
  const i     = ((b % chords.length) + chords.length) % chords.length
  const root  = (song.tonic + chords[i][0]) % 12
  const v     = voicingsOf(song)
  const pcs   = (rel) => rel.map((t) => (root + t) % 12)
  // a table is built for a tonic of 0 and moves whole, by the octave count that centres it, so no voice jumps
  const lay   = (part) => {
    const o = song.tonic + 12 * Math.round((part.mid - part.mean - song.tonic) / 12)
    return (notes) => notes.map((n) => n + o)
  }
  const keys   = lay(v.keys)
  const guitar = lay(v.guitar)
  const rel    = v.tones[i]
  return {
    pcs:    pcs(rel),
    reach:  v.reach[i],
    bass:   40 + ((root - 4 + 12) % 12),
    keys:   keys(v.keys.notes[i]),
    guitar: guitar(v.guitar.notes[i]),
    sus:    song.sus && { pcs: pcs([0, song.sus === 4 ? 5 : 2, ...rel.slice(2)]), keys: keys(v.keys.sus[i]), guitar: guitar(v.guitar.sus[i]) },
  }
}

// Each part draws from a generator of its own, seeded from (song, bar, part): a
// change to one part's draws leaves the other four parts' numbers alone, so an
// A/B comparison of one part hears only that part. One shared generator
// re-rolled the drums' looseness whenever the guitar drew a note more.
// `only` is a part's name (`createBand({ solo })`): the mix leaves the others
// out and the peaks still cover all five. `startBar` answers a handle: `part(p)`
// renders one part into its buffer and `finish()` renders the rest and mixes.
function startBar(song, b, only = null) {
  const len   = song.barN * (1 + TAIL)
  const parts = PARTS.map(() => new Float32Array(len))
  const rands = PARTS.map((_, p) => rng(Math.imul(song.k, 0x85ebca6b) ^ Math.imul(b + 1, 0xc2b2ae35) ^ Math.imul(p + 1, 0x27d4eb2f)))
  const swing = song.ensemble === 'strings' ? 0 : song.feel.swing
  const step  = (i) => ((i % 2 ? i + swing : i) * song.stepMs) / 1000
  const S     = song.stepMs / 1000
  const ending = b === song.bars - 1
  // From the last chorus on every pitch is the tonic's plus the lift, so a chord, a melody and the hook move together.
  const lift   = song.lift && b >= song.lift.from ? song.lift.semis : 0
  const key    = lift ? { ...song, tonic: (song.tonic + lift) % 12 } : song
  // The chord the bar is tuned to; the ending's is the tonic's alone.
  const chord  = chordOf(ending ? { ...key, progression: song.coda } : key, ending ? 0 : b)
  const section = sectionOf(song, b)
  const vowel  = ending || section === 'chorus' || section === 'last' ? 'a' : song.vowel
  // A hit a few ms off the grid, at a few percent off its gain: a player, not a sequencer.
  const loose = (part, i) => Math.max(0, step(i) + (rands[part]() - 0.5) * 0.006)
  const vel   = (part) => 0.85 + 0.3 * rands[part]()

  // The span each part wrote: a sample outside it is still zero, so the mix and
  // the peaks never read it.
  const lo = PARTS.map(() => len)
  const hi = PARTS.map(() => 0)
  const add = (part, t0, dur, gain, fn) => {
    const out   = parts[part]
    const start = Math.floor(t0 * RATE)
    const end   = Math.min(len - start, Math.floor(dur * RATE))
    if (end <= 0) return
    if (start < lo[part]) lo[part] = start
    if (start + end > hi[part]) hi[part] = start + end
    for (let i = 0; i < end; i++) out[start + i] += gain * fn(i / RATE, i)
  }
  // The mix at the section's level, panned constant-power into `[L, R]` with the
  // reverb added, and each part's peak per BLOCK before the pan and the send,
  // which is all `levels` reads. `until` is where the mix's last nonzero sample ends.
  const done = (vol = 1) => {
    const L     = new Float32Array(len)
    const R     = new Float32Array(len)
    const mix   = [L, R]
    const send  = new Float32Array(len)
    let   end   = 0
    let   sLo   = len
    let   sHi   = 0
    const peaks = parts.map((p, pi) => {
      const e = new Float32Array(Math.ceil(len / BLOCK))
      const heard = only === null || PARTS[pi] === only
      const gl    = Math.cos(((PAN[PARTS[pi]] + 1) * Math.PI) / 4)
      const gr    = Math.sin(((PAN[PARTS[pi]] + 1) * Math.PI) / 4)
      const gs    = SEND[PARTS[pi]]
      if (hi[pi] <= lo[pi]) return e
      if (heard && hi[pi] > end) end = hi[pi]
      if (heard && gs > 0) {
        if (lo[pi] < sLo) sLo = lo[pi]
        if (hi[pi] > sHi) sHi = hi[pi]
      }
      for (let j = Math.floor(lo[pi] / BLOCK); j * BLOCK < hi[pi]; j++) {
        const to = Math.min(hi[pi], (j + 1) * BLOCK)
        let top = 0
        for (let i = Math.max(lo[pi], j * BLOCK); i < to; i++) {
          const v = p[i] * vol
          if (heard) {
            L[i] += v * gl
            R[i] += v * gr
            send[i] += v * gs
          }
          const a = Math.abs(v)
          if (a > top) top = a
        }
        e[j] = top
      }
      return e
    })
    // The reverb is linear and starts from zero state, so bars overlap-added
    // sound as one reverb run over the song would; no state crosses a bar.
    if (sHi > sLo) {
      const to = Math.min(len, sHi + RT_SAMPLES)
      reverb(send, sLo, to, mix)
      if (to > end) end = to
    }
    while (end > 0 && L[end - 1] === 0 && R[end - 1] === 0) end--
    return { mix, peaks, until: end }
  }
  const noiseHp = (part) => {
    let prev = 0
    return () => {
      const n = rands[part]() * 2 - 1
      const y = n - prev
      prev = n
      return y
    }
  }

  // The kick's body rests on the song's root two octaves under the bass register
  // (the octave above when that is under 40 Hz, which a kick drum cannot carry).
  const kickHz = hz(key.tonic + 24) < 40 ? hz(key.tonic + 36) : hz(key.tonic + 24)
  const kick = (t0, g = 1) => {
    let ph = 0
    add(PART.drums, t0, 0.4, 0.9 * g * vel(PART.drums), (t) => {
      ph += (2 * Math.PI * kickHz * (1 + KICK_SWEEP * Math.exp(-t * 30))) / RATE
      // the beater: a 1.8 kHz burst whose envelope is flat for a millisecond, then gone by 5
      const click = t < 0.006 ? KICK_CLICK * Math.tanh(4 * Math.exp(-t * 900)) ** 2 * Math.sin(2 * Math.PI * 1800 * t) : 0
      return SAT.kick(Math.sin(ph) * Math.exp(-t * 7) + click)
    })
  }
  // A tuned body of two sines under noise band-passed higher the harder it was hit.
  const snare = (t0, g = 1) => {
    const v  = vel(PART.drums)
    const bp = svf(1.2)
    const fc = SNARE_BANDS[Math.min(SNARE_BANDS.length - 1, Math.floor(((v - 0.85) / 0.3) * SNARE_BANDS.length))]
    const rand = rands[PART.drums]
    add(PART.drums, t0, 0.25, 0.35 * g * v, (t) => {
      bp(rand() * 2 - 1, fc)
      const body = (Math.sin(2 * Math.PI * 180 * t) + 0.6 * Math.sin(2 * Math.PI * 330 * t)) * Math.exp(-t * 25)
      return SNARE_NOISE * bp.band * Math.exp(-t * 18) + 0.6 * body
    })
  }
  const rim = (t0) => add(PART.drums, t0, 0.06, 0.18 * vel(PART.drums), (t) => Math.sin(2 * Math.PI * 820 * t) * Math.exp(-t * 70))
  // The 808 hat: six square waves that never line up, band-passed and differenced.
  // A closed hat on the beat is louder than one between.
  const hat = (t0, open, accent = true) => {
    const v  = vel(PART.drums)
    const bp = svf(2)
    const fc = HAT_BANDS[Math.min(HAT_BANDS.length - 1, Math.floor(((v - 0.85) / 0.3) * HAT_BANDS.length))]
    const ph = new Float64Array(6)
    let prev = 0
    add(PART.drums, t0, open ? 0.3 : 0.05, (open ? 0.1 : accent ? 0.12 : 0.08) * v * HAT_TRIM, (t) => {
      let sq = 0
      for (let j = 0; j < 6; j++) {
        ph[j] += HAT_SQUARES[j]
        if (ph[j] >= 1) ph[j] -= 1
        sq += ph[j] < 0.5 ? 1 : -1
      }
      bp(sq, fc)
      const y = bp.band - prev
      prev = bp.band
      return y * Math.exp(-t * (open ? 10 : 90))
    })
  }
  // A swept sine settling onto its pitch in about 60 ms.
  const tom = (t0, pitch, g = 1) => {
    let ph = 0
    add(PART.drums, t0, 0.5, 0.45 * g * vel(PART.drums), (t) => {
      ph += (2 * Math.PI * pitch * (1 + 0.5 * Math.exp(-t * 50))) / RATE
      return SAT.tom(Math.sin(ph) * Math.exp(-t * 9))
    })
  }
  const crash = (t0) => {
    const n = noiseHp(PART.drums)
    add(PART.drums, t0, 2, 0.08, (t) => n() * Math.exp(-t * 2.2))
  }
  const bass = (t0, note, len, g = 1) => {
    const tone = BASS_TONE[song.bassVoice]
    const inc  = tuned(note, chord) / RATE
    const lp   = svf(tone.Q)
    const v    = vel(PART.bass)
    // a harder note opens the filter further, by up to a fifth either way
    const peak = tone.peak * (1 + (0.2 * (v - 1)) / 0.15)
    let ph = 0
    let up = 0
    let fc = 0
    add(PART.bass, t0, len, tone.gain * g * v, (t, i) => {
      ph = (ph + inc) % 1
      up = (up + inc * 1.5) % 1
      // the cutoff moves a step every 32 samples, a tan() each time it does
      if ((i & 31) === 0) fc = tone.floor + (peak - tone.floor) * Math.exp(-t * tone.decay)
      const low = lp(ph * 2 - 1 + tone.fifth * (up * 2 - 1), fc)
      return tone.sat(low * Math.min(1, t * 200) * Math.exp(-t * 3))
    })
  }
  // A struck tine: a 1:1 pair for the body, its index falling as the note dies, and a
  // 14:1 pair for the bright ping at the start. How hard it was played sets the index.
  const piano = (t0, note, len) => {
    const w   = (2 * Math.PI * tuned(note, chord)) / RATE
    const v   = vel(PART.keys)
    const idx = 1.5 + (v - 0.85) / 0.3
    let ph = 0
    add(PART.keys, t0, len, 0.06 * v, (t) => {
      ph += w
      const body = Math.sin(ph + idx * Math.exp(-t * 6) * Math.sin(ph))
      const tine = Math.sin(ph + EP_TINE.index * Math.sin(14 * ph)) * Math.exp(-t * EP_TINE.decay)
      return (body + EP_TINE.mix * tine) * Math.min(1, t * 400) * Math.exp(-t * 4) * Math.min(1, (len - t) * 30)
    })
  }
  // A struck bell, in the keys' bus: it stands nearest the middle of the stage, and
  // the scope has no sixth lane for it. The upper partials are louder for the first
  // 10 ms, which is the strike.
  const bell = (t0, note, len, gain) => {
    const w   = BELL.map(({ ratio }) => (2 * Math.PI * hz(note) * ratio) / RATE)
    const dec = BELL.map(({ decay }) => Math.exp(-decay / RATE))
    const env = BELL.map(() => 1)
    const ph  = BELL.map(() => 0)
    add(PART.keys, t0, len, gain, (t) => {
      const strike = 1 + 2 * Math.exp(-t * 300)
      let y = 0
      for (let j = 0; j < BELL.length; j++) {
        ph[j] += w[j]
        env[j] *= dec[j]
        y += BELL[j].level * (j ? strike : 1) * Math.sin(ph[j]) * env[j]
      }
      return SAT.bell(y) * Math.min(1, t * 1000) * Math.min(1, (len - t) * 10)
    })
  }
  // Three saws, the outer two a few cents either way, through a low-pass that opens over the first second.
  const warm = (t0, note, len) => {
    const inc   = tuned(note, chord) / RATE
    const cents = 4 + Math.floor(rands[PART.keys]() * 4)
    const step  = [2 ** (-cents / 1200), 1, 2 ** (cents / 1200)].map((r) => inc * r)
    const lp    = svf(0.7)
    let p0 = 0
    let p1 = 1 / 3
    let p2 = 2 / 3
    let fc = 0
    add(PART.keys, t0, len, 0.065, (t, i) => {
      p0 = (p0 + step[0]) % 1
      p1 = (p1 + step[1]) % 1
      p2 = (p2 + step[2]) % 1
      if ((i & 31) === 0) fc = 400 + 1400 * (1 - (1 - Math.min(1, t)) ** 2)
      return lp((p0 + p1 + p2) * (2 / 3) - 1, fc) * Math.min(1, t * 4) * Math.min(1, (len - t) * 8)
    })
  }
  const keys = (t0, notes, len = 0.25, pad = false) => {
    for (const note of notes) (pad ? warm : piano)(t0, note, len)
  }
  // Under a sus colour the bar's first half is the chord with its third held up, the second the chord itself.
  const heard = (i) => (i < 8 && chord.sus ? chord.sus : chord)
  // The pad holds what the two halves share for the bar and swaps only the third's voice at the half.
  const bed = () => {
    if (!chord.sus) return keys(0, chord.keys, S * 16, true)
    const held = chord.keys.filter((n) => chord.sus.keys.includes(n))
    keys(0, held, S * 16, true)
    keys(0, chord.sus.keys.filter((n) => !held.includes(n)), S * 8, true)
    keys(S * 8, chord.keys.filter((n) => !held.includes(n)), S * 8, true)
  }
  // The damping zero's half sample and the allpasses' delay together make up
  // the string's length, `N` whole samples short of it: a note rounded to the
  // nearest sample is up to 34 cents off at the top of the range.
  const guitar = (t0, note) => {
    const rand = rands[PART.guitar]
    const v    = vel(PART.guitar)
    const hard = (v - 0.85) / 0.3
    const f    = tuned(note, chord)
    const T60  = 2.5 - 1.3 * Math.min(1, Math.max(0, (note - 50) / 30))
    // the damping zero already takes cos(w/2) of the fundamental on every pass
    const rho  = 0.001 ** (1 / (f * T60)) / Math.cos((Math.PI * f) / RATE)
    // the dispersion allpass delays low frequencies more than high ones, which
    // stretches the partials upward; its delay at the fundamental comes off the string's length
    const a    = note < STIFF_BELOW ? -STIFFNESS * Math.min(1, (STIFF_BELOW - note) / 6) : 0
    const Ddis = a ? allpassDelay(a, (2 * Math.PI * f) / RATE) : 0
    const L    = RATE / f + STRING_S - Ddis
    const N    = Math.floor(L - 0.5)
    const C    = (1 - (L - N)) / (1 + (L - N))
    // The pluck: noise through a one-pole whose cutoff follows how hard it was struck,
    // then the comb of the pick's position, at the same loudness whatever it was cut to
    const P    = Math.round(pickAt(rand) * N)
    const kLp  = 1 - Math.exp((-2 * Math.PI * 1800 * 4 ** hard) / RATE)
    const buf  = new Float32Array(N)
    let lp = 0
    for (let n = 0; n < N; n++) buf[n] = lp += kLp * (rand() * 2 - 1 - lp)
    let power = 0
    for (let n = N - 1; n >= 0; n--) {
      if (n >= P) buf[n] -= buf[n - P]
      power += buf[n] * buf[n]
    }
    const level = 0.5 / Math.sqrt(power / N)
    for (let n = 0; n < N; n++) buf[n] *= level
    let xPrev = 0
    let yPrev = 0
    let xd = 0
    let yd = 0
    const dur = 0.8 * T60
    add(PART.guitar, t0, dur, 0.16 * v, (t, i) => {
      const j = i % N
      const out = buf[j]
      let x = rho * ((1 - STRING_S) * buf[j] + STRING_S * buf[(j + 1) % N])
      if (a) {
        const y = a * x + xd - a * yd
        xd = x
        yd = y
        x = y
      }
      yPrev = C * x + xPrev - C * yPrev
      xPrev = x
      buf[j] = yPrev
      return out * Math.min(1, (dur - t) * 16)
    })
  }
  // A syllable: a l glides two formants in from low, a d bursts noise then voices, an ooh is a u.
  // The source is a glottal flow's derivative (a closing kink, no DC) with vibrato and jitter,
  // breath noise mixed in, through five band-passes at the vowel's formants.
  const sing = (t0, note, len) => {
    const rand  = rands[PART.singer]
    const syl   = pick(rand, SYLLABLES)
    const set   = FORMANTS[song.voice][syl === 'ooh' ? 'u' : vowel]
    const f0    = tuned(note, chord) / RATE
    const walk  = Array.from({ length: Math.ceil((len + 0.12) * 10) + 2 }, () => (rand() * 2 - 1) * JITTER)
    const bands = set.map(([F, , BW]) => svf(F / BW))
    const gains = set.map(([F, dB, BW]) => (10 ** (dB / 20) * BW) / F)
    const fc    = set.map(([F]) => F)
    const glide = syl === 'la' ? Math.round(L_GLIDE.time * RATE) : 0
    const burst = syl === 'da' ? svf(2) : null
    const onset = syl === 'da' ? D_BURST.time : 0
    const { open, close } = GLOTTIS
    let ph    = 0
    let flow  = 0
    let sway  = 1
    for (let j = 0; j < 5; j++) bands[j](0, fc[j])
    add(PART.singer, t0, len + 0.12, SING_GAIN, (t, i) => {
      if (glide && i < glide + 32 && (i & 31) === 0) {
        const x = Math.min(1, i / glide)
        for (let j = 0; j < 2; j++) fc[j] = L_GLIDE.from[j] + (set[j][0] - L_GLIDE.from[j]) * x
      }
      if ((i & 31) === 0) {
        const u = t * 10
        const k = Math.floor(u)
        const vib = VIBRATO.depth * Math.sin(2 * Math.PI * VIBRATO.rate * t) * Math.min(1, Math.max(0, (t - VIBRATO.onset) * 3))
        sway = 1 + vib + walk[k] + (walk[k + 1] - walk[k]) * (u - k)
      }
      ph += f0 * sway
      if (ph >= 1) ph -= 1
      const g = ph < open ? 0.5 * (1 - Math.cos((Math.PI * ph) / open)) : ph < open + close ? Math.cos((Math.PI * (ph - open)) / (2 * close)) : 0
      const src = (g - flow) / (f0 * sway) + BREATH * (rand() * 2 - 1)
      flow = g
      let y = 0
      for (let j = 0; j < 5; j++) {
        bands[j](src, fc[j])
        y += gains[j] * bands[j].band
      }
      const env = Math.min(1, Math.max(0, t - onset) * 15) * (t > len ? Math.exp(-(t - len) * 30) : 1)
      let hit = 0
      if (burst && t < D_BURST.time) {
        burst(rand() * 2 - 1, D_BURST.hz)
        hit = D_BURST.level * burst.band * (1 - t / D_BURST.time)
      }
      return env * y + hit
    })
  }

  // A bow: a slow attack, vibrato that comes in after the note has settled,
  // and the harmonics of a saw rolled off, which is what separates it from `sing`.
  // Four voices a few cents apart, each a little late, make an ensemble.
  // The phase is a phasor turned by a rotation set every 32 samples: a trig call a
  // sample, four voices over, is most of the part's cost.
  const bow = (t0, note, len) => {
    for (const { cents, late, rate } of ENSEMBLE) {
      const w = (2 * Math.PI * tuned(note, chord) * 2 ** (cents / 1200)) / RATE
      let c = 1
      let s = 0
      let cw = 1
      let sw = 0
      add(PART.singer, t0 + late, len + 0.5, BOW_GAIN, (t, i) => {
        if ((i & 31) === 0) {
          const turn = w * (1 + 0.012 * Math.sin(2 * Math.PI * rate * t) * Math.min(1, Math.max(0, (t - 0.3) * 2)))
          cw = Math.cos(turn)
          sw = Math.sin(turn)
          const m = 1.5 - 0.5 * (c * c + s * s)
          c *= m
          s *= m
        }
        const nc = c * cw - s * sw
        s = s * cw + c * sw
        c = nc
        const env = Math.min(1, t * 6) * (t > len ? Math.exp(-(t - len) * 8) : 1)
        // sin(h*ph) by recurrence on the phasor, no trig
        const c2 = 2 * c
        let prev = 0
        let cur  = s
        let y    = cur
        for (let h = 2; h <= 6; h++) {
          const next = c2 * cur - prev
          prev = cur
          cur  = next
          y   += cur / h
        }
        return env * y
      })
    }
  }

  const melody = melodyOf(key)
  // The hook is stored as indexes into the song's own melody, so it moves by pitch.
  const hookNote = (i) => (lift ? melodyOf(song)[i] + lift : melody[i])
  // The chord's notes within the melody; a blues chord may have none there.
  const snap = (chord, note, scale = melody) => {
    const tones = scale.filter((n) => chord.pcs.includes(n % 12))
    return tones.length ? tones.reduce((best, n) => (Math.abs(n - note) < Math.abs(best - note) ? n : best)) : note
  }
  // A walk through `scale` a step or two at a time, pulled to the chord on a downbeat.
  const walker = (part, scale = melody) => {
    const rand = rands[part]
    let mel = Math.floor(rand() * scale.length)
    return (chord, downbeat) => {
      mel = Math.max(0, Math.min(scale.length - 1, mel + Math.round(rand() * 4 - 2)))
      if (!downbeat) return scale[mel]
      const note = snap(chord, scale[mel], scale)
      mel = scale.indexOf(note)
      return note
    }
  }

  // The soloists' voices, each from its own part's generator in its own register.
  const guitarSolo = () => {
    const next = walker(PART.guitar)
    steps(euclid(6, 16, b % 4)).forEach((i, j) => guitar(loose(PART.guitar, i), next(chord, j === 0)))
  }
  // The right hand in eighths, a rest one in four; the left holds the root and fifth on one and three or stabs the chord on the downbeat.
  const keysSolo = () => {
    const rand = rands[PART.keys]
    const next = walker(PART.keys, melodyOf(key, 67, 86))
    if (song.keys === 'pad') bed()
    if (rand() < 0.5) for (const i of [0, 8]) keys(step(i), [chord.bass, chord.bass + 7], S * 7)
    else keys(0, heard(0).keys, S * 4)
    for (const i of EIGHTS) {
      const n = next(chord, i === 0)
      if (rand() >= 0.25) keys(loose(PART.keys, i), [n], S * 2)
    }
  }
  // Eighths with a rest one in three and an octave leap one in five, the root on one and three,
  // and one time in four a triplet or two sixteenths picking up into the half bar or the next bar.
  const bassSolo = () => {
    const rand    = rands[PART.bass]
    const next    = walker(PART.bass, melodyOf(key, 40, 55))
    const gone    = new Set()
    const pickups = [8, 16].flatMap((end) => {
      const on      = rand() < 0.25
      const triplet = rand() < 0.5
      if (!on) return []
      ;(triplet ? [end - 4, end - 2] : [end - 2]).forEach((i) => gone.add(i))
      return triplet ? [0, 4 / 3, 8 / 3].map((d) => end - 4 + d) : [end - 2, end - 1]
    })
    for (const i of EIGHTS) {
      const root = i % 8 === 0
      const n    = next(chord, root)
      const rest = rand() < 1 / 3
      const leap = rand() < 0.2
      if (gone.has(i) || (rest && !root)) continue
      bass(loose(PART.bass, i), root ? chord.bass : leap ? n + (n < 48 ? 12 : -12) : n, S * 1.6)
    }
    for (const i of pickups) bass(loose(PART.bass, i), next(chord, false), S * 1.2)
  }
  // Phrases of two to six syllables of 2, 2, 4 or 6 steps, 2 to 4 steps of rest between them; one running past the bar is cut at its line.
  const scat = () => {
    const rand = rands[PART.singer]
    const next = walker(PART.singer)
    for (let at = 0; at < 16; at += 2 + Math.floor(rand() * 3)) {
      for (let j = 2 + Math.floor(rand() * 5); j > 0 && at < 16; j--) {
        const len = Math.min(pick(rand, [2, 2, 4, 6]), 16 - at)
        sing(step(at), next(chord, at === 0), len * S)
        at += len
      }
    }
  }

  // What each part plays this bar. A part's voices write only its own buffer and
  // draw only from its own generator, so the parts render in any order alike.
  const play = {}
  let vol = 1
  const c     = b % song.cycle
  const after = chordOf(key, b + 1)
  const build = rowAt(song, b, 'build')

  if (ending) {
    // The ending: every part on the tonic once, left to ring.
    const tonic = melody.find((n) => n % 12 === key.tonic && n >= 64) ?? melody[0]
    play.bass = () => bass(0, chord.bass, S * 16)
    play.keys = () => {
      keys(0, chord.keys, S * 16, true)
      bell(0, tonic, S * 12, BELL_END)
    }
    if (song.ensemble === 'strings') {
      play.singer = () => bow(0, tonic, S * 14)
    } else {
      play.drums  = () => {
        crash(0)
        kick(0)
      }
      play.guitar = () => chord.guitar.forEach((n, i) => guitar(i * 0.012, n))
      play.singer = () => sing(0, tonic, S * 12)
    }
  } else if (song.ensemble === 'strings') {
    // pad from the first bar, the bass a bar later, the voice from the third;
    // the voice breathes every fourth bar and the pad carries on under it
    play.keys = () => {
      bed()
      if (b >= 2 && c % 4 === 0) bell(0, 60 + chord.pcs[0], S * 16, BELL_SOFT)
    }
    if (b >= 1) {
      play.bass = () => {
        bass(0, chord.bass, S * 8)
        bass(step(8), chord.bass, S * 8)
      }
    }
    if (b >= 2 && c % 4 !== 3) {
      play.singer = () => {
        const next = walker(PART.singer)
        for (const [at, len] of song.singer.phrases[c % 3]) bow(step(at), next(chord, at === 0), len * S)
      }
    }
  } else {
    const x       = sectionAt(song, b)
    const on      = /** @type {Record<string, boolean>} */ (plays(song, b))
    const fill    = x.last && x.kind !== 'outro'   // a fill into the next section
    const solo    = x.kind === 'solo'
    // a solo and a breakdown hand the soloist its own voice; only a solo thins the band under it
    const lead    = (part) => (solo || x.kind === 'breakdown') && song.soloist === part
    const thin    = solo
    const bridge  = x.kind === 'bridge'
    const chorus  = x.kind === 'chorus' || x.kind === 'last'
    const hats    = x.kind === 'breakdown' && song.breakdown.hats
    const stop    = rowAt(song, b, 'stop')
    const { feel } = song
    vol = x.kind === 'intro' ? Math.min(VOL.intro, 0.6 + 0.1 * x.index)
      : x.kind === 'outro' ? VOL.last + ((VOL.outro - VOL.last) * (x.index + 1)) / x.bars
      : VOL[x.kind]

    if (on.drums) {
      play.drums = () => {
        // the fill takes the last beat and the build's roll the last three: a backbeat under either would double the first hit;
        // the full band's downbeat after a solo is the next section's, so the thinned drums run no fill
        const cut = build ? 4 : fill && !thin ? 12 : 16
        if (x.first && !thin) crash(0)
        if (thin) {
          if (song.soloist === 'singer') for (const i of [4, 12]) if (i < cut) rim(loose(PART.drums, i))
          if (song.soloist !== 'singer') {
            for (const i of [0, 8]) if (i < cut) kick(loose(PART.drums, i), 0.5)
            for (const i of [0, 4, 8, 12]) if (i < cut) hat(loose(PART.drums, i), false, false)
          }
        } else if (bridge && !build) {
          // the bridge breathes: the kick on one and three, the backbeat a rim, the hat on the beat
          for (const i of [0, 8]) kick(loose(PART.drums, i))
          for (const i of feel.snare ?? feel.rim) rim(loose(PART.drums, i))
          for (const i of [0, 4, 8, 12]) hat(loose(PART.drums, i), false, false)
        } else if (hats) {
          for (const i of EIGHTS) if (i < cut) hat(loose(PART.drums, i), false, i % 4 === 0)
        } else {
          for (const i of feel.kick) if (i < cut) kick(loose(PART.drums, i))
          for (const i of feel.snare ?? []) if (i < cut) snare(loose(PART.drums, i))
          for (const i of feel.rim ?? []) if (i < cut) rim(loose(PART.drums, i))
          for (const i of feel.hat) if (i < cut) hat(loose(PART.drums, i), false, i % 4 === 0)
          for (const i of feel.open) if (i < cut) hat(loose(PART.drums, i), true)
          // a ghost on an offbeat half the time, never under the fill
          if (!build && feel.snare && rands[PART.drums]() < 0.5) snare(loose(PART.drums, fill || rands[PART.drums]() < 0.5 ? 7 : 15), 0.25)
        }
        if (build) {
          for (let i = 4; i < 16; i++) snare(loose(PART.drums, i), 0.15 + (0.85 * (i - 4)) / 11)
        } else if (fill && !thin) {
          // four sixteenths climbing; their tails overlap, so the last lands under the backbeat's gain
          // every other section's fill ends on the toms
          const toms = x.n % 2 === 1
          ;[12, 13, 14, 15].forEach((i, j) => (toms && j >= 2 ? tom(loose(PART.drums, i), j === 2 ? TOM.high : TOM.low, 0.4 + j * 0.15) : snare(loose(PART.drums, i), 0.4 + j * 0.15)))
        }
      }
    }

    if (on.bass) {
      play.bass = () => {
        const g = thin ? 0.8 : 1
        if (lead('bass')) {
          bassSolo()
        } else if (bridge) {
          bass(loose(PART.bass, 0), chord.bass, S * 7.5, g)
          bass(loose(PART.bass, 8), chord.bass, S * 7.5, g)
        } else if (song.bass === 'on the kick') {
          for (const i of feel.kick) bass(loose(PART.bass, i), chord.bass, S * 2.5, g)
          bass(loose(PART.bass, 14), chord.bass + 12, S * 1.5, g)
        } else if (song.bass === 'eighths') {
          for (const i of EIGHTS) bass(loose(PART.bass, i), chord.bass + (i === 6 || i === 14 ? 12 : 0), S * 1.6, g)
        } else {
          const walk = [chord.bass, chord.bass + 7, chord.bass + 12, after.bass + (after.bass > chord.bass ? -1 : 1)]
          walk.forEach((n, i) => bass(loose(PART.bass, i * 4), n, S * 3.5, g))
        }
      }
    }

    // the bridge's keys are a pad, the chorus's their own
    if (on.keys) {
      play.keys = () => {
        const keyset = bridge || thin ? 'pad' : chorus ? song.chorus.keys : song.keys
        if (lead('keys')) keysSolo()
        else if (keyset === 'stabs') for (const i of [2, 6, 10, 14]) keys(step(i), heard(i).keys)
        else if (keyset === 'backbeat') for (const i of [4, 12]) keys(step(i), heard(i).keys)
        else bed()
      }
    }
    // the melody walked in the solo, out in the bridge, its chorus style in the chorus
    if (on.guitar) {
      play.guitar = () => {
        if (lead('guitar')) {
          guitarSolo()
        } else if (!bridge) {
          const style = chorus ? song.chorus.guitar : song.guitar
          if (style === 'strummed') {
            for (const i of [0, 6, 10]) {
              const t = loose(PART.guitar, i)
              heard(i).guitar.forEach((n, j) => guitar(t + j * 0.012, n))
            }
          } else {
            const at = style === 'arpeggio' ? steps(euclid(5, 16, 3)) : steps(euclid(7, 16, 1))
            at.forEach((i, j) => guitar(loose(PART.guitar, i), heard(i).guitar[j % 3]))
          }
        }
      }
    }

    // the singer rests under the fill; the hook in the chorus, a walk elsewhere, the bridge's in long phrases, a scat in a solo
    if (on.singer && (!fill || lead('singer'))) {
      play.singer = () => {
        if (lead('singer')) {
          scat()
        } else if (chorus) {
          for (const [at, len, mel] of song.hook[x.index % 2]) sing(step(at), at === 0 ? snap(chord, hookNote(mel)) : hookNote(mel), len * S)
        } else {
          const next    = walker(PART.singer)
          const phrases = bridge ? LONG.phrases : song.singer.phrases
          for (const [at, len] of phrases[b % 2]) sing(step(at), next(chord, at === 0), len * S)
        }
      }
    }

    // a stop: the band rests and the one part `plays` left fills the bar
    if (stop) {
      play[stop.filler] = {
        drums: () => [0, 4, 8, 12].forEach((i, j) => snare(loose(PART.drums, i), 0.4 + j * 0.15)),
        bass:  () => {
          const next = walker(PART.bass)
          ;[0, 4, 8, 12].forEach((i, j) => bass(loose(PART.bass, i), next(chord, j === 0) - 24, S * 3.5))
        },
        keys:  () => [0, 1, 2, 3, 4, 5].forEach((j) => keys(step(j * 2), [chord.keys[j % chord.keys.length] + 12 * Math.floor(j / chord.keys.length)], j === 5 ? S * 6 : S * 2)),
        singer: () => {
          for (const [at, len, mel] of song.hook[0]) sing(step(at), at === 0 ? snap(chord, hookNote(mel)) : hookNote(mel), len * S)
        },
      }[stop.filler]
    }
  }

  const rendered = PARTS.map(() => false)
  const bar = {
    part(p) {
      if (rendered[p]) return
      rendered[p] = true
      play[PARTS[p]]?.()
      if (p === PART.keys && build && hi[p] > lo[p]) sweep(parts[p], lo[p], hi[p], song.barN)
      if (p === PART.singer && song.ensemble === 'strings' && hi[p] > lo[p]) hi[p] = thicken(parts[p], lo[p], hi[p], b * song.barN)
    },
    finish() {
      for (let p = 0; p < PARTS.length; p++) bar.part(p)
      return done(vol)
    },
  }
  return bar
}

/** Bar `b` of `song` whole, as `{ mix: [L, R], peaks, until }`. */
const renderBar = (song, b, only = null) => startBar(song, b, only).finish()

// ─── the stream ───────────────────────────────────────────────────────────

/**
 * Every song from the epoch: `samples(from, n)` is samples `from`..`from+n`,
 * in -1..1, as `[left, right]`. `seat(cue)` is a request heard: samples before its `at` still
 * follow the cue it replaces, since a pull may already have passed the bar.
 * `levels(from, cols, width)` is how loud each of `PARTS` was, for the
 * loft's scope.
 */
export function createBand({ solo = null } = {}) {
  const songs = new Map()
  const bars  = new Map()
  const peaked = new Map()   // the bars' `peaks`, kept longer: they are small, and the scope reads back
  const songFor = (k) => {
    let s = songs.get(k)
    if (!s) {
      s = songOf(k)
      songs.set(k, s)
      if (songs.size > 3) songs.delete(songs.keys().next().value)
    }
    return s
  }
  // Bars begun but not mixed, by key: the bar ahead of the one playing, a part a pull.
  const pending = new Map()
  const keep = (key, bar) => {
    bars.set(key, bar)
    if (bars.size > TAIL + 2) bars.delete(bars.keys().next().value)
    peaked.set(key, bar.peaks)
    if (peaked.size > 16) peaked.delete(peaked.keys().next().value)
    return bar
  }
  const barFor = (song, b) => {
    const key = `${song.k}:${b}`
    const bar = bars.get(key)
    if (bar) return bar
    const lead = pending.get(key)
    pending.delete(key)
    return keep(key, (lead?.bar ?? startBar(song, b, solo)).finish())
  }
  // One step toward bar `b + 1`: each part in turn, then the mix with its reverb.
  // A song's last bar has no next in it, and the next song's bar 0 is left to its own pull.
  const ahead = (song, b) => {
    if (b + 1 >= song.bars) return
    const key = `${song.k}:${b + 1}`
    if (bars.has(key)) return
    let lead = pending.get(key)
    if (!lead) {
      lead = { bar: startBar(song, b + 1, solo), done: 0 }
      pending.set(key, lead)
      if (pending.size > 2) pending.delete(pending.keys().next().value)
    }
    if (lead.done < PARTS.length) lead.bar.part(lead.done++)
    else barFor(song, b + 1)
  }
  /** Song, sample within it and bar of sample `s`, under the cue counting at `s`. */
  const placeOf = (s) => {
    const c     = s >= cue.from ? cue : was
    const k     = c.first + Math.floor((s - c.from) / SONG_N)
    const song  = songFor(k)
    const local = s - c.from - (k - c.first) * SONG_N
    return { song, local, b: Math.floor(local / song.barN) }
  }
  const seated = (cue) => ({ ...cue, from: Math.round((cue.at / 1000) * RATE) })
  let was = seated(CLOCK)
  let cue = was
  return {
    seat(next) {
      // A second request before the first's bar replaces it at the same
      // `at` (the server's rule), so the cue before both still counts until then.
      if (next.at > cue.at) was = cue
      cue = seated(next)
    },
    /** The cue counting at wall-clock `ms`. */
    cueOf(ms) {
      const c = ms >= cue.at ? cue : was
      return { first: c.first, at: c.at }
    },
    samples(from, n) {
      const out = [new Float32Array(n), new Float32Array(n)]
      const acc = [new Float64Array(n), new Float64Array(n)]
      let reach = null
      for (let i = 0; i < n;) {
        const s     = from + i
        const cs    = s >= cue.from ? cue : was
        const k     = cs.first + Math.floor((s - cs.from) / SONG_N)
        const song  = songFor(k)
        const local = s - cs.from - (k - cs.first) * SONG_N
        const b     = Math.floor(local / song.barN)
        // This bar and the TAIL before it that are in the song.
        const held  = []
        for (let j = 0; j <= TAIL; j++) if (b - j >= 0 && b - j < song.bars) held.push([b - j, barFor(song, b - j)])
        // A run ends where the bar, the song or the cue that counts here does.
        let run = Math.min(n - i, (b + 1) * song.barN - local, SONG_N - local)
        if (s < cue.from) run = Math.min(run, cue.from - s)
        for (const [bj, bar] of held) {
          const at  = local - bj * song.barN
          const cnt = Math.min(run, bar.until - at)
          for (let c = 0; c < 2; c++) {
            const a = acc[c]
            const m = bar.mix[c]
            for (let x = 0; x < cnt; x++) a[i + x] += m[at + x]
          }
        }
        for (let c = 0; c < 2; c++) {
          for (let x = i; x < i + run; x++) if (acc[c][x] !== 0) out[c][x] = Math.tanh(acc[c][x] * MASTER_DRIVE) * MASTER_CEIL
        }
        i += run
        reach = { song, b, s: cs, local }
      }
      // A bar ahead is only started under the cue that will count there.
      if (reach) {
        const next = reach.s.from + (reach.song.k - reach.s.first) * SONG_N + (reach.b + 1) * reach.song.barN
        if ((next >= cue.from ? cue : was) === reach.s) ahead(reach.song, reach.b)
      }
      return out
    },
    /**
     * The peak of each part's own track, before the mix, in each of `cols`
     * runs of `width` samples from `from`: one Float32Array per `PARTS`
     * entry. Read from bars already rendered, past the bar playing at the
     * last sample, which is rendered if no pull has (the band unheard is
     * still drawn); a run whose bar was never rendered here is 0.
     */
    levels(from, cols, width) {
      const out = PARTS.map(() => new Float32Array(cols))
      const now = placeOf(from + cols * width - 1)
      if (now.b >= 0 && now.b < now.song.bars) barFor(now.song, now.b)
      for (let col = 0; col < cols; col++) {
        for (let s = from + col * width; s < from + (col + 1) * width; s += BLOCK) {
          const { song, local, b } = placeOf(s)
          for (let bj = b - TAIL; bj <= b; bj++) {
            const peaks = bj >= 0 && bj < song.bars ? peaked.get(`${song.k}:${bj}`) : null
            if (!peaks) continue
            const i = Math.floor((local - bj * song.barN) / BLOCK)
            for (let p = 0; p < PARTS.length; p++) if (peaks[p][i] > out[p][col]) out[p][col] = peaks[p][i]
          }
        }
      }
      return out
    },
  }
}
