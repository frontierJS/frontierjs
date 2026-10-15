// src/pieces/signpost.js — a signpost and a sign, each read by its text. A
// signpost's arrow is part of its label (`[square]>`, `v[road]`) and its post
// stands under the label's middle; a sign is the text lying on the ground with
// no post. Both are floor, so a figure reads one by walking over it.
import { piece } from './index.js'

/** @param {string} label */
export function signpost(label) {
  const mid = Math.floor(label.length / 2)
  const pad = ' '.repeat(mid - 1)
  return piece('signpost',
    `${label}\n${pad} |\n${pad}_|_`,
    `${'e'.repeat(label.length)}\n${pad} l\n${pad}lll`,
    { floor: true })
}

/** @param {string} text */
export const sign = (text) => piece('sign', text, 'e'.repeat(text.length), { floor: true })
