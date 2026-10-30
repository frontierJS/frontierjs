// introspect.js — the `$`-introspection surface every flavor of the client
// answers identically: $checkWhere, $checkOrderBy, $protectedFields,
// $primaryKey, $mirrorKey, $declaresAccessRules, $readAs, $inWindow,
// $readGrading, $readReach, $readColumns, $fromReach, $levelOf, $checkWrite,
// $capabilitiesFor, $claimsFor, $scopes and $tenancy.
//
// Questions about the SCHEMA and about SOMEBODY ELSE'S standing, asked without
// running a query — the boundary above answers a 400 or grades a broadcast
// recipient off these, and a second copy of any rule here is a second answer
// to who may read. A table method is never reached from this file.
//
// Built once per client over the root `ctx`; the two that grade the asker's
// OWN caller ($levelOf, $checkWrite) take the flavor's ctx at the proxy, since
// `ctx.auth` refuses outside a table method (`FJS-722`).

import { modelToAccessor } from './ddl.js'
import { AccessDeniedError } from './plugin.js'
import { levelPasses } from '../plugins/gate.js'
import { requireCapability } from '../plugins/capability.js'
import { capabilityNames } from './capabilities.js'
import { policyExprToString, policyVerdict, withLiteralDefaults, readReach, readColumns, fromReach } from './policy.js'
import { resolveTenancy } from './tenancy.js'
import { schemaDeclaresAccessRules, shapesRead, nowISO } from './schema-maps.js'
import { filterableKeysFor, sortableKeysFor } from './query.js'
import { suggestKey, pointFieldsOf, liftNearOrders, sortHopFor, _guardedNames, _shownSet,
         collectWhereKeyProblems, collectOrderByKeyProblems } from './args.js'
import { applyFieldPolicyTo } from './field-policy.js'
import { trailMarksOf, markOf } from './trail-entries.js'

export function makeIntrospection(ctx, { schemaFilePath, asSystem }) {
  const { shapes, schema, now } = ctx

  // ─── $checkWhere ────────────────────────────────────────────────────────
  //
  // $checkWhere(accessor, where) → [{ key, suggestion, allowed }]
  //
  // Ask before you query. For a boundary that can answer 400 — see
  // collectWhereKeyProblems. Unknown accessor → [] rather than a throw: "I
  // cannot judge this" is not "this is wrong", and a caller using it to reject
  // must not reject what it failed to understand.
  //
  // Defined ONCE here and handed to every proxy below. It lived inline in the
  // root proxy's get trap until 2026-08-06, which meant `$setAuth`, `asSystem`
  // and `$scopedBy` clients did not have it — and because a Litestone proxy
  // THROWS on an unknown property rather than returning undefined, even asking
  // `typeof db.$checkWhere` blew up. Junction puts a `$setAuth` client on
  // `$.db`, so its autoFilter hook threw on every list read by a
  // signed-in caller, in every app, with a message about a table nobody named.
  // Which filter keys are valid is a question about the SCHEMA — auth and scope
  // have no bearing on it, so every flavor of client answers it identically.
  function $checkWhere(accessor, where) {
    const model = modelForAccessor(accessor)
    if (!model?.fields) return []
    // An empty filter names no key to grade, and junction asks on every read;
    // the key sets below are built fresh per call (`FJS-2992`).
    if (where && typeof where === 'object' && !Array.isArray(where) && Object.keys(where).length === 0) return []
    const keys = filterableKeysFor(model)
    for (const d of Object.values(shapes[model.name].edges)) keys.filterable.add(d.as)
    return collectWhereKeyProblems(where, keys.filterable, keys.computed, keys.encrypted, [],
                                   new Set(Object.keys(shapes[model.name].scopes)), keys.transient,
                                   { ctx, model: model.name }, '', 0, keys.opaque)
      // `p.model` where the key was found through a relation — naming the model
      // it was graded against rather than the one the request addressed, which
      // is the only one a caller can look up.
      .map(p => {
        // The HTTP path: junction's autoFilter answers a 400 built from these.
        const hidden = _guardedNames({ name: p.model ?? model.name }, ctx)
        if (!hidden) return { ...p, message: p.message.replace('%MODEL%', p.model ?? model.name) }
        const allowed = (p.allowed ?? []).filter(n => !hidden.has(n))
        return {
          ...p,
          allowed,
          suggestion: p.suggestion && hidden.has(p.suggestion) ? suggestKey(p.key, new Set(allowed)) : p.suggestion,
          message:    p.message.replace('%MODEL%', p.model ?? model.name),
        }
      })
  }

  // The declared scope names for a model, as source text. The published list
  // `$checkWhere` validates a `$scope` against — asked rather than copied, so a
  // UI offering scopes and the client refusing one cannot disagree. A schema
  // fact, so it is on every flavor of client, like both $check* helpers.
  function $scopes(accessor) {
    const model = modelForAccessor(accessor)
    if (!model) return {}
    const out = {}
    for (const [name, expr] of Object.entries(shapes[model.name].scopes))
      // A scope a `valueset` minted from its `where` is SQL and is its own
      // source text. It is listed rather than hidden: it is filterable, a
      // caller may name it, and `$checkWhere` already validates against this
      // same set — a scope missing from the published list reads as unknown.
      out[name] = expr.__raw ?? policyExprToString(expr)
    return out
  }

  // `ctx.models` is keyed by MODEL NAME and every caller here passes an
  // ACCESSOR, so the lookup missed every time and each of the six `$` siblings
  // paid a scan of the model list with a name derivation per model. `$readAs`
  // is the one that makes it matter: it runs once per broadcast cohort, so the
  // cost is multiplied by the audience — measured, 17 µs a call on a 188-model
  // schema against 2 µs on a small one (`FJS-723`). Indexed under both spellings
  // because reaching one of these with a model name has always worked.
  const accessorIndex = {}
  for (const m of schema.models) {
    accessorIndex[modelToAccessor(m.name)] = m
    accessorIndex[m.name] = m
  }
  function modelForAccessor(accessor) {
    return accessorIndex[accessor]
  }

  // The tenancy declaration, resolved — null when the schema declares none.
  // A schema fact, so it is on every flavor of client, and memoized because
  // resolving reads env vars and the filesystem's idea of cwd.
  //
  // What it is FOR: everything above the Data realm has to know whether this
  // app is one database or one per tenant, and the answer used to exist only
  // in whichever JS call happened to build the registry. Junction asks it to
  // resolve a request; the CLI asks it to know which files `tenant migrate`
  // walks.
  let _tenancy
  function tenancyInfo() {
    if (_tenancy === undefined)
      _tenancy = resolveTenancy(schema, { schemaPath: schemaFilePath ?? null })
    return _tenancy
  }

  // ─── $checkOrderBy ──────────────────────────────────────────────────────
  //
  // $checkOrderBy(accessor, orderBy, { aggregates }) → [{ key, reason, suggestion, sortable, message }]
  //
  // $checkWhere's sibling, same contract in every respect: ask before you
  // query, unknown accessor answers [] because "I cannot judge this" is not
  // "this is wrong", and every flavor of client answers identically because
  // sortability is a fact about the schema that auth and scope cannot change.
  //
  // It exists for the same reason $checkWhere does. The ORM throws, which is
  // right below the boundary; a boundary that can answer 400 has to ask
  // without running the query, and must not grow a second copy of the rule.
  // `reason` is 'computed', 'opaque' or 'unknown' — a boundary wants to say
  // different sentences for "no such field", "that field is derived in JS" and
  // "that column stores a serialization, so its text is not the value".
  function $checkOrderBy(accessor, orderBy, opts = {}) {
    const model = modelForAccessor(accessor)
    if (!model?.fields) return []

    // The same lift `checkOrderBy` makes, and it has to be made HERE too:
    // junction's `autoSort` asks this before the call is made, so a distance
    // order refused here never reaches the client that would have run it.
    const points = pointFieldsOf(model)
    if (points.size) {
      const { kept, problem } = liftNearOrders(points, orderBy)
      if (problem) return [{ key: problem.key, reason: 'invalid', sortable: [],
                             suggestion: null, message: problem.message }]
      if (!kept.length) return []
      orderBy = Array.isArray(orderBy) ? kept : kept[0]
    }

    const keys = sortableKeysFor(model)
    const { relations, computed, transient, opaque } = keys
    // `_depth` is sortable on a tree read only, as the read itself grades it.
    const sortable = opts.recursive ? new Set([...keys.sortable, '_depth']) : keys.sortable
    // Legality is still the schema's — what narrows is only what the 400 SAYS,
    // which is the half junction puts in front of an unauthenticated caller.
    return collectOrderByKeyProblems(orderBy, sortable, relations, computed, opaque, opts.aggregates === true, transient, [],
                                     _shownSet(sortable, _guardedNames(model, ctx)),
                                     sortHopFor(ctx, model.name))
      .map(p => ({ ...p, message: p.message.replace('%MODEL%', model.name) }))
  }

  // ─── $protectedFields ───────────────────────────────────────────────────
  //
  // $protectedFields(accessor) → { field: 'guarded' | 'encrypted' | 'hashed' }
  //
  // Which columns of a model must never be written down in plain text. The
  // third sibling of $checkWhere/$checkOrderBy and the same contract: an
  // unknown accessor answers {}, and every flavor of client answers
  // identically, because what a schema DECLARES protected is not a question
  // about who is asking.
  //
  // It exists because an application keeps a trail of its own. Litestone
  // redacts these fields in `@@trail(audit)` — the repo states that as an
  // invariant — but an app writing "who did what" into its own table has
  // nothing to ask, and the alternative is a hand-copied list of column names
  // that goes stale the first time somebody adds a `@secret`. One reading of
  // the schema, in the package that owns the schema.
  //
  // The value says WHICH protection, because they are not interchangeable:
  // `guarded` is a system-context lock in both directions, `encrypted` hides a
  // value from a non-system reader and stays writable, and `hashed` has no
  // plaintext to reveal at all. A caller that only wants the names takes the
  // keys.
  function $protectedFields(accessor) {
    const model = modelForAccessor(accessor)
    if (!model?.fields) return {}
    const out = {}
    for (const [field, policy] of Object.entries(shapes[model.name].fieldPolicy)) {
      if (policy.guarded)        out[field] = 'guarded'
      else if (policy.hashed)    out[field] = 'hashed'
      else if (policy.encrypted) out[field] = 'encrypted'
    }
    return out
  }

  // ─── $trailMarks ────────────────────────────────────────────────────────
  //
  // $trailMarks(accessor) → { field: (value) => mark }
  //
  // What the trail writes in place of each field's value: `[redacted]` for a
  // protected column, `[personal]`, `[opaque:<digest>]`. A wider set than
  // $protectedFields, which names only what no reader may see — a @personal
  // value is readable and still must not outlive the person in a trail. An
  // app writing its own trail asks here, so it keeps what litestone's keeps.
  // Unknown accessor answers {}.
  function $trailMarks(accessor) {
    const model = modelForAccessor(accessor)
    if (!model?.fields) return {}
    const out = {}
    for (const [field, mark] of trailMarksOf(shapes[model.name].fieldPolicy)) out[field] = value => markOf(mark, value)
    return out
  }

  // ─── $primaryKey ────────────────────────────────────────────────────────
  //
  // $primaryKey(accessor) → the key's columns, IN KEY ORDER; [] for an unknown
  // accessor or a model with no declared key.
  //
  // The sixth sibling of $checkWhere/$checkOrderBy/$protectedFields, and the
  // same contract: every flavor of client answers identically, because what a
  // schema declares the key to be is not a question about who is asking.
  //
  // It exists because the layer above has to know whether a row can be named by
  // ONE value. `expandCompositeId` stamps `@id` on every member of an
  // `@@id([a, b])`, so asking the fields answers all of them and in DECLARATION
  // order — and the key's own order, which is what the implicit index is
  // prefix-matched on, is stated only on the model attribute. A caller reading
  // it off the fields gets a plausible wrong answer (`FJS-694`).
  function $primaryKey(accessor) {
    const model = modelForAccessor(accessor)
    if (!model) return []
    const composite = model.attributes?.find(a => a.kind === 'id')
    if (composite?.fields?.length) return [...composite.fields]
    const single = model.fields?.find(f => f.attributes.some(a => a.kind === 'id'))
    return single ? [single.name] : []
  }

  // ─── $mirrorKey ─────────────────────────────────────────────────────────
  //
  // $mirrorKey(accessor) → the column `@@mirror(key:)` names, or null for a
  // model that is not a mirror and for an unknown accessor. A sibling of
  // $primaryKey on the same contract: every flavor answers identically.
  //
  // The layer above lands a Provider's object on the row this column matches,
  // so it must never guess the column from a name like `externalId`: a model
  // with that column and no `@@mirror` is an app's own row (`FJS-D1125`).
  function $mirrorKey(accessor) {
    return modelForAccessor(accessor)?.attributes?.find(a => a.kind === 'mirror')?.key ?? null
  }

  // ─── $declaresAccessRules ────────────────────────────────────────────
  //
  // $declaresAccessRules() → whether this schema declares any access rule, the
  // line `FJS-D1212` draws between a closed schema and an open one. A GatePlugin
  // installed by hand on a plain schema answers `$levelOf` and still leaves it
  // open, so a layer above cannot read "closed" off `$levelOf` answering.
  function $declaresAccessRules() {
    return schemaDeclaresAccessRules(schema)
  }

  // ─── $readAs ────────────────────────────────────────────────────────────
  //
  // $readAs(accessor, row, principal) → the row as that principal would have
  // read it, or null where they may not read it at all.
  //
  // The fifth sibling of $checkWhere, $checkOrderBy, $protectedFields and
  // $capabilitiesFor, and it takes its subject as an ARGUMENT for
  // $capabilitiesFor's reason: the asker holds one client and is answering
  // about somebody else. Every flavor of client answers identically for the
  // same principal.
  //
  // **It exists because a broadcast is not a SELECT.** `@@allow` compiles into
  // a WHERE, so a row that reaches a caller through a query is filtered by
  // construction and a row that reaches them through a WebSocket frame is not
  // filtered by anything — an anonymous socket received rows the same caller
  // was answered 401 for (`FJS-631`). Junction owns the fan-out and cannot own
  // the rule: the gate, the row policies and the field policies are declared
  // here, and a second implementation of any of them is a second answer to who
  // may read.
  //
  // Three questions in the order every other layer here reads them:
  //
  //   1. the GATE — about the caller alone, so it is asked first and is an
  //      integer comparison. It is the whole answer for a stranger, which is
  //      the case this was built for.
  //   2. the ROW POLICY — `policyVerdict`, the one owner, in JS against the row
  //      in hand. No query: the row is already here.
  //   3. the FIELD policies — what of the row they may see. Safe to apply to a
  //      row that has already been read, because every protection strips for a
  //      NON-system reader and a recipient is never system, so the decrypt
  //      branch cannot run.
  //
  // **It fails closed.** `policyVerdict` throws on an undecidable policy — a
  // `check()` over a relation that is not to-one — and at a boundary an
  // undecidable policy must refuse. Refusing costs a subscriber an update;
  // passing hands them a row the schema says is not theirs.
  //
  // The row is NOT re-read. Hasura re-runs the query per cohort and can, having
  // a database connection per subscription; here the announcement already
  // carries the row and a query per recipient per write is the cost that makes
  // this design unaffordable. What that gives up is a `@from` or a `@computed`
  // value the writer's own read resolved — the recipient gets the writer's, not
  // one derived under their own policies.
  async function $readAs(accessor, row, principal) {
    if (!row) return null
    const model = modelForAccessor(accessor)
    if (!model?.name) return null
    const modelName = model.name

    const readCtx = ctxForPrincipal(principal)

    // 1. The gate. `levelPasses` is the plugin's own comparison and `gateFor`
    // its own map — 8 and 9 are sentinels rather than rungs, so a `>=` spelled
    // here reads LOCKED as a high level and hands a subscriber every row on the
    // most protected model in the schema.
    const required = ctx.gateFor?.(modelName, 'read')
    if (required != null) {
      const level = await readCtx.levelFor?.(modelName, readCtx)
      if (!levelPasses(required, level ?? 0)) return null
    }

    // 1b. The grid, where `@@capabilities(all)` puts read on it — the same
    // `requireCapability` a query's `onBeforeRead` refuses with. Without it a
    // member whose Role holds no `Model.read` was answered an empty list over
    // HTTP and handed every row of the model over the socket (`FJS-2527`).
    if (shapes[modelName].capabilities?.read) {
      try { requireCapability(modelName, 'read', readCtx) }
      catch { return null }
    }

    // 2. The row policy.
    let verdict
    try { verdict = policyVerdict(modelName, row, readCtx, 'read') }
    catch { return null }
    if (!verdict.ok) return null

    // 3. The shape.
    const fp = shapes[modelName].fieldPolicy
    return fp && shapesRead(fp)
      ? applyFieldPolicyTo({ ...row }, modelName, fp, readCtx, { mode: 'single' })
      : row
  }

  // A context for somebody else, memoized per principal object. `$setAuth`
  // builds lazy tables and installs scopes because it returns a CLIENT; this
  // needs only the context the rules read, which is what makes grading a
  // recipient affordable at all.
  const _gradeCtxs = new WeakMap()
  function ctxForPrincipal(principal) {
    if (principal == null) return { ...ctx, auth: null }
    if (typeof principal !== 'object') return { ...ctx, auth: principal }
    let c = _gradeCtxs.get(principal)
    if (!c) _gradeCtxs.set(principal, c = { ...ctx, auth: principal })
    return c
  }

  // ─── $readGrading ───────────────────────────────────────────────────────
  //
  // $readGrading(accessor) → 'open' | 'graded'
  //
  // Whether $readAs can ever answer anything but the row it was given. A model
  // whose read gate is 0 (or absent) and which declares no read policy and no
  // field policy admits every reader and hides no column, so grading it is pure
  // cost — a catalog is that shape, and a catalog is the busiest channel an
  // app has.
  //
  // Answered from the SCHEMA rather than guessed at by the caller, so a policy
  // added to a model that had none turns its channel from open to graded with
  // nothing to remember.
  // ─── $inWindow ──────────────────────────────────────────────────────────
  //
  // $inWindow(accessor, row, asOf?) → is this row in force.
  //
  // **A broadcast is not a read, and a window is not an access rule** — which
  // is why this is its own seam rather than a fourth question inside `$readAs`.
  // `$readAs` answers *may this principal see this row*; the window answers
  // *does this row count right now*, which is true or false for everybody.
  // Folding it in would also put it behind `$readGrading`'s `open` fast path,
  // where a catalog-shaped model with a window and no gate skips grading
  // entirely.
  //
  // It exists because the two existing exclusions do not need it and this one
  // does. `@@softDelete`'s transition is a WRITE, so it announces itself and a
  // subscriber's store corrects; a window's transition is the CLOCK, and
  // nothing announces. What this closes is the frame that is emitted AFTER the
  // row fell out of the window — a create or an update on a row already dead,
  // and a `withExpired` read that then wrote. What it cannot close is silent
  // expiry, where no write ever happens: that needs a store that re-grades on a
  // tick, which is a different feature (`@frontierjs/toolbelt/match` is where
  // the client half would go).
  //
  // **The caller decides what to do with a `false`, and for `deleted` the
  // answer is send it anyway** — suppressing a removal for a row a subscriber
  // already holds strands it there for ever, which is worse than never having
  // graded at all. Junction's fan-out holds the event name; this does not.
  //
  // The predicate is the same rule `injectEffectiveFilter` compiles into SQL,
  // evaluated here against the row in hand — `policyVerdict`'s shape exactly,
  // and for its reason: there is no query to filter through. Both read
  // `effectiveMap`, so the rule has one origin and two evaluators. A string
  // compare is sound for both kinds: an ISO instant and a `YYYY-MM-DD` day both
  // order lexicographically the way they order in time.
  function $inWindow(accessor, row, asOf) {
    const model = modelForAccessor(accessor)
    const win   = model?.name ? shapes[model.name].effective : null
    if (!win || !row) return true
    // A frame with no stated moment grades an `@@effective` row the way a read
    // with none does: every row is there, the history a store holds included.
    if (!win.imposed && asOf == null) return true

    const at = asOf != null
      ? (asOf instanceof Date ? asOf.toISOString() : String(asOf))
      : (win.kind === 'day' ? nowISO(now).slice(0, 10) : nowISO(now))

    // A null edge is an open end — `from` null is *always has been*, `to` null
    // is *still in force* — which is the same reading the SQL injects.
    const from = win.from ? row[win.from] : null
    const to   = win.to   ? row[win.to]   : null
    if (from != null && String(from) >  at) return false
    if (to   != null && String(to)   <= at) return false
    return true
  }

  function $readGrading(accessor) {
    const model = modelForAccessor(accessor)
    if (!model?.name) return 'graded'          // unknown: fail closed
    const modelName = model.name
    const gate = ctx.gateFor?.(modelName, 'read')
    if (gate != null && gate > 0) return 'graded'
    if (shapes[modelName].capabilities?.read) return 'graded'
    const rules = shapes[modelName].policy
    if (rules?.read?.allows?.length || rules?.read?.denies?.length) return 'graded'
    const fp = shapes[modelName].fieldPolicy
    if (fp && Object.keys(fp).length) return 'graded'
    return 'open'
  }

  // ─── $readReach ─────────────────────────────────────────────────────────
  //
  // $readReach(accessor) → the model names whose writes can change who may
  // read a row of this one, the model itself among them. `$readAs`
  // grades a row someone was SENT; this says when a row someone already HOLDS
  // must be asked again — a write to a Share changes no Page row and still
  // takes the page from its reader. An unknown accessor reaches nothing.
  function $readReach(accessor) {
    const model = modelForAccessor(accessor)
    return model?.name ? readReach(model.name, ctx) : []
  }

  // $readColumns(accessor) → $readReach with the columns of each reached model
  // a read verdict reads, as { Model: [column] }. A write to a reached model that
  // changes none of its listed columns cannot move who may read (`FJS-3127`).
  // An unknown accessor answers {}.
  function $readColumns(accessor) {
    const model = modelForAccessor(accessor)
    return model?.name ? readColumns(model.name, ctx) : {}
  }

  // $fromReach(accessor) → the model names an `@from` on this one is computed
  // off. A write to one moves a value on a row the write never touched, so a
  // holder of that row asks again. An unknown accessor reaches nothing.
  function $fromReach(accessor) {
    const model = modelForAccessor(accessor)
    return model?.name ? fromReach(model.name, ctx) : []
  }

  // ─── $levelOf ───────────────────────────────────────────────────────────
  //
  // $levelOf(accessor?, principal?) → 0–8, or null where this client cannot
  // grade anyone.
  //
  // **What level does the app grade this caller at.** The seventh sibling, and
  // the one that exists because the mapping is declared ONCE — in
  // `GatePlugin({ getLevel })` — and every other realm was re-deriving it. A
  // level is a fact about the APP's own standing (a membership row, a role
  // column, a workspace), so a layer that grades with the shipped `gradeStanding`
  // instead answers a different number for the same caller: measured on
  // basecamp, an `admin` of a workspace is ADMINISTRATOR(5) to the Data boundary
  // and CREATOR(3) to a Junction method gate, so a caller the schema admits was
  // refused at the API with a level nothing in the app had written (`FJS-1161`).
  //
  // Per MODEL, because `getLevel(auth, model)` is — an app may grade the same
  // caller differently for two models. An accessor that names no model, and an
  // omitted one, pass `null` as the model, which is what a modelless service
  // asking about its own caller has to mean.
  //
  // The principal is OPTIONAL, which is where it parts company with `$readAs`:
  // the commonest caller holds the asker's own scoped client and is asking about
  // the caller it was scoped to, and answering that off this client's own
  // principal is what picks up the gate's per-request cache. State one to grade
  // somebody else — a broadcast recipient — exactly as `$readAs` does.
  //
  // **`null` is *I cannot grade*, not a level.** A schema declaring no `@@gate`
  // installs no plugin, so there is no mapping to ask and no number that would
  // be honest; the caller decides what to do with that, and inventing a default
  // here is the failure this replaces.
  //
  // Each flavor binds its OWN ctx rather than reading `ctx.auth`, which is a
  // getter over the call in progress (`FJS-722`) and refuses outside a table
  // method — so the omitted-principal form has nothing to read unless the
  // flavor states it.
  function $levelOfAs(ownCtx) {
    return function $levelOf(accessor, ...principal) {
      const modelName = modelForAccessor(accessor)?.name ?? null
      const forCtx    = principal.length ? ctxForPrincipal(principal[0]) : ownCtx
      if (typeof forCtx.levelFor !== 'function') return null
      return forCtx.levelFor(modelName, forCtx)
    }
  }

  // ─── $checkWrite ────────────────────────────────────────────────────────
  //
  // $checkWrite(accessor, op, row, changes?) → { ok, message?, rule? }
  //
  // Would this client's caller be let make this write — asked by a write that
  // does not reach this table first. A claimed mirror's forward sends to the
  // Provider and lands the answer as the system, so without this the app's own
  // `@@allow` for create, update and delete graded nobody, and a write the
  // schema refuses landed whenever the Provider was laxer (`FJS-3147`).
  //
  // `create` grades `row` as the payload, read at its literal defaults as the
  // insert would land it. `update` grades `row` as stored, then the stored row
  // with `changes` over it under `post-update`. `delete` grades `row` as stored.
  // The gate and the `@@capabilities` grid first, as the write's own plugins do.
  //
  // Field `@allow(write)` and `@@transitions` are not graded here. On a mirror
  // the first is refused by the parser on every Provider column, and a `@local`
  // one is written through the table; a claim on a model declaring the second
  // is refused at its bind (`FJS-D1162`).
  //
  // **It fails closed.** `policyVerdict` throws on an undecidable policy and so
  // does this; a refusal is a verdict, never a throw, so an affordance can ask.
  // Off this flavor's own ctx, as `$levelOf` is, because `ctx.auth` refuses
  // outside a table method.
  function $checkWriteAs(ownCtx) {
    return async function $checkWrite(accessor, op, row, changes = null) {
      const modelName = modelForAccessor(accessor)?.name
      if (!modelName) throw new Error(`$checkWrite: '${accessor}' is not a model accessor`)
      if (op !== 'create' && op !== 'update' && op !== 'delete')
        throw new Error(`$checkWrite: op is 'create', 'update' or 'delete', not '${op}'`)
      try {
        await ownCtx.gateCheck?.(modelName, op, ownCtx)
        if (shapes[modelName].capabilities?.[op]) requireCapability(modelName, op, ownCtx)
      } catch (e) {
        if (!(e instanceof AccessDeniedError)) throw e
        return { ok: false, message: e.message, rule: e.capability ? 'capability' : 'gate' }
      }
      if (op === 'create')
        return policyVerdict(modelName, withLiteralDefaults(row, shapes[modelName].literalDefaults), ownCtx, 'create')
      const before = policyVerdict(modelName, row, ownCtx, op)
      if (!before.ok || op === 'delete') return before
      return policyVerdict(modelName, { ...row, ...(changes ?? {}) }, ownCtx, 'postUpdate')
    }
  }

  // ─── $capabilitiesFor ───────────────────────────────────────────────────
  //
  // $capabilitiesFor(principal) → { held, unknown, byModel }
  //
  // *What can this person do* — `FJS-D148`. The fourth sibling of $checkWhere,
  // $checkOrderBy and $protectedFields, and the same contract: it takes its
  // subject as an ARGUMENT and every flavor of client answers identically for
  // the same one, because what a name GRANTS is a fact about the schema and not
  // about which client is asking. Defaulting to this client's own principal
  // would break exactly that.
  //
  // Takes a principal (anything carrying `capabilities`) or the bare list, since
  // an application computing the union of somebody's roles holds the list before
  // it holds a principal, and the two are told apart without guessing.
  //
  // `unknown` is the half that earns the method. A capability is a reference,
  // so renaming the referent renames the capability and the OLD string is left
  // sitting in every Role row in every tenant's database — which is why D148
  // rules that a rename emits a data migration. This is what shows you the
  // migration that did not run: a name somebody still holds and this schema no
  // longer declares, which grants nothing and looks exactly like a grant.
  //
  // It answers what is HELD and never the complement. *What can Ada not do* is
  // the whole derived set minus this, which on a real application is 150 rows of
  // nothing happening.
  //
  // The other half of D148's question — *what could Ada do in March* — is not
  // answerable here and no argument makes it so: the roles have changed, so it
  // can only come from what the audit trail recorded at the moment of the
  // decision (`IDEAS/compliance-from-the-seed.md`).
  function $capabilitiesFor(principal) {
    const raw = Array.isArray(principal) || principal instanceof Set
      ? principal
      : principal?.capabilities
    const wanted = raw instanceof Set ? [...raw] : Array.isArray(raw) ? raw : []

    const declared = capabilityNames(schema)
    const held = [], unknown = [], byModel = {}

    for (const name of [...new Set(wanted.map(String))].sort()) {
      if (!declared.has(name)) { unknown.push(name); continue }
      held.push(name)
      const cut = name.lastIndexOf('.')
      ;(byModel[name.slice(0, cut)] ??= []).push(name.slice(cut + 1))
    }
    return { held, unknown, byModel }
  }

  // ─── $claimsFor ─────────────────────────────────────────────────────────
  //
  // $claimsFor(principal) → { <claim>: value | null }
  //
  // The claims the schema reads off a row pointing at the caller —
  // `claim employeeId from Employee(userId)`. The subject as an ARGUMENT, like
  // $capabilitiesFor, so every flavor answers the same for the same caller.
  //
  // Read as the SYSTEM: the row decides this caller's access, so it cannot be
  // read through a client already scoped by that access. asSystem() lifts no
  // exclusion, so a soft-deleted or expired role row resolves to nothing — the
  // model's own declaration answers that, and no rule here restates it.
  //
  // A caller with no id gets `{}`: there is nothing to look a row up by. A
  // caller with no row gets null for each claim, which is the statement *holds
  // none*, and reads the same in both policy interpreters (`FJS-668`). One read
  // per (model, subject), however many claims come off that row.
  async function $claimsFor(principal) {
    const sources = Object.entries(schema.claimSources ?? {})
    const id      = principal?.id ?? null
    if (id == null || !sources.length) return {}

    const reads = new Map()
    for (const [name, src] of sources) {
      const key = `${src.model}\0${src.subject}`
      if (!reads.has(key)) reads.set(key, { model: src.model, subject: src.subject, claims: [] })
      const column = src.column ?? $primaryKey(modelToAccessor(src.model))[0]
      reads.get(key).claims.push({ name, column })
    }

    const sys = asSystem()
    const out = {}
    for (const { model, subject, claims } of reads.values()) {
      const select = Object.fromEntries(claims.map(c => [c.column, true]))
      const row    = await sys[modelToAccessor(model)].findFirst({ where: { [subject]: id }, select })
      for (const c of claims) out[c.name] = row?.[c.column] ?? null
    }
    return out
  }

  return {
    $checkWhere, $scopes, $checkOrderBy, $protectedFields, $trailMarks, $primaryKey, $mirrorKey,
    $declaresAccessRules, $readAs, $inWindow, $readGrading, $readReach, $readColumns,
    $fromReach, $levelOfAs, $checkWriteAs, $capabilitiesFor, $claimsFor,
    modelForAccessor, accessorIndex, tenancyInfo,
  }
}
