// src/lib/working.js — what a `#workers` session is doing, as one glyph, so
// the kitchen's cook and the workshop's figure say it alike. Pure.
//
// A session the model is writing for spins through `SPIN`, the frames
// Claude Code's own spinner turns; one inside a tool holds `TOOL` still, so
// a slow tool and a long think are told apart at a glance.

export const SPIN = ['·', '✢', '✳', '✶', '✻', '✽']
export const TOOL = '⚙'

/** `asking`, `said`, `tool` (waiting on a tool's answer) or `cooking` (the model is writing). */
export const stateOf = (w) => (w.asking ? 'asking' : w.said ? 'said' : w.tool ? 'tool' : 'cooking')

/** A cooking session's frame at `now`, a frame a second, as the rooms read `#workers`. */
export const spinAt = (now) => SPIN[Math.floor(now / 1000) % SPIN.length]

// What a session's words say it was on, picked out of a readout in its own
// ink: a plan step (`3.2`) or a register row (`FJS-123`, `FJS-D45`).
export const TASK = /\b(?:FJS-D?\d+|\d+\.\d+(?:\.\d+)?)\b/g
