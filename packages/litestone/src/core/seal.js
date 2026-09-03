// ─── seal ─────────────────────────────────────────────────────────────────────
//
// Which states of a state machine are SEALED, derived from the machine itself.
//
// `@seals` on a move says *this is the moment the row becomes a document*. It
// names an event, not a state — so the set of sealed states has to be computed,
// and there is exactly one way to compute it: everything reachable from a seal
// move's target. `issue: draft -> issued @seals` with `void: issued -> void`
// beside it seals `void` too, and nothing had to restate it.
//
// One owner because three readers ask the same question — the write guards, the
// access snapshot and the release classifier — and a second walk is how they end
// up disagreeing about whether `void` is a sealed state.

/**
 * @param {object} attr  a `@@transitions` attribute
 * @returns {{ field: string, states: Set<any>, entries: Set<any>, moves: string[] }|null}
 *          null when the machine declares no `@seals` move.
 *          `states` is the sealed closure; `entries` is the from-states of the
 *          seal moves themselves, which must stay OUTSIDE the closure.
 */
export function sealedStates(attr) {
  if (!attr || attr.kind !== 'transitions') return null

  const moves = Object.entries(attr.transitions).filter(([, t]) => t.seals)
  if (!moves.length) return null

  // Reachability from every seal target. A move leaves a sealed state for
  // somewhere new, so that somewhere is sealed as well.
  const states  = reachable(attr.transitions, moves.map(([, t]) => t.to))
  const entries = new Set(moves.flatMap(([, t]) => t.from))
  return { field: attr.field, states, entries, moves: moves.map(([name]) => name) }
}

// Everything reachable from `seeds`, following the machine's own moves.
function reachable(transitions, seeds) {
  const out = new Set(seeds)
  let grew = true
  while (grew) {
    grew = false
    for (const t of Object.values(transitions)) {
      if (out.has(t.to)) continue
      if (t.from.some(f => out.has(f))) { out.add(t.to); grew = true }
    }
  }
  return out
}

/**
 * Why a machine's seals do not hold together. Both faults are *a seal made from
 * a state that is already sealed*, and they are told apart by WHICH seal put it
 * there — which is the difference between a declaration that says nothing and a
 * machine that comes back out of a document.
 *
 * @returns {Array<{ kind: 'redundant'|'unseals', move: string, state: any, by?: string }>}
 */
export function sealFaults(attr) {
  const seal = sealedStates(attr)
  if (!seal) return []

  const moves = Object.entries(attr.transitions).filter(([, t]) => t.seals)
  const faults = []

  for (const [name, move] of moves) {
    // The closure the OTHER seals produce on their own. A from-state inside it
    // was already a document before this move ran.
    const others = moves.filter(([n]) => n !== name)
    const byOthers = others.length ? reachable(attr.transitions, others.map(([, t]) => t.to)) : new Set()

    for (const from of move.from) {
      if (byOthers.has(from)) {
        faults.push({ kind: 'redundant', move: name, state: from, by: others.find(([, t]) => reachable(attr.transitions, [t.to]).has(from))?.[0] })
      } else if (seal.states.has(from)) {
        faults.push({ kind: 'unseals', move: name, state: from })
      }
    }
  }
  return faults
}

/**
 * The models that seal, keyed by name. Each entry carries the state column, the
 * sealed set, and which of its hasMany relations are `@sealed`.
 *
 * @param {object} schema  a parsed schema
 * @returns {Map<string, { field: string, states: Set<any>, moves: string[], relations: string[] }>}
 */
export function sealingModels(schema) {
  const out = new Map()
  for (const model of schema.models) {
    for (const attr of model.attributes) {
      const seal = sealedStates(attr)
      if (!seal) continue
      out.set(model.name, {
        field:     seal.field,
        states:    seal.states,
        moves:     seal.moves,
        relations: model.fields.filter(f => f.attributes.some(a => a.kind === 'sealed')).map(f => f.name),
      })
    }
  }
  return out
}

/**
 * What each model has to check before it writes: `self` when the model seals
 * ITSELF (its own row may not be destroyed, and phase 4's columns freeze), and
 * `parents` for every `@sealed` relation pointing at it.
 *
 * Derived once at client build. A child reached through two sealed parents
 * carries two guards and both must hold — an intersection, never a choice.
 *
 * @param {object} schema
 * @param {object} relationMap   buildRelationMap's output
 * @param {(m: string) => string} tableFor   model name → table name
 */
export function buildSealMap(schema, relationMap, tableFor) {
  const sealing = sealingModels(schema)
  if (!sealing.size) return {}

  const map = {}
  const entry = (m) => (map[m] ??= { self: null, parents: [] })

  for (const [name, seal] of sealing) {
    entry(name).self = {
      model:  name,
      table:  tableFor(name),
      column: seal.field,
      states: [...seal.states],
      moves:  seal.moves,
    }

    // Only the relations the parent marked. Every other child of a sealing
    // model goes on being written — a payment against an issued invoice is the
    // case, and inferring the set would refuse it.
    for (const relName of seal.relations) {
      const rel = relationMap[name]?.[relName]
      if (!rel || rel.kind !== 'hasMany' || !rel.sealed) continue
      entry(rel.targetModel).parents.push({
        relation:    relName,
        parentModel: name,
        parentTable: tableFor(name),
        column:      seal.field,
        states:      [...seal.states],
        foreignKey:    rel.foreignKey,     // on the child
        referencedKey: rel.referencedKey,  // on the parent
      })
    }
  }
  return map
}
