// argv.js — the command line into `{ _: [...positionals], ...flags }`.
// Read before the command is known, so a value's type is decided by how it
// LOOKS; getConfig coerces each flag toward the command's declaration after.
//
// `bools` are the names that never take a value — without them `fli x --dry foo`
// reads as `{ dry: 'foo' }`. A boolean that was not typed is ABSENT, never
// false: getConfig reads a defined long name as "given", and a defaulted
// `dry: false` beside `-d` once ran `db:import` for real.

// fli's own booleans, on every command.
export const BOOL_ARGV = ['help', 'h', 'dry', 'd', 'verbose']

const NUMBER = /^(?:0x[0-9a-f]+|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)$/i
const IS_FLAG = /^--?[^-]/

const coerce = (v) => typeof v === 'string' && NUMBER.test(v) ? Number(v) : v

export function parseArgv(args, { bools = [] } = {}) {
  const isBool = new Set(bools)
  const out = { _: [] }

  // Twice is an array — getConfig refuses one unless the flag is `multiple`.
  // A boolean is overwritten, so `-d --dry` is not two values.
  const set = (key, value) => {
    if (isBool.has(key)) value = value === 'false' ? false : value === 'true' ? true : value
    else value = coerce(value)
    const prev = out[key]
    if (prev === undefined || isBool.has(key) || typeof prev === 'boolean') out[key] = value
    else if (Array.isArray(prev)) prev.push(value)
    else out[key] = [prev, value]
  }

  // `--key value`, `-k value`: the next word is the value unless it is a flag,
  // or the key never takes one — and a boolean still takes a literal true/false.
  const valueOrTrue = (key, i) => {
    const next = args[i + 1]
    if (next !== undefined && !IS_FLAG.test(next) && !isBool.has(key)) { set(key, next); return i + 1 }
    if (next === 'true' || next === 'false') { set(key, next === 'true'); return i + 1 }
    set(key, true)
    return i
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--') { out._.push(...args.slice(i + 1)); break }

    if (/^--[^=]+=/.test(arg)) {
      const eq = arg.indexOf('=')
      const key = arg.slice(2, eq)
      const value = arg.slice(eq + 1)
      set(key, isBool.has(key) ? value !== 'false' : value)
    } else if (/^--no-.+/.test(arg)) {
      set(arg.slice(5), false)
    } else if (/^--.+/.test(arg)) {
      i = valueOrTrue(arg.slice(2), i)
    } else if (/^-[^-]+/.test(arg)) {
      // `-dt` is two flags; `-p8080`, `-p=8080` and `-o/tmp` are one with a value.
      const letters = arg.slice(1)
      let rest = false
      for (let j = 0; j < letters.length - 1; j++) {
        const tail = letters.slice(j + 1)
        if (tail[0] === '=') { set(letters[j], tail.slice(1)); rest = true; break }
        if (/[A-Za-z]/.test(letters[j]) && NUMBER.test(tail)) { set(letters[j], tail); rest = true; break }
        if (/\W/.test(tail[0])) { set(letters[j], tail); rest = true; break }
        set(letters[j], true)
      }
      if (!rest) i = valueOrTrue(letters.at(-1), i)
    } else {
      out._.push(coerce(arg))
    }
  }
  return out
}
