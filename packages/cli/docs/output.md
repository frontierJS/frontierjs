# Command output

How a command prints a result. Drawn from `cloudflare:dns`'s list, the
reference; `project:map` and the `printHelp`/`printNamespace` palette in
`core/bootstrap.js` agree with it. A result that wraps past the terminal or
puts an id at the weight of a value is graded against this page.

## The shape of a list

```
  example.com  ·  12 record(s)  ·  ● proxied      <- bold subject, dim count line
  TYPE   NAME      CONTENT                         <- dim header
  A      @       ● 1.2.3.4                         <- tone per kind, marker column
         ab12…                                     <- secondary text (ids) dim
```

- **Subject bold, count dim.** One line: the thing listed, then `·  N noun(s)` in `chalk.dim`. A filter in force is named in the count line.
- **Header dim.** Column names in caps, padded with the same widths as the rows.
- **A tone per kind**, never per row: the same status or type is the same color everywhere. Green = ok/active, yellow = pending or unfinished, red = failed, cyan/magenta/blue = categories, `chalk.dim` = everything secondary.
- **Ids and timestamps dim.** An id is for copying, not reading; it sits on its own dim line or last in the row.
- **A marker column with a key.** A one-glyph column (`●`, `✓`, `✗`, `~`) is explained in the count line, in the same tone as the marker.
- **Names cut to what the flag takes.** Show a name the way `--name` or `--pkg` accepts it (relative to its zone, without the scope), not the long form.
- **Pad on plain text, then style.** `chalk.dim(x).padEnd(n)` counts escape bytes; pad the string, then paint it.

## Width

A value that can be arbitrarily long (DNS TXT, a title, a path) is cut to
`process.stdout.columns` minus the other columns, with `…`, **only when
`process.stdout.isTTY`**. Piped output is whole. A row that wraps is read as
two rows.

## Plain stays plain

- `--json` prints `JSON.stringify(x, null, 2)` and nothing else — no color, no cut, no header.
- Piped output has no color: `chalk` comes from `core/color.js`, which honors `NO_COLOR` and `FORCE_COLOR` and is off when stdout is not a TTY. A drive that greps fli's output never sees an escape.
- Read-only paths (anything on the startup path, before a command compiles) import `chalk` from `core/color.js`; a command body is handed it as `chalk` on `$`.
- Chained styles (`chalk.bold.cyan`) are not supported — nest (`chalk.bold(chalk.cyan(s))`) or use the tag: ``chalk`{bold.cyan ${n}} {dim ·} ${what}` ``.

## A verdict

`log.info/success/warn/error/dry` color the level prefix and nothing else; use
them for events ("Deleting record…"), not for a result. A result a person
scans — a list, a report, a ranking — is `echo` with the above.

A `✓`/`✗` verdict line: glyph green or red, subject plain, message dim when it
only restates the subject.

## Who follows it

Styled: `cloudflare:dns`, `cloudflare:zones`, `cloudflare:workers`,
`project:map`, `register:next`, `register:decisions`, `register:check`,
`test:done`, `utils:outline`, `workspace:tidy`, `register:close/file/amend/archive/decide`,
`test:snapshots`, `dev:tui`, `basecamp` (admin printout), `register:atlas`,
`cloudflare:pages`, `project:intent`, and help. `test/output-style.test.js`
holds the list that must stay styled. The commands not yet graded are named
by `FJS-3682`.
