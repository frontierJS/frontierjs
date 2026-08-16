// src/core/diagnostics.ts
// The one answer to "should Junction print developer diagnostics to the console".
//
// Two kinds of thing were reaching stdout on every boot and they are not the
// same kind of thing:
//
//   A DIAGNOSTIC describes what happened. `[Loader] Registered service: channels`
//   is an inventory line — `GET /manifest` answers the same question on demand,
//   and an app with 21 services prints 21 of them before it has done anything.
//   A style nag about hook naming is the same: true, actionable, and not news.
//
//   A WARNING describes something that is probably a defect. A duplicate
//   service, a file with no factory in it, a hook map on a method the service
//   does not have. Those stay loud, always, because the cost of missing one is
//   an app that quietly does the wrong thing.
//
// Everything in the first group now goes through `diagnostic()` and is silent
// unless asked for. Nothing in the second group changed.
//
// The signal is `DEBUG=1`, which junction's own config already reads
// (`config/index.ts` maps it to `config.debug`), so this adds a reader rather
// than a convention. Read through a function and not a module-level const: a
// test that sets the variable, and a CLI that sets it after import, both have
// to be able to turn it on.

/** Is the caller asking to see Junction's own boot-time diagnostics? */
export function isDiagnosticMode(): boolean {
  return process.env.DEBUG === '1' || process.env.JUNCTION_DEBUG === '1'
}

/**
 * A line that describes what happened, printed only when asked for.
 *
 * Not `logger.debug()`: these fire during module loading and service
 * construction, before an app — and therefore before its logger — exists.
 */
export function diagnostic(message: string): void {
  if (isDiagnosticMode()) console.log(message)
}
