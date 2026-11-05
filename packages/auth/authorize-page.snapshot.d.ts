/**
 * The types of `authorize-page.snapshot.js`, which `fli mesa:pack` writes from
 * `Authorize.mesa` (`FJS-D1934`). The props are that file's exports; a prop
 * added there and not here renders as its default.
 */

export interface AuthorizeProps {
  /** The App's name, shown in the headline and the consent sentence. */
  app: string
  /** The client_id URL's host; `loopback` when every redirect is localhost or 127.0.0.1. */
  client: { host: string, loopback: boolean }
  /** The redirect_uri's host, shown on the consent step. */
  redirectHost: string
  step: 'password' | 'totp' | 'consent'
  /** One line above the form, or nothing. */
  error: string | null
  /** The form's POST path. */
  action: string
  /** Hidden inputs carried through every POST. */
  fields: Record<string, string>
}

/** The whole document, with the stylesheet inlined in one `<style>`. */
export function render(props: AuthorizeProps): string

/** `sha256-…` of exactly the inlined style's text, for `style-src`. */
export const STYLE_HASH: string
