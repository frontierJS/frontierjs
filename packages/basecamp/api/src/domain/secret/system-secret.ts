// A Secret another screen writes for its own row — a channel's webhook, a
// backup destination's bucket key, a domain's certificate — named after it.
//
// `Secret.name` is a lowercase slug unique per workspace, and slugging folds
// names that were distinct: channels "A B" and "a-b" both want `channel-a-b`.
// The person never typed the secret's name, so a 409 naming it would be about
// something they cannot see; the next free `-2`, `-3` is taken instead. A
// soft-deleted row still holds its name, so a read cannot say which names are
// free — the insert is the test.

import { slug } from '@frontierjs/toolbelt/inflect'

const TAKEN     = new Set(['UniqueConflictError', 'SoftDeletedUniqueError'])
const MAX_TRIES = 50

export async function createSystemSecret(
  client: any,
  prefix: string,
  label:  string,
  data:   Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const base = `${prefix}-${slug(label, { max: 240 }) || 'unnamed'}`
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`
    try {
      return await client.secret.create({ data: { ...data, name } })
    } catch (err) {
      const e = err as { name?: string; fields?: string[] }
      if (!TAKEN.has(e.name ?? '') || !e.fields?.includes('name') || n >= MAX_TRIES) throw err
    }
  }
}
