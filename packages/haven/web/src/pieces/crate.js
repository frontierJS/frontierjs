// src/pieces/crate.js — a crate, slatted on two faces.
import { piece } from './index.js'

export const crate = piece('crate', String.raw`
 _____
|_|_|_|
|_|_|_|
`, String.raw`
 wwwww
wwwwwww
wwwwwww
`)
