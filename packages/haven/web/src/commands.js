// src/commands.js — the commands a line beginning `/` can name, and Tab's
// completion of one. Pure: `Scene.mesa` owns what each command does.
//
// Only the command word completes. Once a space is typed the line is on its
// arguments, and a Tab there would rewrite a nick.

export const COMMANDS = ['ban', 'map', 'unban']

// A line is completable while it is `/` and a partial word and nothing more.
export const partial = (line) => /^\/\S*$/.test(line) ? line.slice(1) : null

export function matches(line) {
  const word = partial(line)
  return word === null ? [] : COMMANDS.filter((c) => c.startsWith(word))
}

// What Tab makes of the line: the longest prefix the matches share, and a
// space after a lone match so its argument can be typed at once.
export function complete(line) {
  const found = matches(line)
  if (!found.length) return line
  if (found.length === 1) return `/${found[0]} `
  let prefix = found[0]
  for (const c of found) while (!c.startsWith(prefix)) prefix = prefix.slice(0, -1)
  return `/${prefix}`
}
