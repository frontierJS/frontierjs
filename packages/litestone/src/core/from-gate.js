// from-gate.js — which @from fields a caller may not see (FJS-1646).
//
// Its own module, with no driver beneath it, because plugins/gate.js imports it
// and jsonschema.js imports plugins/gate.js: Sierra's schema plugin loads that
// file under Node, where anything reaching bun:sqlite throws, and the plugin
// then ships the browser no schema at all — every generated form empty and
// every can() answering yes.

import { levelPasses } from '@frontierjs/toolbelt/gate'

// ─── @from behind the target's gate ──────────────────────────────────────────
// A @from value is read off the TARGET's rows, so it is the target's read gate
// a caller must clear, exactly as an `include` of that relation must. The
// include is refused in GatePlugin.onBeforeRead; a @from field rides on every
// default read of its parent, so refusing would make the parent unreadable to
// anyone below the child's gate. It reads as `null` instead — the answer a
// row policy already gives a hidden `last:` row — and naming one in a `where`
// or an `orderBy` is refused there, so the value cannot be asked about either.
//
// Before this, `@from(SyncRun, last: true)` handed a level-3 caller the whole
// run that `syncRun.findMany()` refused them, and `count:`/`max:` answered over
// rows they could not read (found by Transit, 2026-10-03).
//
// Synchronous on purpose: the level is cached per model per request and a
// getLevel may not return a promise (makeLevelCache), so this is a map lookup.
// Answers the names to hide, or null when there are none.
export function gatedFromFields(fromFields, ctx) {
  if (!fromFields || !ctx?.gateFor || !ctx.levelFor || ctx.isSystem) return null
  let out = null
  for (const [name, f] of Object.entries(fromFields)) {
    if (!f.target) continue
    const required = ctx.gateFor(f.target, 'read')
    if (required == null || levelPasses(required, ctx.levelFor(f.target, ctx))) continue
    ;(out ??= new Set()).add(name)
  }
  return out
}
