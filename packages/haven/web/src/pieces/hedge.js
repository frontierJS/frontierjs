// src/pieces/hedge.js — one cell of hedge, a wall; a hedge is a `<Row>` of
// them with a gap left where a path goes through. Its `G` is the scene's.
import { piece } from './index.js'

export const hedge = piece('hedge', ',', 'G')
