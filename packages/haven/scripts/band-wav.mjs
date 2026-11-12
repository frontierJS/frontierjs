// scripts/band-wav.mjs — `bun run band:wav <k> [--from bar] [--bars n] [--solo part[,part]] [--conductor json] [--out dir]`:
// song `k` rendered through `createBand()` into a 16-bit WAV under `.wav/`
// (gitignored), so a change to `shared/band.js` is heard against the last one
// outside Haven, and what each bar cost to render is printed beside it.
// `--conductor` is the band mixer's choices (`editor/Mixer.mesa`, `songOf`), and
// the file is named for a hash of them, so two mixes of one song sit side by side.
//
// A bar is pulled alone, one `samples()` call each, so a pull's time is that
// bar's render time. The first pull from a bar past 0 also renders the TAIL
// bars before it, and says so. A bar slower than a third of `AHEAD_MS`
// (`web/src/lib/band/sound.js`) leaves a gap in the sound.
//
// `samples()` answers an array of Float32Arrays, one per channel (a bare one is
// mono), and the header and the interleave follow whichever it is.

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBand, songOf, PARTS, RATE, SONG_MS } from '../shared/band.js'

const HERE   = dirname(fileURLToPath(import.meta.url))
const SONG_N = (SONG_MS / 1000) * RATE

const die = (msg) => {
  console.log(msg)
  process.exit(1)
}

function args(argv) {
  const opt = { k: null, from: 0, bars: null, solo: null, conductor: null, out: join(HERE, '..', '.wav') }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from') opt.from = Number(argv[++i])
    else if (a === '--bars') opt.bars = Number(argv[++i])
    else if (a === '--solo') opt.solo = argv[++i].split(',')
    else if (a === '--out') opt.out = argv[++i]
    else if (a === '--conductor') {
      try { opt.conductor = JSON.parse(argv[++i]) } catch { die('band:wav: --conductor is the JSON the band mixer copies') }
    }
    else if (opt.k === null && !a.startsWith('--')) opt.k = Number(a)
    else die(`band:wav: unknown argument ${a}`)
  }
  if (!Number.isInteger(opt.k) || opt.k < 0) die('usage: bun run band:wav <k> [--from bar] [--bars n] [--solo part[,part]] [--conductor json] [--out dir]')
  if (!Number.isInteger(opt.from) || opt.from < 0) die('band:wav: --from is a whole bar number')
  if (opt.bars !== null && (!Number.isInteger(opt.bars) || opt.bars < 1)) die('band:wav: --bars is a whole number of bars, at least 1')
  if (opt.solo !== null && !opt.solo.every((p) => PARTS.includes(p))) die(`band:wav: --solo is one or more of ${PARTS.join(', ')}`)
  return opt
}

/** A 16-bit PCM WAV of `channels`, one Float32Array of -1..1 per channel, interleaved. */
function wav(channels) {
  const nch   = channels.length
  const n     = channels[0].length
  const bytes = n * nch * 2
  const buf   = Buffer.alloc(44 + bytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + bytes, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(nch, 22)
  buf.writeUInt32LE(RATE, 24)
  buf.writeUInt32LE(RATE * nch * 2, 28)
  buf.writeUInt16LE(nch * 2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(bytes, 40)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]))
      buf.writeInt16LE(Math.round(v * 32767), 44 + (i * nch + c) * 2)
    }
  }
  return buf
}

const opt  = args(process.argv.slice(2))
const song = songOf(opt.k, opt.conductor ?? {})
const last = Math.min(song.bars, opt.from + (opt.bars ?? song.bars))
if (opt.from >= song.bars) die(`band:wav: song ${opt.k} has ${song.bars} bars, --from ${opt.from} is past the end`)

const band   = createBand({ solo: opt.solo, conductor: opt.conductor ?? {} })
const pulls  = []
const timing = []
for (let b = opt.from; b < last; b++) {
  const t0   = performance.now()
  const got  = band.samples(opt.k * SONG_N + b * song.barN, song.barN)
  timing.push([b, performance.now() - t0])
  pulls.push(Array.isArray(got) ? got : [got])
}
const channels = pulls[0].map((_, c) => {
  const out = new Float32Array(pulls.length * song.barN)
  pulls.forEach((p, i) => out.set(p[c], i * song.barN))
  return out
})

const name = `song-${opt.k}` + (opt.from ? `-from${opt.from}` : '') + (opt.bars ? `-bars${opt.bars}` : '') + (opt.solo ? `-solo-${opt.solo.join('-')}` : '')
  + (opt.conductor ? `-conducted-${createHash('sha1').update(JSON.stringify(opt.conductor)).digest('hex').slice(0, 6)}` : '')
const path = join(opt.out, `${name}.wav`)
mkdirSync(opt.out, { recursive: true })
writeFileSync(path, wav(channels))

console.log(song.about)
console.log(path)
for (const [b, ms] of timing) console.log(`bar ${b}  ${ms.toFixed(1)} ms${b === opt.from && opt.from > 0 ? '  (first pull includes tails)' : ''}`)
const worst = timing.reduce((w, t) => (t[1] > w[1] ? t : w))
const mean  = timing.reduce((s, t) => s + t[1], 0) / timing.length
console.log(`worst bar ${worst[0]}  ${worst[1].toFixed(1)} ms, mean ${mean.toFixed(1)} ms over ${timing.length} bars`)
