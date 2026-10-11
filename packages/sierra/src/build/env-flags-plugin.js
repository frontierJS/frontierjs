/**
 * build/env-flags-plugin.js — `import.meta.env.DEV` and `PROD` follow the mode
 * (FJS-1232).
 *
 * Vite computes both from `process.env.NODE_ENV` ahead of the mode, so a
 * `vite build` — mode `production` — defined `DEV` as TRUE whenever the
 * environment said `development`. `fli new` scaffolds exactly that line into
 * the `.env` the build scripts load. `DEV` is the documented way to write a
 * branch that must not ship, so the failure landed on the code chosen for
 * being safe (a dev API origin, mock payments, seeded credentials), and
 * nothing complained: the build succeeds and the bundle is minified.
 */

/** @returns {import('vite').Plugin} */
export function envFlagsPlugin() {
  return {
    name: 'sierra:env-flags',
    config(_userConfig, { mode }) {
      const prod = mode === 'production'
      return {
        define: {
          'import.meta.env.DEV': !prod,
          'import.meta.env.PROD': prod,
        },
      }
    },
  }
}
