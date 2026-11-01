// What a field's picker offers: the options of an enum, a declared value set or
// a relation, with the stored value kept on the list when it fell off it.
// Split out of createResource, whose closure it only borrows from: the
// resource hands it the pieces of itself the pickers read.
import { serviceNameFor } from './schema-registry.js'
import { session } from './session.js'
import { pickFilter } from './field-rules.js'
import { humanize } from '@frontierjs/toolbelt/inflect'

// The two `labelFieldInfo` tiers that are guesses rather than conventions. A
// model whose display column came from either has not said which one it is.
const WEAK_LABEL = new Set(['scan', 'fallback'])

// What a row is called: its display column, then the conventional columns below
// it, skipping a blank one. `??` alone passes `''` through, and a picker
// labelled with an empty string is an option nobody can find. Undefined when
// none is readable, so each caller keeps its own last resort.
function labelOf(row, shown, alt = [], parts = null) {
  if (parts) {
    const text = parts
      .map(p => p.via ? row?.[p.via]?.[p.field] : row?.[p.field])
      .filter(v => v != null && v !== '')
    return text.length ? text.join(' · ') : undefined
  }
  for (const col of [shown, ...alt]) {
    const v = row?.[col]
    if (v != null && v !== '') return v
  }
  return undefined
}

// ── the order a picker offers ────────────────────────────────────────────────
//
// One owner for a question three call sites answered separately with the same
// literal, which is why a set could not state its own order anywhere: a
// declared `order` never reached the picker, and `optionsQuery` cannot either
// (the source resource is minted here, so it carries none). `FJS-D121`.
//
// The default is the column a person READS, ascending — right for rows nobody
// ordered, and wrong for a list whose author had an order in mind, which is the
// case the declaration exists for. A literal set needs none of this: its
// members travel in the order they were written.
// How many entries a declared `recent(…)` head offers. Not a knob: a head is a
// shortcut past the list, and one long enough to need scrolling is the list
// again. A screen wanting another arrangement states `directives`, which turns
// the head off along with the rest of the ordering.
const RECENT_HEAD = 5

// What a list label reads off a row beyond its own columns: the relations a hop goes through.
const populateFor = (parts) => parts?.some(p => p.via) ? { populate: [...new Set(parts.filter(p => p.via).map(p => p.via))] } : {}

// A term narrows on every part a person reads, a hop as a filter on its relation.
const searchOver = (parts, shown, term) => parts
  ? { OR: parts.map(p => p.via ? { [p.via]: { [p.field]: { contains: term } } } : { [p.field]: { contains: term } }) }
  : { [shown]: { contains: term } }

function optionsOrder(order, shown) {
  return order?.length ? order.map(o => ({ [o.field]: o.dir })) : shown
}

/**
 * @param {object} env  what the resource lends: its name, app, field rules,
 *   the through-filters and related-resource lookups, and the three caches
 *   (`_options`, `_labelWarned`, `_headWarned`) the resource also resets.
 */
export function makeOptions({ serviceName, app, fields, throughFilters, relatedResource, _options, _labelWarned, _headWarned }) {
  /**
   * What a field's picker offers, and whether that is all of it.
   *
   * The relation already says which model answers (`x-relations` → `references`),
   * the registry says which service that model is served under, and the related
   * model's own fields say which column a person recognizes. So a picker over
   * `customerId` needs no name written anywhere:
   *
   *   const { options, total, truncated } = await orders.options('customerId')
   *
   * ─── Why an envelope and not the rows ──────────────────────────────────────
   *
   * This answered a bare array and capped it at 100, so a picker over a model
   * with more rows offered an alphabetical prefix and said nothing — the row a
   * person wanted was absent, and the screen was indistinguishable from one
   * where it had never been created (`FJS-391`). The count that settles it is
   * already on the wire, in the list envelope the service returns, and was
   * being dropped here. Returning it costs one property access at every call
   * site and makes the silence unrepresentable. Same split `find()` and
   * `findData()` already make one layer down.
   *
   * ─── search vs query ───────────────────────────────────────────────────────
   *
   * `query` is a FILTER — the standing narrowing a caller wants on this picker
   * (`{ active: true }`). `search` is what a person typed, applied as `contains`
   * on the label column, and it is a separate name because they compose: a
   * picker restricted to active customers still has to be searchable within
   * them. Sending `search` is what lets a relation larger than the cap be
   * reached at all, since the term goes to the SERVER rather than filtering the
   * hundred rows that already arrived.
   *
   * @param {string} fieldName
   * @param {object} [opts]
   * @param {string} [opts.labelField]  Column to show; defaults to the derived one.
   * @param {object} [opts.query]       Filter passed to the related service.
   * @param {string} [opts.search]      Free text, matched against the label column.
   * @param {object} [opts.directives]  Overrides limit/orderBy wholesale.
   * @param {number} [opts.limit=100]
   * @param {boolean} [opts.reload]     Bypass the cache.
   * @returns {Promise<{ options: Array<{value: unknown, label: unknown}>, total: number|null, truncated: boolean|null }>}
   *   `total` is null when the service reported none, and `truncated` is null
   *   with it — *unknown*, not *no*. A caller rendering "showing 12 of 400"
   *   has to be able to tell those apart.
   */
  /**
   * The values this caller reached for last, as the HEAD of the list.
   *
   * The case the whole ordering axis started from: a person assigns the same
   * three people over and over and an alphabetical list makes them search every
   * time (`FJS-D121`, `FJS-964`).
   *
   * ─── Why a head and not a sort ─────────────────────────────────────────────
   *
   * A picker's list is CAPPED, so ranking the whole thing by recency changes
   * WHICH rows are offered rather than only their order — and *order is not
   * membership* is the property this axis was separated from strength to keep.
   * Two bounded queries instead: the rank, then those rows, prepended, with the
   * ordinary page beneath minus whatever the head already showed.
   *
   * ─── Why nothing is stored ─────────────────────────────────────────────────
   *
   * The rank is an `aggregate` over rows the app already writes, so there is no
   * counter to drift, and it is right for every path that ever wrote one — a
   * job, an import, another screen. It reads through the caller's own service,
   * so what a person sees at the top is what their own `find` would answer;
   * scoping it any other way would put somebody else's habits on their screen.
   *
   * The head rows are fetched through the SET's own filter — scope and the
   * dependent narrowing included — or a retired value would come back at the
   * top of the list it was retired out of.
   *
   * A failure is not fatal: a head is an affordance, so an unreachable rank
   * service leaves the plain list and says so once.
   */
  function recentHead(vs, { setService, narrowed, scope, shown, search, directives, fieldName }) {
    // Searching is the other mode — the person knows what they want and a head
    // above the matches is noise. Stated directives are the caller's own order,
    // and a head would sit above it uninvited.
    if (!vs.recent || search || directives) return Promise.resolve([])

    const rank = relatedResource(serviceNameFor(vs.recent.model) ?? vs.recent.model, vs.recent.model)
    return rank
      .aggregate({
        by:      [vs.recent.field],
        _max:    { [vs.recent.clock]: true },
        orderBy: { _max: { [vs.recent.clock]: 'desc' } },
        limit:   RECENT_HEAD,
      })
      .then(res => {
        const groups = Array.isArray(res) ? res : (res?.data ?? [])
        const values = groups.map(g => g?.[vs.recent.field]).filter(v => v != null)
        if (!values.length) return []

        return setService.service
          .getOptions({ ...narrowed, [vs.value]: { in: values } }, { limit: values.length, ...(scope ? { scope } : {}) })
          .then(res2 => {
            const rows = Array.isArray(res2) ? res2 : (res2?.data ?? [])
            const by   = new Map(rows.map(r => [r?.[vs.value], r]))
            // The rank's order, not the fetch's — the read came back in the
            // set's own order and re-sorting it here is the whole point.
            return values
              .map(v => by.get(v))
              .filter(Boolean)
              .map(row => ({ value: row[vs.value], label: row[shown] ?? row[vs.value], recent: true }))
          })
      })
      .catch(err => {
        if (!_headWarned.has(fieldName)) {
          _headWarned.add(fieldName)
          console.warn(
            `[${serviceName}] options('${fieldName}') — ${vs.set} declares recent(${vs.recent.model}.${vs.recent.field}), ` +
            `and that rank could not be read: ${err?.message ?? err}. The list is offered without a head.`)
        }
        return []
      })
  }

  /**
   * Put a stored value the list does not contain back on it, disabled.
   *
   * A column's value falls out of its own list in three ways — the row was
   * retired by the set's `@@scope`, the row is soft-deleted, or a controlling
   * field narrowed it out — and a native `<select>` bound to a value it does
   * not contain shows the FIRST option instead. The wrong value, silently, and
   * saving writes it. So it is shown, marked, and refused (`FJS-D225`).
   *
   * Costs nothing at all when the value is in the list, which is every render
   * but the one this exists for. When it is not, the row is read once —
   * unnarrowed, and still through the caller's own accessor, so a row they may
   * not read simply does not answer.
   *
   * `humanize` is the fallback rather than the raw code: a set that stores
   * `dark_blue` reads as English beside every other option, and one that stores
   * an id falls through to the id, because `17 (unavailable)` is worse than the
   * bug being fixed.
   */
  function withUnavailable(answer, { fieldName, record, service, valueField, labelField: shown, labelAlt: alt = [], labelParts: parts = null, strength = 'required', within = null, scope }) {
    const held = record?.[fieldName]
    if (held == null) return answer
    // A list held under a scalar column is a filter's picks, one value each.
    // An m2m holds its populated rows; a row `allowNew` minted has no key yet.
    const wanted = [].concat(held).map(v => v && typeof v === 'object' ? v[valueField] : v).filter(v => v != null)
    if (!wanted.length) return answer

    const have    = new Set((answer.options ?? []).map(o => o.value))
    const missing = [...new Set(wanted.filter(v => !have.has(v)))]
    if (!missing.length) return answer

    // Off the PAGE is not off the LIST (`FJS-2555`). A picker is capped, so a
    // value missing from `options` is out of the list only when the list was
    // complete; past a cap it is usually a member the page never reached — a
    // property's contact on an account with 5,669 of them. So a capped (or
    // uncounted) answer asks first, through the filter the list itself was
    // read through: what that finds is a member, pinned as itself, and only
    // what it does not find goes on to be judged below.
    if (answer.truncated !== false) {
      return service
        .getOptions({ ...(within ?? {}), [valueField]: { in: missing } }, { limit: missing.length, ...(scope ? { scope } : {}), ...populateFor(parts) })
        .then(res => {
          const rows = Array.isArray(res) ? res : (res?.data ?? [])
          return new Map(rows.map(r => [r?.[valueField], labelOf(r, shown, alt, parts)]))
        })
        // Unknown is not a member: the judgement below is the one that cannot
        // pass a refused value.
        .catch(() => new Map())
        .then(listed => {
          const members = missing.filter(v => listed.has(v))
          const rest    = missing.filter(v => !listed.has(v))
          const withMembers = { ...answer, options: [
            ...members.map(v => ({ value: v, label: listed.get(v) ?? v })),
            ...(answer.options ?? []),
          ] }
          return rest.length ? judgeMissing(withMembers, rest, { service, valueField, shown, alt, parts, strength }) : withMembers
        })
    }
    return judgeMissing(answer, missing, { service, valueField, shown, alt, parts, strength })
  }

  /** The held values that are NOT in the list, shown and marked by strength. */
  function judgeMissing(answer, missing, { service, valueField, shown, alt = [], parts = null, strength = 'required' }) {

    // Whether a held value outside the list is REFUSED is the binding's
    // strength, not the list's (`FJS-2501`). `required` refuses it. `open`
    // refuses one the source holds and the set narrows out — the Data
    // boundary's *a value the set has stopped offering* — and takes one the
    // source never held, by adding it. `suggested` takes anything. Only a
    // refused value is disabled and marked `unavailable`, which `<Form>` reads
    // as invalid: marking an accepted one so makes a record that is legal to
    // save unsavable until somebody discards what it says.
    const refused = (inSource) => strength === 'required' || (strength === 'open' && inSource)
    const mark = (value, label, inSource) => refused(inSource)
      ? { value, label: `${label} (unavailable)`, disabled: true, unavailable: true }
      : { value, label: `${label} (not listed)` }
    // The read failed, so whether the source holds it is unknown: `open` is
    // graded as if it does, the reading that cannot pass a refused value.
    const blind = () => missing.map(v => mark(v, humanize(v) || String(v), true))

    return service
      .getOptions({ [valueField]: { in: missing } }, { limit: missing.length, ...populateFor(parts) })
      .then(res => {
        const rows = Array.isArray(res) ? res : (res?.data ?? [])
        const byValue = new Map(rows.map(r => [r?.[valueField], labelOf(r, shown, alt, parts)]))
        // Pinned at the FRONT: it is the value in the box, and a person should
        // not have to scroll a capped list to find out why it reads oddly.
        return { ...answer, options: [
          ...missing.map(v => mark(v, byValue.get(v) ?? humanize(v) ?? String(v), byValue.has(v))),
          ...(answer.options ?? []),
        ] }
      })
      // A read the policy refuses is not a failure of this form — the value is
      // still shown, under the name it is stored as.
      .catch(() => ({ ...answer, options: [...blind(), ...(answer.options ?? [])] }))
  }

  function options(fieldName, { labelField, query, search, directives, limit = 100, reload = false, record } = {}) {
    // A to-many the list filters through is asked for by its relation name, and
    // the picker is the join's other end.
    const rule = fields?.[fieldName] ?? throughFilters().find(f => f.name === fieldName)?.rule

    // An enum's members are already on the rule, so this answers without a
    // request — but it answers a PROMISE, like the relation branch below.
    // One call shape for both is the whole point: a caller asking "what are
    // this field's options" cannot know which kind of field it has without
    // re-deriving the thing this function exists to decide, and a seam that
    // returns a value sometimes and a promise other times is one every caller
    // has to special-case.
    //
    // `rule.options` is the labeled list (@label on a member); `rule.enum` is
    // the bare codes. Falling back to the code as its own label is what a
    // control rendering a bare enum already shows.
    //
    // The order is the order the members were WRITTEN, carried unsorted from
    // the schema — `low, medium, high` alphabetizes to `high, low, medium`,
    // which is not a worse order, it is a wrong one. A literal set is the case
    // where the author's order needs no declaration because the declaration IS
    // the order (`FJS-D121`).
    // A list of an enum's members offers the same members, one per pick.
    const member = Array.isArray(rule?.enum) || rule?.options ? rule : rule?.items?.enum ? rule.items : null
    if (member) {
      const all = member.options ?? member.enum.map(v => ({ value: v, label: v }))

      // A declared set is small and entirely in hand, so `search` is applied
      // here rather than sent anywhere — and `total` is the whole set, never a
      // page of it, so `truncated` is false rather than unknown.
      const opts = search
        ? all.filter(o => String(o.label ?? '').toLowerCase().includes(String(search).toLowerCase()))
        : all

      return Promise.resolve({ options: opts, total: all.length, truncated: false })
    }

    // ── a declared value set ─────────────────────────────────────────────
    // Asked before the foreign key, because a bound FK is both and the set is
    // the narrower, better-described answer: it names the column a person reads
    // and the scope the list is narrowed by.
    //
    // Every narrowing the set applies travels as a NAME — the `scope` directive,
    // which junction hands to litestone as `where.$scope`, validated against the
    // model's declared scopes — which is what makes the offered list the SAME list the Data
    // boundary will accept. A declared `where` is SQL and a browser may never
    // send SQL, so it mints a scope of its own at parse and arrives here as one
    // more name (`FJS-430`).
    const vs = rule?.values
    if (vs) {
      const shown = labelField ?? vs.label ?? vs.value

      // ── a dependent set ────────────────────────────────────────────────
      // The list is that country's states, so it cannot be asked for before a
      // country is chosen. Answering the UNNARROWED list would offer values the
      // Data boundary refuses, which is the break this exists to close, one
      // screen earlier (`FJS-D122`) — so the empty answer names what it is
      // waiting for and a control can say *choose a country first*.
      //
      // The narrowing is an ordinary column filter, which `$checkWhere` already
      // validates; nothing new travels. It goes into `query` BEFORE the cache
      // key is built, so changing the controlling field re-asks on its own.
      if (vs.dependsOn) {
        const ctl = record?.[vs.dependsOn.field]
        if (ctl == null)
          return Promise.resolve({
            options: [], total: 0, truncated: false,
            awaiting: vs.dependsOn.field,
            reason:   `${fieldName} depends on ${vs.dependsOn.field}, which has no value yet`,
          })
        query = { ...(query ?? {}), [vs.dependsOn.match]: ctl }
      }
      // The held value is part of the key: the answer can carry a pinned entry
      // for it, so two records asking about one field are two questions.
      const key   = search ? null : `${fieldName}|${JSON.stringify(query ?? null)}|${labelField ?? ''}|${JSON.stringify(record?.[fieldName] ?? null)}`
      if (key && !reload && _options.has(key)) return _options.get(key)

      const setService = relatedResource(serviceNameFor(vs.model) ?? vs.model, vs.model)
      // The scope is a DIRECTIVE on every read the set makes, never a filter: a
      // `$` key in the filters is refused at the bridge, and the picker read
      // 'No options' in every app (`FJS-2561`).
      const narrowed = query ?? {}
      const scope    = vs.scopes?.length ? vs.scopes : undefined

      const pending = Promise.all([
        setService.service.getOptions(
          { ...narrowed, ...(search ? { [shown]: { contains: String(search) } } : {}) },
          { ...(directives ?? { limit, orderBy: optionsOrder(vs.order, shown) }), ...(scope ? { scope } : {}) },
        ),
        recentHead(vs, { setService, narrowed, scope, shown, search, directives, fieldName }),
      ])
        .then(([res, head]) => {
          const rows  = Array.isArray(res) ? res : (res?.data ?? [])
          const seen  = new Set(head.map(o => o.value))
          const opts  = head.concat(
            rows.map(row => ({ value: row?.[vs.value], label: row?.[shown] ?? row?.[vs.value] }))
                .filter(o => !seen.has(o.value)))
          const total = typeof res?.total === 'number' ? res.total : null
          return withUnavailable(
            // `total` is the list's, not this page's: a head entry is a member
            // of the same list shown twice as far as the count is concerned, so
            // the page beneath drops it rather than the total growing.
            { options: opts, total, truncated: total == null ? null : total > rows.length },
            { fieldName, record, service: setService.service, valueField: vs.value, labelField: shown,
              strength: vs.strength, within: narrowed, scope },
          )
        })
        .catch(err => {
          console.warn(`[${serviceName}] options('${fieldName}') — ${vs.set} failed to load: ${err?.message ?? err}`)
          if (key) _options.delete(key)
          return { options: [], total: null, truncated: null, error: `${vs.set} failed to load: ${err?.message ?? err}` }
        })

      if (key) _options.set(key, pending)
      return pending
    }

    const ref = rule?.references ?? (rule?.relation?.kind === 'm2m' ? { model: rule.relation.model, field: 'id' } : null)
    if (!ref) {
      console.warn(
        `[${serviceName}] options('${fieldName}') — that field is neither an enum nor a foreign ` +
        'key, so there is nothing to offer. A picker comes from a relation or a declared set; ' +
        'check the name against the model.',
      )
      return Promise.resolve({ options: [], total: 0, truncated: false,
        error: `'${fieldName}' is neither an enum, a declared value set nor a foreign key` })
    }

    // The cache is asked BEFORE anything is built, which is the order the value
    // set branch above already uses. It was the other way round here, so a
    // cached answer still cost a whole resource — see `relatedResource`.
    //
    // A searched result is NOT cached. The key would carry the term, so every
    // keystroke would leave an entry behind for the life of the resource, and
    // the answer is the one thing here guaranteed to be superseded a moment
    // later. The unsearched list is the one worth holding.
    const key = search ? null : `${fieldName}|${JSON.stringify(query ?? null)}|${labelField ?? ''}|${JSON.stringify(record?.[fieldName] ?? null)}`
    if (key && !reload && _options.has(key)) return _options.get(key)

    const relatedService = serviceNameFor(ref.model) ?? ref.model
    const related        = relatedResource(relatedService, ref.model)
    const shown          = labelField ?? related.labelField
    const alt            = labelField ? [] : (related.labelAlt ?? [])
    const parts          = labelField ? null : (related.labelParts ?? null)

    // A guessed display column is the failure this cannot fix and can stop
    // hiding: *Ada, Ada, Ada* down a list of people, or `1, 2, 3`, both of
    // which look like a working picker. Only the two guessing tiers are said —
    // `name` and `title` are right often enough that warning about them would
    // teach everyone to skip the message. Once per field, not per call.
    if (!labelField && !_labelWarned.has(fieldName) && WEAK_LABEL.has(related.labelSource)) {
      _labelWarned.add(fieldName)
      console.warn(
        `[${serviceName}] options('${fieldName}') — ${related.labelSource === 'fallback'
          ? `${ref.model} has no readable string column, so every option is labeled with its id`
          : `showing ${ref.model}.${shown}, the first plain string column, which is a guess`}. ` +
        `Declare it: @@label(<column>) on model ${ref.model}.`,
      )
    }

    // `search` narrows on the column a person is reading — anything else would
    // match against one string and show another. It is not the ordering
    // question: a relation has no set to declare an order, so this list is the
    // display column ascending.
    const filter = {
      ...pickFilter(rule, app ? app.user : session.user),
      ...(query ?? {}),
      ...(search ? searchOver(parts, shown, String(search)) : {}),
    }

    const pending = related.service
      .getOptions(filter, directives ?? { limit, orderBy: optionsOrder(null, shown), ...populateFor(parts) })
      .then(res => {
        const rows = Array.isArray(res) ? res : (res?.data ?? [])
        const opts = rows.map(row => ({
          value: row?.[ref.field],
          // The id is the honest last resort: a blank option is unpickable and
          // a guessed label is worse than a number.
          label: labelOf(row, shown, alt, parts) ?? String(row?.[ref.field]),
        }))

        // An array answer carries no envelope, so there is no total to read —
        // reported as null rather than as the row count, which would claim the
        // list is complete every time it is capped.
        const total = typeof res?.total === 'number' ? res.total : null

        return withUnavailable(
          { options: opts, total, truncated: total == null ? null : total > opts.length },
          { fieldName, record, service: related.service, valueField: ref.field, labelField: shown, labelAlt: alt, labelParts: parts,
            within: query ?? null },
        )
      })
      .catch(err => {
        // A picker whose rows fail to load must not take the form down with it.
        // The field still renders, empty, and the failure is said out loud.
        console.warn(`[${serviceName}] options('${fieldName}') failed — ${err?.message ?? err}`)
        if (key) _options.delete(key)
        // `error` is what separates *there are none* from *I could not ask*.
        // Both used to answer an empty list, and a person reads an empty picker
        // as the first one — which is how a service nobody could reach looked
        // like a shop with no variants in it (`FJS-570`).
        return { options: [], total: null, truncated: null, error: String(err?.message ?? err) }
      })

    if (key) _options.set(key, pending)
    return pending
  }

  return { options }
}
