// src/pieces/town.js — what a town puts out of doors: a house with a sign over
// its door, the well, the stalls, a fence, the milestone, the range's wind
// flag, the fountain and its basin. Paint letters are the scene's.
import { piece, lines } from './index.js'

/**
 * The 20-wide house the workshop and the town hall are, the sign over the
 * door; `sign` is the text between its brackets, centered left of a tie.
 * @param {string} sign
 */
export function house(sign) {
  const label = `[ ${sign} ]`
  const left = Math.floor((16 - label.length) / 2)
  const row = ' '.repeat(left) + label + ' '.repeat(16 - label.length - left)
  const ink = [...row].map((c) => c === '[' || c === ']' ? 'S' : c === ' ' ? ' ' : 's').join('')
  return piece('house', String.raw`
   ~'
   ||
  _||_____________
 //\/\/\/\/\/\/\/\\
/__________________\
 |${row}|
 |                |
 |  []   .-.  []  |
 |_______|n|______|
`, String.raw`
   kk
   cc
  rccrrrrrrrrrrrrr
 rRRRRRRRRRRRRRRRRr
rrrrrrrrrrrrrrrrrrrr
 w${ink}w
 w                w
 w  yy   ddd  yy  w
 wwwwwwwwdddwwwwwww
`)
}

export const well = piece('well', String.raw`
   __
  /||\
 |~~~~|
 |____|
`, String.raw`
   uu
  uwwu
 wbbbbw
 wwwwww
`)

export const stall = piece('stall', String.raw`
 _________
/_________\
 |  o  o  |
 |________|
`, String.raw`
 rrrrrrrrr
rrrrrrrrrrr
 w  p  p  w
 wwwwwwwwww
`)

/**
 * The market's stall: a keeper's stool behind the counter and a customer's in
 * front as a seat pair, the lantern at the middle of the counter a `burn`.
 * `wares` and `inks` are the nine cells between its posts.
 * @param {string} name
 * @param {string} awning
 * @param {string} wares
 * @param {string} inks
 */
export const marketStall = (name, awning, wares, inks) => piece(name, String.raw`
 ___________
/_/_/_/_/_/_\
 |    o    |
 |${wares}|
      o
`, String.raw`
 ${awning.repeat(11)}
${awning}${('W' + awning).repeat(6)}
 l    s    l
 l${inks}l
      s
`, { overhead: 2, spots: {
    keeper:   { kind: 'seat', dx: 6, dy: 2, stand: { dx: 5, dy: 2 }, mate: 'customer' },
    customer: { kind: 'seat', dx: 6, dy: 4, stand: { dx: 5, dy: 4 }, mate: 'keeper' },
    lantern:  { kind: 'burn', dx: 6, dy: 3 },
  } })

/**
 * Posts and rails, `posts` of them, painted `key`.
 * @param {number} posts
 * @param {string} [key]
 */
export const fence = (posts, key = 'f') => piece('fence', '|--'.repeat(posts) + '|', key.repeat(3 * posts + 1))

export const milestone = piece('milestone', String.raw`
 .-.
 |I|
 |_|
`, String.raw`
 qqq
 qeq
 qqq
`)

export const flag = piece('flag', '|>\n|\n|', 'lF\nl\nl')

const FOUNTAIN = [String.raw`
      .  :  .
       ' | '
   .-----=-----.
 .'~~~~~~~~~~~~~'.
(~~~~~~~~~~~~~~~~~)
 '.~~~~~~~~~~~~~.'
   '----~~~----'
`, String.raw`
      j  j  j
       j j j
   sssssssssssss
 ssbbbbbbbbbbbbbss
sbbbbbbbbbbbbbbbbbs
 ssbbbbbbbbbbbbbss
   sssssbbbsssss
`]

// One drawing, two pieces: the rim is a wall, the water inside is walked
// through, and three cells of water break the front rim as the way in. A cell
// has one owner, so each takes its own paint keys. The jet is the top two rows
// and floor like the water: a figure stands on the spray, drawn over it rather
// than hidden under it.
const carve = (name, keys, options) => {
  const [art, paint] = FOUNTAIN.map(lines)
  const keep = (row, dy) => [...row].map((ch, dx) => keys.includes(paint[dy]?.[dx]) ? ch : ' ').join('')
  return piece(name, art.map(keep).join('\n'), paint.map((r) => [...r].map((k) => keys.includes(k) ? k : ' ').join('')).join('\n'), options)
}
export const fountain = carve('fountain', 's')
export const basin = carve('fountain water', 'bj', { floor: true })
