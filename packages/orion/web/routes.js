/*
 * routes.js
 *
 * The directory orion's screens are in, for a host to mount (`FJS-D282`):
 *
 *   // web/src/routes/automations.mount.js
 *   export { default } from '@frontierjs/orion/routes'
 *
 * The screens then answer under /automations/, inside the host's own layouts.
 * They reach the API through the host's services — `flows`, `runs`,
 * `flowCredentials` — under their default names.
 */

export default new URL('./routes/', import.meta.url)
