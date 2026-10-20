/**
 * build/env-prefix.js — the env prefixes Vite inlines into a bundle.
 *
 * `FRONTIER_PUBLIC_` is the framework's one door to the browser
 * (`FRONTIER_PUBLIC_API_URL`); the rest of `FRONTIER_*` stays on the server,
 * because a bundle is readable by anybody who loads the page and a future
 * `FRONTIER_*` secret would ship in it (`FJS-D1304`). Every Vite build Sierra
 * runs sets it, and jetty's builds, which are not Sierra's, take it from here.
 */
export const ENV_PREFIX = ['VITE_', 'FRONTIER_PUBLIC_']
