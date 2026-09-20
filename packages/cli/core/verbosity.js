// ─── verbosity.js — is the caller asking for the long version ────────────────
//
// One bit, set once from `--verbose` before any command runs, read by the
// logger and by any command that has a paragraph behind a line.
//
// A leaf with no imports, for the same reason color.js is one: it is read on
// the startup path, before a command is compiled.
//
// It is NOT the `--debug` flag, which asks for stack traces on an error. The
// two were one word for a while — `log.debug` printed unconditionally while
// `--debug` did something else entirely — which is why the level it replaces is
// spelled `detail`.

let verbose = false

export const setVerbose = (on) => { verbose = Boolean(on) }
export const isVerbose  = () => verbose
