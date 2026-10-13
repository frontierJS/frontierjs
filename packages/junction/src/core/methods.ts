// core/methods.ts
// The framework's own method names, in a module that imports nothing.
//
// Split out of context.ts because envelope.ts reads it to decide list vs
// single, and envelope.ts is bundled into the browser client, where
// context.ts's `node:async_hooks` does not exist. context.ts re-exports it.

// Every table that asks "is this a custom method" reads this one; a name
// missing from a copy is served as custom there.
export const CRUD_METHODS = ['find', 'get', 'aggregate', 'create', 'update', 'patch', 'remove', 'restore'] as const
export type ServiceMethod = typeof CRUD_METHODS[number]
