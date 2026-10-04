// field-policy.js — a field `@allow(read)` applied to rows that have been read:
// the value withheld or refused, per row, for the caller asking.

import { ValidationError } from './validate.js'
import { referencesRow, evalJs } from './policy.js'
import { decryptField } from './encryption.js'

// ─── Field policy ─────────────────────────────────────────────────────────────
// Strip and decrypt fields according to @omit/@guarded/@encrypted/@allow rules.
//
// Two independent axes, AND'd: VISIBILITY (@hashed, @encrypted, @guarded, field
// @allow('read')) — may this caller see the column at all — and INCLUSION
// (@omit) — is it in the default payload. They compose, so `@guarded @omit(all)`
// is system-context AND asked-for, and neither word can silently swallow the
// other the way a chain did (`FJS-D205`).
//
// mode: 'list'   — findMany / findFirst (strictest — strips @omit)
//       'single' — findUnique           (@omit(lists) included, @omit(all) not)
//       'select' — explicit select      (@omit/@omit(all) bypassed if field selected)
//
// Module level rather than a makeTable closure because a row does not have to
// come from its own table: an `include` reads a DIFFERENT model, and it used to
// hand those rows back raw — a @guarded column in plaintext, an @encrypted
// one as ciphertext, a field @allow nobody evaluated. One definition, asked for
// by model name, is what keeps the two paths from drifting apart again.
// `true`/`false` where every predicate on this field reads only the caller,
// `null` where any of them reads the row and the per-row walk has to run.
//
// Row-freeness is a property of the AST and is cached on the expression array
// itself, globally; the ANSWER depends on the caller and is cached per context.
// Two WeakMaps because the two facts have different lifetimes, and conflating
// them would make a schema-level truth expire with a principal.
const ROW_FREE_EXPRS = new WeakMap()

export function hoistedFieldRead(ctx, exprs) {
  let free = ROW_FREE_EXPRS.get(exprs)
  if (free === undefined) ROW_FREE_EXPRS.set(exprs, free = !exprs.some(referencesRow))
  if (!free) return null

  // Held on the FLAVOR where there is one: the ctx is shared across flavors
  // since `FJS-722`, so writing the memo onto it would put one principal's
  // answers where the next principal reads them. The auth guard below caught
  // that by luck and only after a thrash; the key is the fix.
  const home = ctx._flavor ?? ctx
  let memo = home._fieldReadHoist
  if (!memo || memo.auth !== ctx.auth) memo = home._fieldReadHoist = { auth: ctx.auth, answers: new WeakMap() }
  let answer = memo.answers.get(exprs)
  if (answer === undefined) {
    // `data` is null on purpose: a row-free predicate must not be able to reach
    // one, and passing a row here would hide a mis-classification behind a
    // correct-looking answer.
    answer = exprs.some(expr => evalJs(expr, ctx, null, null, ctx.policyMap ?? {}, ctx.relationMap, 'read'))
    memo.answers.set(exprs, answer)
  }
  return answer
}

export function applyFieldPolicyTo(row, modelName, fieldPolicy, ctx, { mode = 'list', selectedFields = null } = {}) {
  if (!row || !fieldPolicy) return row
  const isSystem = ctx.isSystem
  const out = { ...row }

  for (const fieldName in fieldPolicy) {
    const policy = fieldPolicy[fieldName]
    const { omit, guarded, encrypted, hashed, allow } = policy
    const explicitlySelected = selectedFields?.has(fieldName)

    // ── Two axes, and the field is stripped if either says no ────────────
    //
    // These words answer different questions and a chain answered them as one:
    // @guarded was tested before @omit, first match won, so a column carrying
    // both came back to asSystem() in a plain read with nothing saying so, and
    // a field @allow('read') under @guarded or @encrypted was unreachable
    // (`FJS-D205`, `FJS-827`).
    //
    //   visible  — may this caller see it at all. Strictest wins; nothing here
    //              widens, so @allow may only narrow a protected column.
    //   included — is it in the default payload. Naming it in `select` unlocks.
    let visible  = true
    let included = true

    if (hashed) {
      // The one protection asSystem() does not lift, because there is nothing to
      // lift it to: an HMAC has no inverse, so a "read" could only hand back the
      // digest. Handing back a digest is what destroyed data under the old
      // `searchable: true` — it looks like a value, so it gets displayed, mailed,
      // exported and written into the next table before anyone notices the plaintext
      // is gone. Naming the field costs a throw and saves that.
      if (explicitlySelected) throw new ValidationError([{ path: ['select', fieldName], message:
        `'${fieldName}' is @hashed on ${modelName} — the column holds a one-way digest, so there is no value to select. ` +
        `It can be matched in a where and never read back. If this field has to be readable, it wants @encrypted(deterministic: true)` }])
      visible = false
    } else if (encrypted || guarded) {
      // @guarded's argument is not read: `all` and `select` mean the same thing
      // here, because a lock a caller picks by asking more specifically is not a
      // lock. Select-unlock lives on @omit and only there.
      visible = isSystem
    }

    if (visible && !isSystem && allow?.read?.length) {
      // Hoisted where the predicate reads only the caller. `@allow('read',
      // auth().isAdmin)` has one answer for the whole result set, and this ran
      // the interpreter once per field per ROW (`FJS-619`). The memo hangs on
      // the context, which is one principal — `$setAuth` builds a NEW ctx
      // rather than reassigning `auth` — and is keyed by `ctx.auth` anyway, so
      // a context that ever did reassign it invalidates instead of going stale.
      visible = hoistedFieldRead(ctx, allow.read) ?? allow.read.some(expr =>
        evalJs(expr, ctx, out, modelName, ctx.policyMap ?? {}, ctx.relationMap, 'read')
      )
    }

    if      (omit === 'all')   included = !!explicitlySelected
    else if (omit === 'lists') included = mode !== 'list' || !!explicitlySelected

    const strip = !visible || !included

    if (strip) {
      delete out[fieldName]
      continue
    }

    // ── Decrypt if field is present and encrypted ─────────────────────────
    if (encrypted && fieldName in out && out[fieldName] != null) {
      try {
        out[fieldName] = decryptField(out[fieldName], ctx.enc.ring ?? ctx.enc.key)

        // Mirror of the write step: a Json field was serialized before it was
        // encrypted, so it is parsed after it is decrypted.
        //
        // The parse gets its OWN try/catch rather than riding the outer one,
        // which sets the field to null. A row written before this was fixed
        // decrypts to the literal string '[object Object]' — real data that is
        // already lost. Surfacing that beats blanking it: null reads as "this
        // was empty", the string reads as "something went wrong here", and
        // only the second sends anyone looking.
        if (policy.json && typeof out[fieldName] === 'string') {
          try { out[fieldName] = JSON.parse(out[fieldName]) } catch {}
        }
      } catch (err) {
        // A protected value that cannot be decrypted used to become `null`, and
        // that is a WRONG ANSWER rather than a missing one: the column reads as
        // empty, every check on it passes, and the row looks fine (`FJS-716`).
        // The cause is almost always a key this client does not hold, which now
        // has a remedy the message can name — so it is raised rather than
        // swallowed, and it names the row.
        if (err?.name === 'DecryptionFailedError') {
          // `@secret(rotate: false)` is a loss the schema DECLARES and
          // `$rotateKey` makes the caller acknowledge by name. Raising here
          // would make the whole row unreadable to punish one column the app
          // already said it was giving up — so this one degrades, and only this
          // one. Everything else is a key that should have been there.
          if (ctx.secretMap?.[modelName]?.[fieldName]?.rotate === false) {
            out[fieldName] = null
          } else {
            err.model = modelName
            err.field = fieldName
            err.message = `${modelName}.${fieldName}: ${err.message}`
            throw err
          }
        } else {
        // Anything else here is the Json parse below, which has its own reason
        // to degrade: a row written before that bug was fixed holds the literal
        // '[object Object]', which is data already lost, and surfacing it beats
        // blanking it.
        out[fieldName] = null
        }
      }
    }
  }

  return out
}
