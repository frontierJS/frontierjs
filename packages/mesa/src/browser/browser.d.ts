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
