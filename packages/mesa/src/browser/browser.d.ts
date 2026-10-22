/*
 * @frontierjs/mesa/browser — types.
 *
 * Each wrapper's doc comment states its server-render answer, since a page
 * prerenders that value and hydrates to the live one.
 */

/** What an action resolves to. `via` names the path that ran — `'clipboard'`,
 *  `'execCommand'`, `'share'`, `'copy'` — and an absent API is
 *  `{ ok: false, reason: 'unsupported' }`. Never thrown. */
export type Result<Via extends string = string> =
  | { ok: true,  via: Via }
  | { ok: false, via: Via, reason?: string }

/** A preference kept in localStorage under `${prefix}:${key}`. */
export interface Persisted<T> {
  /** Tracked: an effect reading it re-runs on a write in this tab or another.
   *  Writing `undefined` is `reset()`. Server render: `fallback`, nothing
   *  subscribed, a write ignored. */
  value: T
  /** Remove the stored value; `value` reads `fallback` again. */
  reset(): void
}

/**
 * A preference, never a credential: a key `@frontierjs/toolbelt/redact` reads
 * as one (`portal_token`, `apiKey`) throws — junction's `tokenStorage` owns
 * tokens. A refused localStorage (a sandbox, a full quota) warns once per key
 * and holds a write for this tab. Throws on a terminal or a phone.
 */
export function persisted<T>(
  key: string,
  fallback: T,
  options?: { parse?: (raw: string) => T, format?: (value: T) => string },
): Persisted<T>

/** The time, read live. */
export interface Clock {
  /** Ms since the epoch, tracked: an effect reading it re-runs each `every`
   *  ms while the tab is visible, and at once when it comes back. Every
   *  reader of one `every` reads one instant. Server render: `Date.now()` at
   *  the render, nothing started. */
  readonly value: number
}

/**
 * One timer per `every` (default 1000) shared by every reader, ticking on
 * multiples of `every` since the epoch, cleared while the tab is hidden.
 * `every` that is not a positive number throws. Throws on a terminal or a
 * phone.
 */
export function now(options?: { every?: number }): Clock

/** A media query, read live. Hold it in a component's own `const`: a
 *  template read of an imported name, or of a call written inline, compiles
 *  to a static value. */
export interface Media {
  /** Tracked: an effect reading it re-runs when the query flips. Every reader
   *  of one query shares one `MediaQueryList` and one listener. A query the
   *  browser does not parse matches false. Server render: false, nothing
   *  subscribed. */
  readonly matches: boolean
}

/** Whether `query` — `'(min-width: 768px)'`, `'(hover: none)'` — matches.
 *  An empty or non-string query throws. Throws on a terminal or a phone. */
export function media(query: string): Media

/** `(prefers-reduced-motion: reduce)`. Server render: false. Throws on a
 *  terminal or a phone. */
export function reducedMotion(): Media

/** The operating system's preference — not the app's theme, which is a class
 *  on `<html>` that sierra's switch owns. Tracked. Server render: `'light'`.
 *  Throws on a terminal or a phone. */
export function colorScheme(): { readonly value: 'dark' | 'light' }

/** The app's namespace for every stored key; sierra's router boot calls it
 *  from config's `prefix`. Without it the prefix is empty. */
export function setPrefix(prefix: string | null | undefined): void

/**
 * This tab. `online` is `navigator.onLine` — the interface is up, not that the
 * server answers; `visible` is `document.visibilityState === 'visible'`;
 * `focused` is `document.hasFocus()`. Read in a `.mesa` file under a watch,
 * `$: tab.visible`, as `session` is. Server render: all three `true`, nothing
 * subscribed. Throws at the first read on a terminal or a phone. Read-only —
 * a write throws.
 */
export const tab: {
  readonly online: boolean
  readonly visible: boolean
  readonly focused: boolean
}

/**
 * One key binding, in vim's spelling (`FJS-D1383`): `'<Mod-k>'`, `'<Esc>'`,
 * `'gd'`. `<Mod-…>` is Cmd on Apple platforms and Ctrl elsewhere. With
 * `scope` it listens on the nearest delegation root above that element, read
 * at the call; without, on `document`. Two bindings of one key on one root:
 * the newest answers until it is disposed. `when` is read at each key and
 * false parks the binding. In a text field a key with no Ctrl, Alt or Cmd
 * types instead. A chord the spelling refuses throws, as does one a browser
 * or the OS takes first on either platform (`<Mod-w>`, `<C-Tab>`). Server render: nothing
 * bound, the dispose a no-op. Throws on a terminal or a phone —
 * `@frontierjs/mesa/keys` is the binding there.
 */
export function hotkey(
  chord: string,
  fn: (e?: KeyboardEvent) => void,
  options?: { scope?: Element, when?: () => boolean },
): () => void
