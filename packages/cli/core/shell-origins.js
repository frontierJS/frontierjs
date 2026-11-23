/**
 * core/shell-origins.js — the origins an API must admit once its page is not
 * served from it (`FJS-D912`).
 *
 * `fli deploy` derives the list and hands it to the container as
 * `FRONTIER_CORS_ORIGINS`; junction merges it into cors and csrf. The web domain is
 * declared once, in the deploy config, so no second hand-written copy in
 * `junction.config.js` can drift from it.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where a native shell's page is served from, by surface directory. A Tauri
 * shell is `tauri://localhost` on Linux and macOS and `http://tauri.localhost`
 * on Windows and Android; the deploy cannot know which operating system a user
 * runs, so a surface contributes every spelling.
 *
 * An extension's origin holds an id no deploy knows — a Chrome Web Store id
 * exists only after the first upload, and every Firefox install draws its own
 * uuid — so it contributes each browser's scheme, which junction reads as every
 * origin of that scheme (`FJS-D2310`). Without it the harbor's socket is a 403
 * nothing reports, and no push ever reaches the dock (`FJS-4500`).
 */
export const SHELL_ORIGINS = {
  desktop:   ['tauri://localhost', 'http://tauri.localhost'],
  extension: ['chrome-extension://*', 'moz-extension://*'],
}

function shellOrigins(appRoot) {
  return Object.entries(SHELL_ORIGINS)
    .filter(([surface]) => existsSync(join(appRoot, surface)))
    .flatMap(([, origins]) => origins)
}

/**
 * `FRONTIER_CORS_ORIGINS` for the API `fli dev` starts: an inherited list, which
 * is the operator's, joined by every shell surface the app has. Undefined when
 * both are empty, so a plain app's API boots as it would by hand.
 *
 * @param {string} appRoot
 * @param {string|undefined} inherited `process.env.FRONTIER_CORS_ORIGINS`
 * @returns {string|undefined}
 */
export function devCorsOrigins(appRoot, inherited) {
  const have = (inherited ?? '').split(',').map(o => o.trim()).filter(Boolean)
  const all  = [...new Set([...have, ...shellOrigins(appRoot)])]
  return all.length ? all.join(',') : undefined
}

/**
 * The cross-origin list for a deploy: the web page's origin when the API has a
 * domain of its own, plus every shell surface the app has. Empty when the page
 * shares the API's origin and no shell calls it, so a same-origin app gains
 * neither a cors block nor a csrf list.
 *
 * @param {{ web: { domain: string|null }, api: { domain: string|null } }} names `edgeNames()`
 * @param {string} appRoot the app's root directory
 * @returns {string[]}
 */
export function crossOrigins(names, appRoot) {
  const web = names.api.domain && names.web.domain ? [`https://${names.web.domain}`] : []
  return [...web, ...shellOrigins(appRoot)]
}
