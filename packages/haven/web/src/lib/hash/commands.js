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
// then the ones with none. Of two as near, the one the figure faces comes
// first when `at` carries a `facing`, so a key pressed between two boards
// reaches the one looked at.
//
// A mode (the history pane, the map, the home row's waiting operator, a
// find-walk) is the one thing open over the art. Its `keys` take a key before
// the figure does; Esc is the mode's close unless it names Esc itself. A mode
// with a `take` is handed every other key, Esc included, and answers whether
// it took it; a key it lets go walks, or reaches a verb. Opening one closes
// the one before it.
//
// Only the command word completes. Once a space is typed the line is on its
// arguments, and a Tab there would rewrite a nick.
//
// A stop (`IDEAS/haven.md` Phase 19) is a place Tab reaches, derived and never
// declared: the verbs whose reaches overlap, merged into one, and each door of
// the stage's `marks` that is neither `hidden` nor `night` -- both are found by
// stepping, and Tab naming one would give it away. Its `reaches` are where
// standing answers it (a door's are its own cells, within 0); with a `to` it is
// a door. Doors come first, since every scene file puts its `<slot />`, where
// the verbs' actors mount, after its placed tags.

const away = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))

const overlap = (a, b) => away(a, b) <= a.within + b.within

// A cell the way `at.facing` names, past the figure's own row or column.
const LOOKS = { n: (d) => d.y < 0, e: (d) => d.x > 0, s: (d) => d.y > 0, w: (d) => d.x < 0 }
const faced = (at, cell) => !!LOOKS[at?.facing]?.({ x: cell.x - at.x, y: cell.y - at.y })

/** Whether a verb answers a figure at `at`: no reach is always, a reach only within it. */
export const reaches = (verb, at) => !verb.reach || (!!at && away(verb.reach, at) <= verb.reach.within)

export function createCommands() {
  const verbs = new Set()
  let mode = null

  const nearest = (list, at) => list
    .map((verb, i) => ({ verb, i, d: verb.reach ? away(verb.reach, at) : Infinity, f: verb.reach && faced(at, verb.reach) ? 0 : 1 }))
    .sort((a, b) => a.d - b.d || a.f - b.f || a.i - b.i)
    .map((e) => e.verb)

  const shut = () => {
    const done = mode
    mode = null
    done.closed?.()
  }

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

    /**
     * The scene's stops in mount order: the doors among `marks` (the stage's,
     * in placing order -- `stage.doors` is claim order and a cell apiece), then
     * every verb with a reach, those whose reaches overlap merged into one,
     * named by their words (`/board /pin`) and a door by its `to`.
     */
    stops(marks = []) {
      const shown = marks
        .filter((d) => d.kind === 'door' && !d.hidden && !d.night)
        .map((d) => {
          const reaches = []
          for (let dy = 0; dy < (d.h ?? 1); dy++) for (let dx = 0; dx < (d.w ?? 1); dx++) reaches.push({ x: d.x + dx, y: d.y + dy, within: 0 })
          return { name: d.to, to: d.to, reaches }
        })
      const groups = []
      for (const v of verbs) {
        if (!v.reach) continue
        const met = groups.filter((g) => g.some((o) => overlap(o.reach, v.reach)))
        const into = met[0] ?? []
        if (!met.length) groups.push(into)
        for (const g of met.slice(1)) { into.push(...g); groups.splice(groups.indexOf(g), 1) }
        into.push(v)
      }
      const named = groups.map((g) => {
        const words = [...new Set(g.filter((v) => v.word).map((v) => `/${v.word}`))]
        return { name: (words.length ? words : [...new Set(g.map((v) => v.key))]).join(' '), reaches: [...new Set(g.map((v) => v.reach))] }
      })
      return [...shown, ...named]
    },

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

    /** Closes the open mode if it is the one named; true when it was. */
    close(name) {
      if (mode?.name !== name) return false
      shut()
      return true
    },

    /** A key into the open mode; true when the mode took it. */
    modeKey(event) {
      if (!mode) return false
      const own = mode.keys?.[event.key]
      if (own) { own(event); return true }
      if (mode.take) return mode.take(event) === true
      if (event.key !== 'Escape') return false
      shut()
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

/**
 * The slash lines said this session, for Up and Down in the input. Arrows walk
 * on an empty line, so the caller recalls only when the draft starts with `/`
 * or `browsing` is true -- an empty draft reached by Down must keep recalling.
 */
export function createHistory(max = 50) {
  const lines = []
  let at = null
  let stash = ''

  return {
    get browsing() { return at !== null },

    /** Keeps a said line if it is a command and not the one before it; ends any browse. */
    push(line) {
      at = null
      if (!line.startsWith('/') || lines.at(-1) === line) return
      lines.push(line)
      if (lines.length > max) lines.shift()
    },

    /** The next older line, holding `draft` for the way back down; null when there is none. */
    prev(draft) {
      if (!lines.length) return null
      if (at === null) { stash = draft; at = lines.length - 1 } else if (at > 0) at--
      return lines[at]
    },

    /** The next newer line, then the held draft; null when not browsing. */
    next() {
      if (at === null) return null
      if (at < lines.length - 1) return lines[++at]
      at = null
      return stash
    },
  }
}
