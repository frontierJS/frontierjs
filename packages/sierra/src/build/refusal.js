/**
 * src/build/refusal.js — a build that stops on a verdict, not a bug.
 *
 * Vite prints a failed build with `util.inspect(err)`, and rolldown has stamped
 * `code`, `plugin` and `hook` onto the error by then — so a refusal whose whole
 * content is its message arrived as that message, a dozen frames of rolldown
 * internals and an object literal, with the fix lost in the middle. The stack
 * answers *where in Sierra did this throw*, which is no part of a refusal: the
 * message names the file and the command.
 *
 * Only for a verdict about the APP. An error that means Sierra is broken keeps
 * its stack, because there the stack is the only evidence.
 */

const INSPECT = Symbol.for('nodejs.util.inspect.custom')

export function refusal(message) {
  const err = new Error(message)
  err[INSPECT] = function () { return this.message }
  return err
}
