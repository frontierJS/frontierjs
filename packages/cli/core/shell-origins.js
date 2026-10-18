/**
 * core/shell-origins.js — the origins an API must admit once its page is not
 * served from it (`FJS-D912`).
 *
 * `fli deploy` derives the list and hands it to the container as
 * `FJS_CORS_ORIGINS`; junction merges it into cors and csrf. The web domain is
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
 */
export const SHELL_ORIGINS = {
  desktop: ['tauri://localhost', 'http://tauri.localhost'],
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
  const shells = Object.entries(SHELL_ORIGINS)
    .filter(([surface]) => existsSync(join(appRoot, surface)))
    .flatMap(([, origins]) => origins)
  const web = names.api.domain && names.web.domain ? [`https://${names.web.domain}`] : []
  return [...web, ...shells]
}
