/*
 * mime.d.ts — the kit's types, hand-written.
 *
 * This package is plain JS with no build step. A kit imported by a TypeScript
 * package needs a declaration or it is a TS7016 in that package's build, and
 * junction — which is TypeScript and whose `tsc` an app can run — is a caller.
 * Same reason as `/gate` and `/redact`.
 */

/** What an unrecognized extension answers. */
export const DEFAULT_TYPE: 'application/octet-stream'

/** Extension (no dot, lower-case) to content type (no charset parameter). */
export const CONTENT_TYPES: Readonly<Record<string, string>>

/** The extension of a path or filename, lower-cased, no dot. A dotfile has none. */
export function extensionOf(name: string): string

/** `text/html; charset=utf-8` to `text/html`. A parameter is not part of the type. */
export function baseType(type: string): string

export interface ContentTypeOptions {
  /** Append `; charset=utf-8` where `isTextType` is true. Default false. */
  charset?: boolean
  /** What an unrecognized extension answers. Default `DEFAULT_TYPE`; pass `null` to detect one. */
  fallback?: string | null
}

/** The content type for a filename, a path, or a bare extension (`png` or `.png`). */
export function contentTypeFor(name: string, options?: ContentTypeOptions & { fallback?: string }): string
export function contentTypeFor(name: string, options: ContentTypeOptions & { fallback: null }): string | null

/** The extension to write a file of this type under; `null` where the table does not name one. */
export function extensionFor(type: string): string | null

/** Every extension the table maps to this type. */
export function extensionsFor(type: string): string[]

/** Does this type need `; charset=utf-8`? `image/svg+xml` does not. */
export function isTextType(type: string): boolean

/** Is it worth compressing? Already-compressed formats answer false. */
export function isCompressible(type: string): boolean

/**
 * May a response of this type be served inline, or must it be `attachment`?
 * An allow-list: an unknown type is refused, and SVG and HTML are not on it.
 */
export function isInlineSafe(type: string): boolean

/**
 * What ARE these bytes — `null` where this cannot say, which is not a verdict
 * of safe. Reads at most the first 256 bytes.
 */
export function sniff(bytes: ArrayLike<number> | null | undefined): string | null

/**
 * Are these two types one format spelled two ways? A HEIF file's `ftyp` brand
 * decides whether it reads as `image/heic` or `image/heif`, and an equality
 * over the two refuses a photograph for being the other reading of itself.
 */
export function sameType(a: string, b: string): boolean
