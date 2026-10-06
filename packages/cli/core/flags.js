// ─── flags.js — what a declared flag permits, and how it is written ──────────
//
// A leaf with no imports: `fli list`, `--help` and completion read it on the
// startup path, which may not import zx, and `getConfig` in `runtime.js` is the
// one place a value is graded against it.
//
// A flag is named for what it DOES. A boolean that is on unless asked is
// declared `push` with `defaultValue: true` and typed `--no-push`, which is
// the argv parser's own reading — so `no-push` is never a declaration,
// and one is refused by name rather than read as a second flag that the
// negation silently never reaches. Its `description` says what `--no-push`
// does, because that is the spelling every listing prints.
//
// `choices`, `min` and `max` are the constraints. Each is checked where the
// declaration is read, so a range on a string or a `choices` written as one
// string is a message at the first run rather than a check that never fires.
//
// JSON is `--json`, a boolean, on every command (`FJS-D401`). `--as` picks
// among the layouts a PERSON reads, which may change; `--json` is what a
// program reads, which may not. An `as` offering `json` is refused, so the
// contract has one spelling.

/** The spelling somebody types: `--no-push` for a boolean that defaults on. */
export const flagSpelling = (name, def = {}) =>
  def.type === 'boolean' && def.defaultValue === true ? `--no-${name}` : `--${name}`

/** `table|json|csv`, `5–90`, `≥ 5`, or '' — for help, completion and the GUI. */
export function flagConstraint(def = {}) {
  if (Array.isArray(def.choices)) return def.choices.join('|')
  const lo = def.min !== undefined, hi = def.max !== undefined
  if (lo && hi) return `${def.min}–${def.max}`
  if (lo)       return `≥ ${def.min}`
  if (hi)       return `≤ ${def.max}`
  return ''
}

/** What is wrong with a declaration, or null. */
export function declarationProblem(name, def = {}) {
  if (name.startsWith('no-')) {
    const positive = name.slice(3)
    return `\`${name}\` is declared as a flag. Name it for what it does — \`${positive}\` with ` +
           `type: boolean and defaultValue: true — and \`--${name}\` turns it off; read it as ` +
           `\`flag.${positive}\`.`
  }
  if ('options' in def) {
    return `\`${name}\` declares \`options\`. The allowed values are \`choices\`, a list, one \`- value\` per line.`
  }
  if ('choices' in def && !(Array.isArray(def.choices) && def.choices.length)) {
    return `\`${name}\`'s \`choices\` is ${JSON.stringify(def.choices)}. Write a list, one \`- value\` per ` +
           `line under \`choices:\` — the frontmatter reader takes no \`[a, b]\` form.`
  }
  if (name === 'as' && Array.isArray(def.choices) && def.choices.includes('json')) {
    return `\`as\` offers \`json\`. JSON is \`--json\`, a boolean flag of its own; \`as\` picks among the ` +
           `layouts a person reads.`
  }
  for (const bound of ['min', 'max']) {
    if (!(bound in def)) continue
    if (def.type !== 'number') return `\`${name}\` declares \`${bound}\` and is not type: number.`
    if (typeof def[bound] !== 'number') return `\`${name}\`'s \`${bound}\` is ${JSON.stringify(def[bound])}, not a number.`
  }
  return null
}

/**
 * What is wrong with one value given for a declared flag, or null. `flags` is
 * the command's whole declaration, so `--as=json` can name `--json`.
 */
export function valueProblem(name, def = {}, value, flags = {}) {
  if (Array.isArray(def.choices) && !def.choices.map(String).includes(String(value))) {
    const instead = String(value) === 'json' && flags.json ? ' — the model is `--json`' : ''
    return `[${name}] must be one of: ${def.choices.join(', ')} — got ${value}${instead}`
  }
  if (typeof value === 'number') {
    const { min, max } = def
    if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
      const range = min !== undefined && max !== undefined ? `between ${min} and ${max}`
                  : min !== undefined ? `at least ${min}` : `at most ${max}`
      return `[${name}] must be ${range} — got ${value}`
    }
  }
  return null
}
