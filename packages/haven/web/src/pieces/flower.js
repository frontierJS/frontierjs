// src/pieces/flower.js — one flower, walked over; a bed is a `<Row>` of them.
import { piece } from './index.js'

export const flower = piece('flower', '*', 'p', { floor: true })
