// src/pieces/camp.js — what a lookout keeps: the ravine's telescope on its
// stand. Paint letter `q` is the scene's.
import { piece } from './index.js'

export const telescope = piece('telescope', String.raw`
 __
[__]>
  |
 /|\
`, String.raw`
 qq
qqqqq
  q
 qqq
`)
