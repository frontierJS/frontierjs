export const SHARE_MAX: number
export const SHARE_INFLATED_MAX: number
export function encodeShare(value: unknown, options?: { max?: number }): Promise<string>
export function decodeShare(text: string, options?: { inflatedMax?: number }): Promise<unknown | null>
export function shareParam(hash: string, name?: string): string | null
export function readFields(value: unknown, readers: Record<string, (v: unknown) => unknown>): Record<string, unknown> | null
