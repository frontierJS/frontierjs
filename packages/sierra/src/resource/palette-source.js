/**
 * paletteSource(client, { models, link }) — `CommandPalette`'s `search`, over
 * junction's `search` service (`FJS-D970`).
 *
 *   import { getClient, paletteSource } from '@frontierjs/sierra/resource'
 *
 *   const search = paletteSource(getClient(), {
 *     models: ['issue', 'comment', 'project'],
 *     link:   { comment: hit => `/issues/${hit.id}` },
 *   })
 *   <CommandPalette items={NAV} {search} />
 *
 * One call per pause in typing. The hits arrive ranked on one scale and
 * already graded by the Data boundary, so this only turns each into a row:
 * the group is the model's plural (`Issues`), the label its `@@label` column,
 * the sub its identifying key, and choosing it goes to `/<service>/<id>` — the
 * route `fli scaffold` writes, lowercased as the scanner serves a directory. A model whose rows live elsewhere states its
 * own `link`; a link may answer a promise, because a hit carries no column
 * beyond those four and finding a comment's issue is a read.
 *
 * A kind the index does not hold is the app's own source, appended to what
 * this answers.
 */

import { goto } from '../router/index.js'
import { pluralize, humanize } from '@frontierjs/toolbelt/inflect'
import { serviceNameFor } from './schema-registry.js'

/**
 * @param {object} client  a junction client — `getClient()`, or a `connectApp()` handle's `.client`
 * @param {object} [opts]
 * @param {string[]} [opts.models]  narrows the service's mount; omitted, the whole mount answers
 * @param {Record<string, (hit: object) => string | Promise<string>>} [opts.link]  per model, where a row goes
 * @returns {(query: string) => Promise<object[]>}
 */
export function paletteSource(client, { models, link = {} } = {}) {
  if (!client || typeof client.service !== 'function') {
    throw new TypeError('paletteSource(client) takes a junction client — getClient() after the app boots, or a connectApp() handle\'s .client')
  }
  if (models != null && (!Array.isArray(models) || !models.length)) {
    throw new TypeError(`paletteSource: models names accessors as a non-empty array, e.g. ['issue', 'comment'] — got ${JSON.stringify(models)}`)
  }
  // A misspelled key would send its rows to the default route, which is a page
  // that exists for most models and so reads as a wrong record, not an error.
  if (models) {
    for (const m of Object.keys(link)) {
      if (!models.includes(m)) throw new TypeError(`paletteSource: link names '${m}', which is not in models (${models.join(', ')})`)
    }
  }

  const service = client.service('search')
  const query   = models ? { models: models.join(',') } : {}

  return async (words) => {
    const hits = await service.findData({ ...query, q: words })
    return hits.map(hit => {
      const key = typeof hit.id === 'object' ? JSON.stringify(hit.id) : String(hit.id)
      const to  = link[hit.model] ?? (() => `${routeOf(hit.model)}${encodeURIComponent(key)}`)
      return {
        // The palette's rows share one key space with the app's own items.
        id:     `search:${hit.model}:${key}`,
        group:  humanize(pluralize(hit.model)),
        label:  hit.title,
        sub:    hit.sub == null ? undefined : String(hit.sub),
        action: async () => goto(await to(hit)),
      }
    })
  }
}

// The list page `fli scaffold` writes for a model is its service's directory,
// and the scanner serves a static segment lowercased — `/productVariants/` is a
// case-only miss on a route that exists (`FJS-2841`).
function routeOf(model) {
  return `/${serviceNameFor(model).toLowerCase()}/`
}
