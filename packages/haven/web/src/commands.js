// src/commands.js — the one registry of what a member can say or press here
// (`IDEAS/haven.md` 12.4), and Tab's completion of a command word. Pure:
// `Scene.mesa` owns the input line, and each actor owns what its verbs do.
//
// An actor — `Whisper.mesa`, `Taskmaster.mesa`, a booth's `Sitting.mesa` —
// adds verbs to `$context.commands`: `{ word?, aliases?, key?, help, run,
// reach? }`. What a member can say is the merge of the verbs with no `reach`
// (their own, the room's) and those whose `reach` holds for where they stand
// now, `reach: { x, y, within }` being a cell and how many cells round it. A
// word and a key are looked up the same way: the nearest verb in reach first,
// then the ones with none.
//
// A mode (the history pane, the map) is the one thing open over the art. Its
// `keys` take a key before the figure does; Esc is the mode's close unless it
// names Esc itself. Opening one closes the one before it.
//
// Only the command word completes. Once a space is typed the line is on its
// arguments, and a Tab there would rewrite a nick.

const away = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))

/** Whether a verb answers a figure at `at`: no reach is always, a reach only within it. */
export const reaches = (verb, at) => !verb.reach || (!!at && away(verb.reach, at) <= verb.reach.within)

export function createCommands() {
  const verbs = new Set()
  let mode = null

  const nearest = (list, at) => list
    .map((verb, i) => ({ verb, i, d: verb.reach ? away(verb.reach, at) : Infinity }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((e) => e.verb)

  const words = (at) => {
    const seen = new Set()
    for (const v of verbs) if (v.word && reaches(v, at)) seen.add(v.word)
    return [...seen].sort()
  }

  const find = (word, at) => {
    const named = [...verbs].filter((v) => v.word === word || v.aliases?.includes(word))
    if (!named.length) return null
    const here = nearest(named.filter((v) => reaches(v, at)), at)
    return here.length ? { verb: here[0], reached: true } : { verb: named[0], reached: false }
  }

  return {
    /** Adds a verb; returns what takes it away. */
    add(verb) {
      if (typeof verb?.run !== 'function') throw new Error('a verb needs a run')
      if (!verb.word && !verb.key) throw new Error('a verb needs a word or a key')
      if (verb.word && !verb.help) throw new Error(`/${verb.word} needs a help`)
      verbs.add(verb)
      return () => verbs.delete(verb)
    },

    /** The command words a figure at `at` can say, sorted; an alias is left out. */
    words,

    /** One line of help per word in reach, in the order Tab lists them. */
    helps: (at) => words(at).map((w) => find(w, at).verb.help),

    /** The verb a word names for a figure at `at`; `reached` is false when it exists only out of reach. */
    find,

    /** Delivers a key to the verbs in reach that name it, nearest first, until one takes it (a `run` answering false passes it on). */
    press(key, at, event) {
      for (const v of nearest([...verbs].filter((o) => o.key === key && reaches(o, at)), at)) {
        if (v.run({ key, event, at }) !== false) return true
      }
      return false
    },

    /** Opens a mode over the art; returns its close. The mode's `closed()` runs when it is closed or replaced. */
    open(next) {
      const was = mode
      mode = next
      was?.closed?.()
      return () => {
        if (mode !== next) return
        mode = null
        next.closed?.()
      }
    },

    get mode() { return mode },

    /** A key into the open mode; true when the mode took it. */
    modeKey(event) {
      if (!mode) return false
      const own = mode.keys?.[event.key]
      if (own) { own(event); return true }
      if (event.key !== 'Escape') return false
      const done = mode
      mode = null
      done.closed?.()
      return true
    },
  }
}

// A line is completable while it is `/` and a partial word and nothing more.
export const partial = (line) => /^\/\S*$/.test(line) ? line.slice(1) : null

/** The words (`commands.words(at)`) the line's partial word starts. */
export function matches(line, words) {
  const word = partial(line)
  return word === null ? [] : words.filter((c) => c.startsWith(word))
}

// What Tab makes of the line: the longest prefix the matches share, and a
// space after a lone match so its argument can be typed at once.
export function complete(line, words) {
  const found = matches(line, words)
  if (!found.length) return line
  if (found.length === 1) return `/${found[0]} `
  let prefix = found[0]
  for (const c of found) while (!c.startsWith(prefix)) prefix = prefix.slice(0, -1)
  return `/${prefix}`
}
