// check/run.js — `runCheck(opts)`: the pre-ship check as a function, exported
// as `@frontierjs/site-kit/check` for `site-kit check <dir>` and for anything
// that deploys a site and refuses on `counts.error`.
//
// The kit's rules run on every site. A preset adds its own through the
// `rules` key its `./preset` export returns (FJS-D962); one with a kit rule's
// id REPLACES it, the way a later markdownLayouts directory wins a name, so a
// preset can wrap a kit rule (ksite's schema rule adds where each fix goes)
// without a second rule reporting the same page beside it.

import { createContext } from './context.js'
import { finding } from './finding.js'
import content from './rules/content.js'
import crawl from './rules/crawl.js'
import meta from './rules/meta.js'
import links from './rules/links.js'
import schema from './rules/schema.js'

export { finding, plural, didYouMean, proseLines, levenshtein } from './finding.js'
export { frontMatter, norm, routeOf, walk, DIST, PUBLIC, SETTINGS, TRAILING_SLASH, UA } from './context.js'
export { makePage } from './html.js'
export { withSchema, healthFindings } from './rules/schema.js'
export { redirectRules } from './rules/crawl.js'

/** The kit's own rules, in report order. */
export const RULES = [...content, ...crawl, ...meta, ...links, ...schema]

const RANK = { error: 0, warn: 1, info: 2 }

/** The kit's rules with a preset's merged in: a shared id replaces, a new one appends. */
export function mergeRules(kit, added = []) {
  const out = [...kit]
  for (const rule of added) {
    const i = out.findIndex((r) => r.id === rule.id)
    if (i === -1) out.push(rule)
    else out[i] = rule
  }
  return out
}

/**
 * @param {object} opts
 * @param {string}   opts.root      the site directory, the one holding content/
 * @param {string[]} [opts.stages]  'source' and/or 'built' (default both; --live implies built only)
 * @param {string[]} [opts.only]    rule ids or group names, case-insensitive
 * @param {boolean}  [opts.live]    read the deployed site at its siteUrl
 * @param {string}   [opts.url]     read any deployed site
 * @param {boolean}  [opts.offline] no network beyond the site itself
 * @param {Record<string, boolean>} [opts.flags] a preset's own flags (`--launch` is ksite's)
 */
export async function runCheck(opts) {
  if (!opts?.root) throw new Error('runCheck needs the site directory as root')
  const live = !!(opts.live || opts.url)
  const stages = opts.stages || (live ? ['built'] : ['source', 'built'])
  const ctx = await createContext({ ...opts, stages })
  const all = mergeRules(RULES, ctx.preset.rules)
  const groups = [...new Set(all.map((r) => r.group))]
  const only = (opts.only || []).map((s) => s.toLowerCase())
  const wanted = (r) => !only.length || only.includes(r.id) || only.includes(r.group.toLowerCase()) || only.some((o) => r.group.toLowerCase().startsWith(o))

  const rules = all.filter(
    (r) => stages.includes(r.stage) && wanted(r) && (r.stage !== 'built' || ctx.html) && (!r.distOnly || ctx.html?.source === 'dist')
  )
  if (live && only.length === 0) ctx.notes.push('--live: links and images are only checked against a local build.')

  const findings = []
  for (const rule of rules) {
    let found
    try {
      found = await rule.run(ctx)
    } catch (e) {
      found = [finding('error', 'check-crashed', `The ${rule.id} check crashed: ${e.message}`)]
    }
    for (const f of found) findings.push({ ...f, group: rule.group, rule: rule.id })
  }

  findings.sort(
    (a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || RANK[a.level] - RANK[b.level]
  )
  const counts = { error: 0, warn: 0, info: 0 }
  for (const f of findings) counts[f.level]++

  return {
    site: ctx.base,
    root: ctx.root,
    preset: ctx.preset.root ? (ctx.preset.name ?? null) : null,
    source: ctx.html?.source || null,
    stages,
    pages: ctx.html ? ctx.html.indexable.map((p) => p.path) : [],
    rules: rules.map((r) => r.id),
    notes: ctx.notes,
    counts,
    findings
  }
}
