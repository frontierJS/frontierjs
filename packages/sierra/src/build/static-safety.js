/**
 * build/static-safety.js — prove a prerendered page is safe to publish.
 *
 * ── The hole this closes (ISSUES.md FJS-081) ──────────────────────────────
 *
 * Two shipped features, combined the obvious way, published private data:
 *
 *   - a route declares `render: static` and is emitted as HTML at build time
 *   - every model declares who may read it (`@@gate`)
 *
 * Nothing connected them. A `render: static` route whose `load()` read a model
 * gated at level 4 wrote that data into a public file, which was then served,
 * CDN-cached and indexed. The build succeeded. The page looked right. Nothing
 * warned. It is the worst class of bug this framework can have — silent,
 * permanent, and produced by using two correct features together.
 *
 * ── Where the read actually happens ───────────────────────────────────────
 *
 * `IDEAS/static-safety.md` proposed watching the RENDER, on the grounds that
 * "the prerenderer knows which resources a route touched (it renders them)".
 * That is not where the data comes from. A static route's data arrives from
 * `load()` / `getStaticPaths()` in the `.meta.js` companion, BEFORE render, and
 * reaches the component as a plain `data` prop. Watching the render would have
 * observed an empty set and passed everything — a green check proving nothing,
 * which is worse than no check.
 *
 * So the read set is collected around the companion, not around the render.
 *
 * ── How the read set is collected ─────────────────────────────────────────
 *
 * Litestone already emits it. `$tapQuery(fn)` fires a `QueryEvent` per query
 * carrying `{ model, operation }` and returns an unsubscribe. That covers the
 * case a build-time analysis structurally cannot see — a `load()` that imports
 * a Litestone client directly and queries it, which is how a real app is
 * written. Junction uses the same tap for telemetry.
 *
 * One wrinkle, established by running it rather than reading: the tap reports
 * the TABLE name (`product`) and `$defs` is keyed by the MODEL name
 * (`Product`). They are not the same string. `modelNameFor()` already owns that
 * resolution — including the regular-plural rules — so this file resolves
 * through it rather than lower-casing by hand and drifting.
 *
 * ── Fail closed ───────────────────────────────────────────────────────────
 *
 * A route whose reads cannot be OBSERVED is not a route that is known to be
 * safe. If a route pulls data and no tap could be installed, the build fails
 * asking for a declaration rather than assuming the best. Fail-open would have
 * let exactly the clever route we are worried about slip through silently,
 * which is the failure mode being fixed.
 *
 * The escape is a written, per-route acknowledgement — never a global flag —
 * so publishing gated data becomes a thing somebody wrote down and a reviewer
 * can see in a diff:
 *
 *   ---
 *   render: static
 *   publishes: 4        # this page may publish data readable at level 4
 *   ---
 *
 * Absent, the bar is 0 — STRANGER, i.e. genuinely public. That follows the
 * open question in the idea file to its conclusion: the rule is not "level 0
 * only", it is "the route declares the level it publishes at", with 0 as the
 * default. A build that legitimately reads a gated model through `asSystem()`
 * to publish a public catalogue says so once, in the route.
 *
 * ── When the check does not run ───────────────────────────────────────────
 *
 * No `.lite` schema means no gates, so there is nothing to prove and the check
 * is skipped entirely. A Sierra app without a database is unaffected.
 */

import { registerSchemas, modelNameFor, schemaFor } from '../junction/schema-registry.js'
import { buildGate } from '../junction/field-rules.js'

/** The bar a route clears when it declares nothing: genuinely public. */
export const DEFAULT_PUBLISH_LEVEL = 0

/**
 * Install the generated defs so `modelNameFor` can resolve a table name.
 *
 * The registry is a module singleton designed for the browser, where
 * `virtual:sierra` calls this once before any route module runs. Calling it
 * here reuses the ONE owner of accessor/plural/model-name resolution instead of
 * growing a second copy in the build that would drift from it — and in a build
 * process nothing else reads the registry.
 *
 * @param {object|null} defs    the whole `$defs` table
 * @param {string[]|null} models which entries are models
 */
export function installSchemas(defs, models) {
  registerSchemas(defs ?? {}, models ?? undefined)
}

/**
 * The `read` level a model's gate demands, or 0 when it declares none.
 *
 * An undeclared gate is genuinely ungated at the Data boundary, so 0 is the
 * accurate answer here and not a permissive guess.
 *
 * @param {string} tableOrModel  either spelling — the tap reports the table
 * @returns {{ model: string|null, level: number }}
 */
export function gateReadLevel(tableOrModel) {
  const model = modelNameFor(tableOrModel)
  if (!model) {
    // A read of something the schema does not describe. Not resolvable, so not
    // provable — reported as unknown and handled by the caller's fail-closed
    // branch rather than quietly scored 0.
    return { model: null, level: NaN }
  }
  const need = buildGate(schemaFor(model))?.read
  return { model, level: typeof need === 'number' ? need : 0 }
}

/**
 * Create a recorder that collects every model a Litestone client reads.
 *
 * @param {object|null} client  a Litestone client, or null when none is wired
 * @returns {{ tapped: boolean, models: Set<string>, stop: () => void }}
 */
export function createReadRecorder(client) {
  const models = new Set()

  if (!client || typeof client.$tapQuery !== 'function') {
    return { tapped: false, models, stop() {} }
  }

  const stop = client.$tapQuery(event => {
    if (event && event.model) models.add(String(event.model))
  })

  return { tapped: true, models, stop: typeof stop === 'function' ? stop : () => {} }
}

/**
 * Parse a route's declared publish level.
 *
 * `publishes` is a NUMBER, the gate level this page is allowed to publish at.
 * `publishes: true` is refused rather than treated as "anything": a bare true
 * says the author wanted the check off, not that they decided what the page may
 * contain, and the whole point is that the decision is legible in the diff.
 *
 * @returns {{ level: number, declared: boolean, error: string|null }}
 */
export function declaredPublishLevel(meta) {
  const raw = meta?.publishes ?? meta?.frontmatter?.publishes

  if (raw === undefined || raw === null)
    return { level: DEFAULT_PUBLISH_LEVEL, declared: false, error: null }

  // A number, or a string of digits — YAML frontmatter may hand back either.
  // Everything else is refused BY TYPE rather than coerced: `Number(true)` is
  // 1, so a bare `publishes: true` would otherwise have been accepted as
  // "level 1" — turning the check off by accident, which is the one outcome
  // this key exists to prevent.
  const n =
    typeof raw === 'number' ? raw
    : (typeof raw === 'string' && /^\d+$/.test(raw.trim())) ? Number(raw.trim())
    : NaN

  if (!Number.isInteger(n) || n < 0 || n > 9) {
    return {
      level: DEFAULT_PUBLISH_LEVEL,
      declared: false,
      error: `publishes must be a whole number 0–9 (Litestone's gate scale), got ${JSON.stringify(raw)}`,
    }
  }

  return { level: n, declared: true, error: null }
}

/**
 * Decide whether a route may be published.
 *
 * @param {object}  o
 * @param {string}  o.routeId     for the message
 * @param {object}  o.meta        route frontmatter
 * @param {Set<string>} o.models  table/model names read while building it
 * @param {boolean} o.tapped      was a recorder actually installed?
 * @param {boolean} o.readsData   does the route have a load/getStaticPaths?
 * @returns {{ ok: boolean, message: string|null, published: Array<{model:string, level:number}> }}
 */
export function checkRoute({ routeId, meta, models, tapped, readsData }) {
  const declared = declaredPublishLevel(meta)

  if (declared.error)
    return { ok: false, message: `${routeId}: ${declared.error}`, published: [] }

  const allowed = declared.level

  // ── Unprovable ──────────────────────────────────────────────────────
  // The route pulls data and nothing watched it. An explicit declaration is
  // the author taking responsibility for what is in the page; without one
  // there is no basis on which to call the output safe.
  if (readsData && !tapped && !declared.declared) {
    return {
      ok: false,
      published: [],
      message:
        `${routeId} — render: static\n` +
        `   reads data in its .meta.js, and the build could not observe what it read,\n` +
        `   so it cannot be shown to be safe to publish.\n` +
        `   Wire the Litestone client into the build (sierra config \`db\`) so reads can\n` +
        `   be checked, or declare what this page publishes:\n` +
        `\n` +
        `       ---\n` +
        `       render: static\n` +
        `       publishes: 0     # 0 = public data only\n` +
        `       ---\n`,
    }
  }

  // ── Observed reads ──────────────────────────────────────────────────
  const published = []
  const unknown   = []
  const over      = []

  for (const raw of models) {
    const { model, level } = gateReadLevel(raw)
    if (!model || Number.isNaN(level)) { unknown.push(raw); continue }
    published.push({ model, level })
    if (level > allowed) over.push({ model, level })
  }

  if (unknown.length && !declared.declared) {
    return {
      ok: false,
      published,
      message:
        `${routeId} — render: static\n` +
        `   read ${unknown.map(u => `\`${u}\``).join(', ')}, which the schema does not describe,\n` +
        `   so its gate is unknown and the page cannot be shown to be safe.\n` +
        `   Declare what this page publishes if that read is deliberate:\n` +
        `\n` +
        `       publishes: 0\n`,
    }
  }

  if (over.length) {
    const worst = over.reduce((a, b) => (b.level > a.level ? b : a))
    return {
      ok: false,
      published,
      message:
        `${routeId} — render: static\n` +
        over.map(o => `   reads \`${o.model}\`, which is @@gate read ${o.level} — ` +
                      `level ${o.level} required to read.`).join('\n') + '\n' +
        `   A prerendered page is public: whatever it contains is served to anyone,\n` +
        `   cached by a CDN and indexed, and cannot be recalled.\n` +
        `\n` +
        `   Change the route to \`render: spa\`, move the data into a client:* island\n` +
        `   (an island fetches at runtime with the viewer's own session), or — if this\n` +
        `   data really is meant to be public — say so in the route:\n` +
        `\n` +
        `       ---\n` +
        `       render: static\n` +
        `       publishes: ${worst.level}\n` +
        `       ---\n`,
    }
  }

  return { ok: true, message: null, published }
}

/**
 * Format the per-route table.
 *
 * A check nobody has run is a rule nobody trusts, so the build reports what it
 * proved rather than only what it rejected.
 */
export function formatReport(rows) {
  if (!rows.length) return ''
  const w = Math.max(...rows.map(r => r.route.length), 5)
  const line = r => {
    const models = r.published.length
      ? r.published.map(p => `${p.model}(${p.level})`).join(' ')
      : '—'
    return `    ${r.route.padEnd(w)}  ${String(r.allowed).padStart(3)}  ${models}`
  }
  return [
    `    ${'route'.padEnd(w)}  max  models read (gate)`,
    ...rows.map(line),
  ].join('\n')
}
