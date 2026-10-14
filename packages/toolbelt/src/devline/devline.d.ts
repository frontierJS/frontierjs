/** One thing a dev server brought up, as `fli dev` prints it. */
export interface DevRow {
  name:   string
  facts?: string[]
}

export type DevMessage =
  | { ready: { url?: string; rows: DevRow[] } }
  | { warn: { file?: string; text: string } }

export type ReadDevMessage =
  | { ready: { url: string | null; rows: Required<DevRow>[] } }
  | { warn: { file: string | null; text: string } }

/** The variable `fli dev` sets on every surface it starts. */
export const DEV_ENV: 'FLI_DEV'

/** One message as the line a server prints. Throws on a malformed one. */
export function formatDevLine(message: DevMessage): string

/** The message a line carries, or null when it carries none. */
export function parseDevLine(line: string): ReadDevMessage | null
