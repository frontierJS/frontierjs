/**
 * function-handler.js — the handler a host runs in front of its static answers
 *
 * Its own module, importing nothing, because the Cloudflare Worker bundles it:
 * a `node:` import beside it in `functions.js` is a bundle wrangler refuses
 * without `nodejs_compat`, a flag that would put Node's API back in reach of
 * site code on one host only.
 */

/** A function's `env`: the strings of whatever the host process holds. */
export function stringEnv(env = {}) {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string'))
}

/**
 * `/api/event` and `/api/event/` are one path, as a static host serves a page
 * either way.
 *
 * @param {Record<string, Function>} routes  an entry's `routes`
 * @param {Record<string, unknown>} [env]
 * @returns {{ has: (path: string) => boolean, handle: (request: Request) => Promise<Response> }}
 */
export function functionHandler(routes, env) {
  const strings = stringEnv(env)
  const keyOf   = (path) => path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path

  return {
    has: (path) => Object.hasOwn(routes, keyOf(path)),
    async handle(request) {
      const fn = routes[keyOf(new URL(request.url).pathname)]
      const response = await fn(request, strings)
      if (!(response instanceof Response)) {
        throw new Error(`[Sierra] functions: ${new URL(request.url).pathname} returned ${typeof response}, not a Response`)
      }
      return response
    },
  }
}
