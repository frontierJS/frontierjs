// src/pieces/ladder.js — a ladder `rows` tall, walked up as floor.
import { piece } from './index.js'

/** @param {number} rows */
export const ladder = (rows) => piece('ladder', Array(rows).fill('H').join('\n'), Array(rows).fill('l').join('\n'), { floor: true })
