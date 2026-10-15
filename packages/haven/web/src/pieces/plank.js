// src/pieces/plank.js — a plank `w` wide laid over water, the gangway onto
// the ferry at both its ends (`ferry.js`).
import { piece } from './index.js'

/** @param {number} w */
export const plank = (w) => piece('plank', '='.repeat(w), 'u'.repeat(w), { floor: true })
