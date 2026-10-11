/*
 * hooks.d.ts — the kit's types, hand-written.
 *
 * This package is plain JS with no build step. A kit imported by a TypeScript
 * package needs a declaration or it is a TS7016 in that package's build, and
 * junction — which is TypeScript — is the caller. Only what a TypeScript
 * caller reads is declared; sierra and jetty are JS and read the source.
 */

/** A copy of `base` whose `result` remembers whether anything ever assigned it. */
export function hookContext<T extends object>(base: T): T

/** Has anything assigned `ctx.result`? False for a context not made by `hookContext`. */
export function answered(ctx: object): boolean

/** What to tell someone whose pipeline ended without an answer. */
export function hookChainMessage(service: string, method: string, phase: 'around' | 'error'): string
