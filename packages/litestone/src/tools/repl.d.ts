// @frontierjs/litestone/repl — the console loop. `litestone repl` binds `db` and
// `sys`; `junction call` with no method word binds the booted app (FJS-D1532).

type Command = { help?: string; run(ctx: Record<string, unknown> & { args: string[]; out: (line: string) => void; tenant: string | null }): unknown }

export declare function startRepl(opts: {
  /** Every name an expression can read, and all `.help` lists. */
  binds:         Record<string, unknown>
  /** `.help`'s line per bind, over this module's own for `db` and `sys`. */
  names?:        Record<string, string>
  /** Read before every prompt when a function. */
  standing:      string | (() => string)
  /** The prompt line's shorter form of `standing`; `.standing` prints the whole. */
  prompt?:       string | (() => string)
  accessors?:    string[]
  commands?:     Record<string, Command>
  tenant?:       string | null
  hints?:        string[]
  history?:      string
  /** The file `.help` says adds commands; `null` for none. */
  commandsFrom?: string | null
  out?:          (line: string) => void
}): Promise<void>

/** One line, then out: the answer on `out`, a failure on `err`, the exit code returned. */
export declare function evalOnce(opts: {
  code:          string
  binds:         Record<string, unknown>
  commands?:     Record<string, Command>
  tenant?:       string | null
  /** The file a missing command is said to be declared in; `null` for none. */
  commandsFrom?: string | null
  out?:          (line: string) => void
  err?:          (line: string) => void
}): Promise<0 | 1>

export declare function describeStanding(opts: { label?: string | null; graded?: number; synthetic?: boolean }): string
export declare function replCommands(mod: unknown, file?: string): Record<string, Command>
/** Who is at the keyboard — `$USER`, else the passwd name — as the trail's operator on a `sys` write (`FJS-D1534`). */
export declare function replOperator(): { id: string; type: 'repl' }
