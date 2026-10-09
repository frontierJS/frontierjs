// The types of @frontierjs/print-kit, by hand: the kit is plain JS, as mesa's
// drive it sits on is.

export interface PrinterStats {
  /** Chrome processes started, ever. */
  launches: number
  /** Jobs finished, including ones that threw. */
  jobs:     number
  /** Requests the offline page refused: each is a URL a document tried to reach. */
  blocked:  number
  /** How long the last launch took, in ms — what a cold first print pays. */
  coldMs:   number
  running:  boolean
}

export interface Printer {
  /** The Chrome this printer would launch, or null. Launches nothing. */
  available(): string | null
  /** A PDF of a whole document; its paper is its own @page rules. */
  pdf(html: string, opts?: { landscape?: boolean }): Promise<Uint8Array<ArrayBuffer>>
  /** A PNG of the first element `selector` matches. */
  png(html: string, opts?: { selector?: string; scale?: number; width?: number }): Promise<Uint8Array<ArrayBuffer>>
  stats(): PrinterStats
  /** Finish queued jobs, then stop Chrome. */
  close(): Promise<void>
}

export interface PrinterOptions {
  windowSize?: string
  find?: () => string | null
}

export function createPrinter(opts?: PrinterOptions): Printer

/** The printer as a junction plugin: claimed as `app.printer`; refuses to boot with no Chrome. */
export function printerPlugin(opts?: PrinterOptions): {
  name: 'printer'
  register(app: { claim(name: string, value: unknown): void }): void
  boot(): void
  shutdown(): Promise<void>
}

export interface Band { left?: string; center?: string; right?: string }
export interface PageSpec {
  size?: 'A3' | 'A4' | 'A5' | 'B4' | 'B5' | 'letter' | 'legal' | 'ledger'
  landscape?: boolean
  /** A CSS length list: `18mm 16mm 20mm`. */
  margin?: string
  /** Running header, by slot. `{page}` and `{pages}` are the counters. */
  top?: Band
  /** Running footer, by slot. */
  bottom?: Band
}

export function cssString(text: string): string
export function marginContent(text: string): string
export function pageRules(page?: PageSpec): string
export function printDocument(doc: { body: string; css?: string[]; title?: string; lang?: string; page?: PageSpec }): string
