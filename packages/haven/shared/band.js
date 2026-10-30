// shared/band.js — the loft's band as sound, target-neutral and pure over the wall
// clock: sample `s` is the same on every screen, so two members in the loft
// hear one beat with nothing sent, the way `sky.js` gives them one sky.
//
// The clock is cut into songs of `SONG_MS`, and song `k` is drawn from `k`:
// each choice — key, progression, tempo, drum feel, and a style for the
// bass, guitar, keys and singer — is picked from a short list of options
// that each work, and `VETO` rerolls the pairings that do not. One song in
// `STRINGS_ODDS` is not the band at all: a slow piece for a bowed voice over
// a pad and a held bass, with no drums or guitar, drawn from a generator of
// its own so the band's songs keep their numbers. What makes any
// draw sound right is what is never drawn: one key for everyone, a
// pentatonic melody that lands on a chord tone each downbeat, and each part
// in its own register. Everything is synthesized; there are no samples.
//
// A song has a form (`sectionOf`): each cycle of the progression is four
// quarters -- a verse, a chorus, a verse or on odd cycles a bridge, and an
// instrumental quarter the guitar solos over -- with a fill into every
// quarter and a level per section (`VOL`), so a song swells and drops. The
// chorus swaps the guitar's and the keys' style for a second pair drawn from
// `k`, and the singer sings the `hook`, two bars drawn once for the song and
// sung at every chorus: a tune is what comes back. Each hit is loosened by
// a few ms and a few percent, odd steps swing by the feel's `swing`, and a
// snare ghosts on an offbeat, all from the bar's own numbers, so every
// screen loosens alike.
//
// `createBand().samples(from, n)` is what `#sound` pulls, `from` counted from
// the epoch at `RATE`. A bar is rendered whole with `TAIL` bars of ring after
// it (a crash outlasts a fast bar), so a sample is its own bar plus the tails
// of the ones before. A song plays whole bars and an ending bar, then rests
// until the next window opens.
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

const SONG_N = (SONG_MS / 1000) * RATE
const TAIL   = 2
const BLOCK  = RATE / 100   // 10 ms, the grain `levels` reads a part's loudness at

// ─── the menus ────────────────────────────────────────────────────────────

const M = 'maj'
const m = 'min'

// A chord is [semitones above the tonic, quality].
const PROGRESSIONS = [
  { name: 'aeolian',  mode: m, chords: [[0, m], [8, M], [3, M], [10, M]] },
  { name: 'minor iv', mode: m, chords: [[0, m], [5, m], [10, M], [3, M]] },
  { name: 'dorian',   mode: m, chords: [[0, m], [5, M], [0, m], [5, M]] },
  { name: 'epic',     mode: m, chords: [[0, m], [10, M], [8, M], [10, M]] },
  { name: 'pop',      mode: M, chords: [[0, M], [7, M], [9, m], [5, M]] },
  { name: 'doo-wop',  mode: M, chords: [[0, M], [9, m], [5, M], [7, M]] },
  { name: 'two-five', mode: M, chords: [[2, m], [7, M], [0, M], [0, M]] },
  { name: 'blues',    mode: M, chords: [0, 0, 0, 0, 5, 5, 0, 0, 7, 5, 0, 7].map((d) => [d, M]) },
]
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
const GUITARS = ['arpeggio', 'running', 'strummed']
const KEYSETS = ['stabs', 'backbeat', 'pad']
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

/** Each section's level; the intro climbs to the verse's over its four bars. */
const VOL = { verse: 0.9, chorus: 1, bridge: 0.72, solo: 0.95 }

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
  const strings = slow() < STRINGS_ODDS
  if (strings) {
    s.progression = pick(slow, LAMENTS)
    s.tonic       = Math.floor(slow() * 12)
    s.bpm         = pick(slow, SLOW_TEMPOS)
    s.singer      = BOWED
    s.keys        = 'pad'
  }
  const stepMs  = 60000 / s.bpm / 4
  const barN    = Math.round((stepMs * 16 / 1000) * RATE)
  const length  = s.progression.chords.length
  const key     = `${KEYS[s.tonic]} ${s.progression.mode === M ? 'major' : 'minor'}`
  return {
    ...s, k, name, chorus, hook, stepMs, barN, key,
    ensemble: strings ? 'strings' : 'band',
    // Whole bars, the last the ending, with room after it for its ring.
    bars:  Math.floor(SONG_N / barN) - TAIL,
    cycle: length >= 8 ? length * 2 : length * 4,
    about: strings
      ? `${name} — ${key}, ${s.progression.name}, ${s.bpm} bpm strings; held bass, keys pad, singer ${s.singer.name}`
      : `${name} — ${key}, ${s.progression.name}, ${s.bpm} bpm ${s.feel.name}; bass ${s.bass}, guitar ${s.guitar}, keys ${s.keys}, singer ${s.singer.name}; chorus guitar ${chorus.guitar}, keys ${chorus.keys}`,
  }
}

/** The pentatonic of the song's key across the singer's register, as MIDI notes. */
function melodyOf(song) {
  const scale  = SCALES[song.progression.mode].map((d) => (song.tonic + d) % 12)
  const melody = []
  for (let n = 62; n <= 81; n++) if (scale.includes(n % 12)) melody.push(n)
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
 * The section bar `b` of a band's song is in: each cycle is a `verse`, a
 * `chorus`, a `verse` (a `bridge` every other cycle) and a `solo`. The
 * ending bar and a strings piece have none.
 */
export function sectionOf(song, b) {
  if (song.ensemble === 'strings' || b >= song.bars - 1) return null
  const c   = b % song.cycle
  const q   = Math.floor(c / (song.cycle / 4))
  const odd = Math.floor(b / song.cycle) % 2 === 1
  return q === 1 ? 'chorus' : q === 3 ? 'solo' : q === 2 && odd ? 'bridge' : 'verse'
}

/** The first slow piece after song `k`. */
export function stringsAfter(k) {
  for (let n = k + 1; n <= MAX_SONG; n++) if (songOf(n).ensemble === 'strings') return n
  return null
}

// ─── one bar, rendered ────────────────────────────────────────────────────

const hz = (n) => 440 * 2 ** ((n - 69) / 12)

/** The chord of bar `b`: its pitch classes, and voicings for each part. */
function chordOf(song, b) {
  const [deg, q] = song.progression.chords[((b % song.progression.chords.length) + song.progression.chords.length) % song.progression.chords.length]
  const root = (song.tonic + deg) % 12
  const pcs  = [root, (root + (q === M ? 4 : 3)) % 12, (root + 7) % 12]
  const near = (pc, center) => center - 6 + ((pc - (center - 6)) % 12 + 12) % 12
  return {
    pcs,
    bass:   40 + ((root - 4 + 12) % 12),
    keys:   pcs.map((pc) => near(pc, 60)).sort((a, b) => a - b),
    guitar: pcs.map((pc) => near(pc, 70)).sort((a, b) => a - b),
  }
}

// Every part is drawn from one `rand`, so the five are rendered in one pass:
// a part rendered alone would draw the others' numbers and play another song.
function renderBar(song, b) {
  const len   = song.barN * (1 + TAIL)
  const parts = PARTS.map(() => new Float32Array(len))
  const rand  = rng(Math.imul(song.k, 0x85ebca6b) ^ Math.imul(b + 1, 0xc2b2ae35))
  const swing = song.ensemble === 'strings' ? 0 : song.feel.swing
  const step  = (i) => ((i % 2 ? i + swing : i) * song.stepMs) / 1000
  const S     = song.stepMs / 1000
  // A hit a few ms off the grid, at a few percent off its gain: a player, not a sequencer.
  const loose = (i) => Math.max(0, step(i) + (rand() - 0.5) * 0.006)
  const vel   = () => 0.85 + 0.3 * rand()

  const add = (part, t0, dur, gain, fn) => {
    const out   = parts[part]
    const start = Math.floor(t0 * RATE)
    const end   = Math.min(len - start, Math.floor(dur * RATE))
    for (let i = 0; i < end; i++) out[start + i] += gain * fn(i / RATE, i)
  }
  // The mix at the section's level, and each part's peak per BLOCK, which is all `levels` reads.
  const done = (vol = 1) => {
    const mix   = new Float32Array(len)
    const peaks = parts.map((p) => {
      const e = new Float32Array(Math.ceil(len / BLOCK))
      for (let i = 0; i < len; i++) {
        const v = p[i] * vol
        mix[i] += v
        const a = Math.abs(v)
        const j = (i / BLOCK) | 0
        if (a > e[j]) e[j] = a
      }
      return e
    })
    return { mix, peaks }
  }
  const noiseHp = () => {
    let prev = 0
    return () => {
      const n = rand() * 2 - 1
      const y = n - prev
      prev = n
      return y
    }
  }

  const kick = (t0) => {
    let ph = 0
    add(PART.drums, t0, 0.4, 0.9 * vel(), (t) => {
      ph += (2 * Math.PI * (48 + 110 * Math.exp(-t * 35))) / RATE
      return Math.sin(ph) * Math.exp(-t * 7)
    })
  }
  const snare = (t0, g = 1) => {
    const n = noiseHp()
    add(PART.drums, t0, 0.25, 0.35 * g * vel(), (t) => n() * Math.exp(-t * 18) + 0.8 * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 30))
  }
  const rim = (t0) => add(PART.drums, t0, 0.06, 0.18 * vel(), (t) => Math.sin(2 * Math.PI * 820 * t) * Math.exp(-t * 70))
  // A closed hat on the beat is louder than one between.
  const hat = (t0, open, accent = true) => {
    const n = noiseHp()
    add(PART.drums, t0, open ? 0.3 : 0.05, (open ? 0.1 : accent ? 0.12 : 0.08) * vel(), (t) => n() * Math.exp(-t * (open ? 10 : 90)))
  }
  const crash = (t0) => {
    const n = noiseHp()
    add(PART.drums, t0, 2, 0.08, (t) => n() * Math.exp(-t * 2.2))
  }
  const bass = (t0, note, len) => {
    const inc = hz(note) / RATE
    let ph = 0
    let lp = 0
    add(PART.bass, t0, len, 0.32 * vel(), (t) => {
      ph = (ph + inc) % 1
      lp += (0.04 + 0.25 * Math.exp(-t * 12)) * (ph * 2 - 1 - lp)
      return lp * Math.min(1, t * 200) * Math.exp(-t * 3)
    })
  }
  const keys = (t0, notes, len = 0.25, pad = false) => {
    for (const note of notes) {
      const f = hz(note) * 1.002
      add(PART.keys, t0, len, pad ? 0.06 : 0.09, (t) => {
        const p   = (t * f) % 1
        const env = pad ? Math.min(1, t * 4) * Math.min(1, (len - t) * 8) : Math.min(1, t * 400) * Math.exp(-t * 11)
        return (4 * Math.abs(p - 0.5) - 1) * env
      })
    }
  }
  const guitar = (t0, note) => {
    const N   = Math.round(RATE / hz(note))
    const buf = Float32Array.from({ length: N }, () => rand() * 2 - 1)
    add(PART.guitar, t0, 1.2, 0.16 * vel(), (t, i) => {
      const j = i % N
      const y = buf[j]
      buf[j] = 0.497 * (buf[j] + buf[(j + 1) % N])
      return y
    })
  }
  const sing = (t0, note, len) => {
    const w = (2 * Math.PI * hz(note)) / RATE
    let ph = 0
    add(PART.singer, t0, len + 0.12, 0.13, (t) => {
      ph += w * (1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t * 3))
      const env = Math.min(1, t * 15) * (t > len ? Math.exp(-(t - len) * 30) : 1)
      return env * (Math.sin(ph) + 0.35 * Math.sin(2 * ph) + 0.12 * Math.sin(3 * ph))
    })
  }

  // A bow: a slow attack, vibrato that comes in after the note has settled,
  // and the harmonics of a saw rolled off, which is what separates it from `sing`.
  const bow = (t0, note, len) => {
    const w = (2 * Math.PI * hz(note)) / RATE
    let ph = 0
    add(PART.singer, t0, len + 0.5, 0.09, (t) => {
      ph += w * (1 + 0.012 * Math.sin(2 * Math.PI * 5.2 * t) * Math.min(1, Math.max(0, (t - 0.3) * 2)))
      const env = Math.min(1, t * 6) * (t > len ? Math.exp(-(t - len) * 8) : 1)
      // sin(h*ph) by recurrence: two trig calls a sample, not six
      const c = 2 * Math.cos(ph)
      let prev = 0
      let cur  = Math.sin(ph)
      let y    = cur
      for (let h = 2; h <= 6; h++) {
        const next = c * cur - prev
        prev = cur
        cur  = next
        y   += cur / h
      }
      return env * y
    })
  }

  const melody = melodyOf(song)
  // The chord's notes within the melody; a blues chord may have none there.
  const snap = (chord, note) => {
    const tones = melody.filter((n) => chord.pcs.includes(n % 12))
    return tones.length ? tones.reduce((best, n) => (Math.abs(n - note) < Math.abs(best - note) ? n : best)) : note
  }
  // A walk through the melody a step or two at a time, pulled to the chord on a downbeat.
  const walker = () => {
    let mel = Math.floor(rand() * melody.length)
    return (chord, downbeat) => {
      mel = Math.max(0, Math.min(melody.length - 1, mel + Math.round(rand() * 4 - 2)))
      if (!downbeat) return melody[mel]
      const note = snap(chord, melody[mel])
      mel = melody.indexOf(note)
      return note
    }
  }

  // The ending: every part on the tonic once, left to ring.
  if (b === song.bars - 1) {
    const home = chordOf({ ...song, progression: { chords: [[0, song.progression.mode]] } }, 0)
    const tonic = melody.find((n) => n % 12 === song.tonic && n >= 64) ?? melody[0]
    bass(0, home.bass, S * 16)
    keys(0, home.keys, S * 16, true)
    if (song.ensemble === 'strings') {
      bow(0, tonic, S * 14)
      return done()
    }
    crash(0)
    kick(0)
    home.guitar.forEach((n, i) => guitar(i * 0.012, n))
    sing(0, tonic, S * 12)
    return done()
  }

  const c     = b % song.cycle
  const chord = chordOf(song, b)
  const after = chordOf(song, b + 1)

  if (song.ensemble === 'strings') {
    // pad from the first bar, the bass a bar later, the voice from the third;
    // the voice breathes every fourth bar and the pad carries on under it
    keys(0, chord.keys, S * 16, true)
    if (b < 1) return done()
    bass(0, chord.bass, S * 8)
    bass(step(8), chord.bass, S * 8)
    if (b < 2 || c % 4 === 3) return done()
    const next = walker()
    for (const [at, len] of song.singer.phrases[c % 3]) bow(step(at), next(chord, at === 0), len * S)
    return done()
  }

  const section = sectionOf(song, b)
  const qLen    = song.cycle / 4
  const first   = c % qLen === 0           // the first bar of a quarter
  const fill    = (c + 1) % qLen === 0     // the last bar of a quarter: a fill into the next
  const solo    = section === 'solo'
  const bridge  = section === 'bridge'
  const chorus  = section === 'chorus'
  const vol     = b < 4 ? Math.min(VOL.verse, 0.6 + 0.1 * b) : VOL[section]
  const { feel } = song

  // drums
  if (first) crash(0)
  if (bridge) {
    // the bridge breathes: the kick on one and three, the backbeat a rim, the hat on the beat
    for (const i of [0, 8]) kick(loose(i))
    for (const i of feel.snare ?? feel.rim) rim(loose(i))
    for (const i of [0, 4, 8, 12]) hat(loose(i), false, false)
  } else {
    // the fill takes the last beat: a backbeat under it would double the first hit
    for (const i of feel.kick) kick(loose(i))
    for (const i of feel.snare ?? []) if (!(fill && i >= 12)) snare(loose(i))
    for (const i of feel.rim ?? []) if (!(fill && i >= 12)) rim(loose(i))
    for (const i of feel.hat) if (!(fill && i >= 12)) hat(loose(i), false, i % 4 === 0)
    for (const i of feel.open) if (!(fill && i >= 12)) hat(loose(i), true)
    // a ghost on an offbeat half the time, never under the fill
    if (feel.snare && rand() < 0.5) snare(loose(fill || rand() < 0.5 ? 7 : 15), 0.25)
  }
  // four sixteenths climbing; their tails overlap, so the last lands under the backbeat's gain
  if (fill) [12, 13, 14, 15].forEach((i, j) => snare(loose(i), 0.4 + j * 0.15))
  if (b < 1) return done(vol)

  // bass
  if (bridge) {
    bass(loose(0), chord.bass, S * 7.5)
    bass(loose(8), chord.bass, S * 7.5)
  } else if (song.bass === 'on the kick') {
    for (const i of feel.kick) bass(loose(i), chord.bass, S * 2.5)
    bass(loose(14), chord.bass + 12, S * 1.5)
  } else if (song.bass === 'eighths') {
    for (const i of EIGHTS) bass(loose(i), chord.bass + (i === 6 || i === 14 ? 12 : 0), S * 1.6)
  } else {
    const walk = [chord.bass, chord.bass + 7, chord.bass + 12, after.bass + (after.bass > chord.bass ? -1 : 1)]
    walk.forEach((n, i) => bass(loose(i * 4), n, S * 3.5))
  }
  if (b < 2) return done(vol)

  // keys: the bridge's a pad, the chorus's its own; out for the solo's first two bars so the guitar steps forward alone
  const keyset = bridge ? 'pad' : chorus ? song.chorus.keys : song.keys
  if (!(solo && c < (song.cycle * 3) / 4 + 2)) {
    if (keyset === 'stabs') for (const i of [2, 6, 10, 14]) keys(step(i), chord.keys)
    else if (keyset === 'backbeat') for (const i of [4, 12]) keys(step(i), chord.keys)
    else keys(0, chord.keys, S * 16, true)
  }

  // guitar: the melody walked in the solo, out in the bridge, its chorus style in the chorus
  if (solo) {
    const next = walker()
    steps(euclid(6, 16, c % 4)).forEach((i, j) => guitar(loose(i), next(chord, j === 0)))
  } else if (!bridge) {
    const style = chorus ? song.chorus.guitar : song.guitar
    if (style === 'strummed') {
      for (const i of [0, 6, 10]) {
        const t = loose(i)
        chord.guitar.forEach((n, j) => guitar(t + j * 0.012, n))
      }
    } else {
      const at = style === 'arpeggio' ? steps(euclid(5, 16, 3)) : steps(euclid(7, 16, 1))
      at.forEach((i, j) => guitar(loose(i), chord.guitar[j % 3]))
    }
  }

  // singer, from the fourth bar, resting under the fill and through the solo;
  // the hook in the chorus, a walk elsewhere, the bridge's in long phrases
  if (b < 4 || solo || fill) return done(vol)
  if (chorus) {
    for (const [at, len, mel] of song.hook[c % 2]) sing(step(at), at === 0 ? snap(chord, melody[mel]) : melody[mel], len * S)
  } else {
    const next    = walker()
    const phrases = bridge ? LONG.phrases : song.singer.phrases
    for (const [at, len] of phrases[c % 2]) sing(step(at), next(chord, at === 0), len * S)
  }
  return done(vol)
}

// ─── the stream ───────────────────────────────────────────────────────────

/**
 * Every song from the epoch: `samples(from, n)` is samples `from`..`from+n`,
 * in -1..1. `seat(cue)` is a request heard: samples before its `at` still
 * follow the cue it replaces, since a pull may already have passed the bar.
 * `levels(from, cols, width)` is how loud each of `PARTS` was, for the
 * loft's scope.
 */
export function createBand() {
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
  const barFor = (song, b) => {
    const key = `${song.k}:${b}`
    let buf = bars.get(key)
    if (!buf) {
      const bar = renderBar(song, b)
      buf = bar.mix
      bars.set(key, buf)
      if (bars.size > TAIL + 2) bars.delete(bars.keys().next().value)
      peaked.set(key, bar.peaks)
      if (peaked.size > 16) peaked.delete(peaked.keys().next().value)
    }
    return buf
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
      const out  = new Float32Array(n)
      let c      = null
      let k      = null
      let song   = null
      let b      = null
      let held   = []   // [bar, buffer] of this bar and the TAIL before it that are in the song
      for (let i = 0; i < n; i++) {
        const s  = from + i
        const cs = s >= cue.from ? cue : was
        const ks = cs.first + Math.floor((s - cs.from) / SONG_N)
        if (cs !== c || ks !== k) { c = cs; k = ks; song = songFor(k); b = null }
        const local = s - c.from - (k - c.first) * SONG_N
        const bs    = Math.floor(local / song.barN)
        if (bs !== b) {
          b    = bs
          held = []
          for (let j = 0; j <= TAIL; j++) if (b - j >= 0 && b - j < song.bars) held.push([b - j, barFor(song, b - j)])
        }
        let x = 0
        for (const [bj, buf] of held) x += buf[local - bj * song.barN]
        out[i] = Math.tanh(x * 1.2) * 0.8
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
