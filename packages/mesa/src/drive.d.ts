// drive.d.ts — the types of `@frontierjs/mesa/drive`. The prose is in drive.js.

export interface ChromeOptions {
  windowSize?: string
  bootstrap?:  string
  profile?:    string
  args?:       string[]
  headed?:     boolean
  /** Hold the first page's time, as `PageOptions.clock` does a second page's. */
  clock?:      boolean | { at?: number }
}

export interface PageOptions {
  url?:   string
  /** An expression polled after load until it is truthy. */
  ready?: string
  /** Hold the page's time: `true` starts it at the drive's now, `{ at }` at an epoch ms. */
  clock?: boolean | { at?: number }
}

export interface Settled {
  settled: boolean
  /** What is still armed, by label: `'$.every'`, `'setInterval(100ms)'`. */
  armed:   string[]
}

export interface PageClock {
  /** Now, in epoch ms, without moving it. */
  (): Promise<number>
  /** Run every timer due in the next `ms` at its own time; answers the new now. */
  (ms: number): Promise<number>
  /** Run one-shot timers and frames until none is armed. Throws naming what is
   *  still armed (an every never settles) unless `allowArmed`. */
  (verb: 'settle', options?: { limit?: number, allowArmed?: boolean }): Promise<Settled>
  /** `'real'`: virtual time follows real time from here; `'hold'`: it stops. Answers now. */
  (verb: 'real' | 'hold'): Promise<number>
}

export interface SecondPage {
  evaluate<T = any>(expression: string): Promise<T>
  navigate(url: string, ready?: string): Promise<void>
  /** Throws on a page not opened with `newPage({ clock: true })`. */
  clock: PageClock
  close(): Promise<void>
}

export interface Chrome {
  /** A CDP call bound to the page. */
  cmd<T = any>(method: string, params?: Record<string, unknown>): Promise<T>
  /** A browser-level CDP call. */
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>
  /** The body of an async function, run in the page; `return` answers it. */
  evaluate<T = any>(expression: string): Promise<T>
  navigate(url: string, ready?: string): Promise<void>
  newPage(url?: string, ready?: string): Promise<SecondPage>
  newPage(options: PageOptions): Promise<SecondPage>
  /** Throws unless opened with `openChrome({ clock: true })`. */
  clock: PageClock
  key(k: string, opts?: { code?: string, keyCode?: number, modifiers?: number, text?: string }): Promise<void>
  press(k: string, modifiers?: number): Promise<void>
  type(text: string): Promise<void>
  clickAt(selector: string): Promise<void>
  fill(selector: string, text: string): Promise<void>
  waitFor<T = any>(expression: string, opts?: { ms?: number, every?: number, label?: string }): Promise<T>
  shot(path: string): Promise<string>
  on(method: string, fn: (params: any, sessionId?: string) => void): () => void
  /** Live: what the page threw or reported since it was last emptied. */
  errors: string[]
  /** Live: `'<status> <url>'` for each response of 400 and above. */
  failed: string[]
  close(): Promise<void>
}

export interface Network {
  goOffline(): Promise<number | null>
  goOnline(): Promise<void>
  waitOnline(opts?: { tries?: number, socket?: boolean }): Promise<boolean>
  readonly severed: number
  withOffline<T>(fn: () => Promise<T>, opts?: { sever?: boolean }): Promise<T>
}

export function findChrome(world?: {
  run?:        (bin: string) => boolean
  exists?:     (path: string) => boolean
  candidates?: string[]
  env?:        Record<string, string | undefined>
}): string | null

export function openChrome(options?: ChromeOptions): Promise<Chrome>
export function createNetwork(browser: Chrome): Promise<Network>
