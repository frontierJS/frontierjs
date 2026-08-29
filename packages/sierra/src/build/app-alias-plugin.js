/**
 * sierra/build/app-alias-plugin
 *
 * `@` — the surface's own `src/`.
 *
 * A surface is a Vite root (`web/`, `site/`, `widgets/`, `extension/`), and its
 * source sits one directory below it. `@/api.js` is that directory, so a module
 * three levels down says `@/api.js` where it used to say `../../../api.js` — a
 * specifier that is wrong the moment the file moves and that says nothing about
 * where it points.
 *
 * The base is the VITE ROOT and not `process.cwd()`. The two differ whenever a
 * command is typed at the app root — `vite -c web/config/vite.config.js`, which
 * is what every `dev` script in this repo is — and there `@` pointed at an
 * `example/src` that does not exist. Nothing said so: an alias whose target is
 * missing falls through to Node's own resolution and fails as `Cannot find
 * package '@'`, which reads as a missing dependency.
 *
 * A plugin rather than an entry in the config object `createSierraViteConfig`
 * returns, because that object is spread by the app's own vite.config.js before
 * `root` is set on it — so at the moment it is built there is nothing to resolve
 * against. A `config()` hook is handed the user's config with `root` already on
 * it, and its return wins over the same key in that config (measured).
 *
 * The prerender pass does not go through Vite at all — it compiles a page and
 * imports it under Node — so `renderComponent` is told the same mapping
 * separately (`packages/sierra/src/build/prerender.js`). One base, two resolvers.
 */

import { resolve } from 'path'

/** The one definition of where `@` points for a surface rooted at `root`. */
export function appSrcDir(root) {
  return resolve(root, 'src')
}

/**
 * @returns {import('vite').Plugin}
 */
export function appAliasPlugin() {
  return {
    name: 'sierra:app-alias',
    config(userConfig) {
      return { resolve: { alias: { '@': appSrcDir(userConfig.root ?? process.cwd()) } } }
    },
  }
}
