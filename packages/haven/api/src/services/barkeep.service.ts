// The barkeep behind the tavern's bar (`IDEAS/haven.md` 8.4): `ask` answers a
// question with a passage of the books and its path (`barkeep.ts`), or counts
// it as a Miss. No model (`FJS-D994`), so no bill and no prompt to inject into.
//
// The answer is the caller's alone and no line of the room: a question is a
// verb, never a Message. The books are read on the first question, once.
import { createService, $, BadRequest } from '@frontierjs/junction'
import { rateLimitHook } from '@frontierjs/junction/hooks'

import { answer, booksRoot, readBooks } from '../barkeep.ts'
import type { Answer, Books } from '../barkeep.ts'

let books: Books | null | undefined

function shelved (): Books | null {
  if (books === undefined) {
    const root = booksRoot()
    books = root ? readBooks(root) : null
  }
  return books
}

export default createService({
  model:   'Miss',
  methods: ['ask'],
  hooks: {
    before: {
      ask: [rateLimitHook({ max: 5, window: '10s', message: 'One at a time — the barkeep is pouring' })],
    },
  },

  /** `{ question }` — answers `{ found: true, text, path, heading }`, or `{ found: false, misses }` with how many questions have gone unanswered, this one counted. */
  async ask (): Promise<({ found: true } & Answer) | { found: false, misses: number, shelf: boolean }> {
    const question = String(($.data as { question?: unknown } | undefined)?.question ?? '').trim()
    if (!question) throw new BadRequest('Ask the barkeep about something')
    if (question.length > 280) throw new BadRequest('The barkeep stops listening after 280 characters')
    // A Miss is no row a screen holds, so nothing is announced.
    $.dispatch = false
    const shelf = shelved()
    const found = shelf && answer(shelf, question)
    if (found) return { found: true, ...found }
    const sys = ($.db as any).asSystem()
    await sys.miss.create({ data: { question } })
    return { found: false, misses: await sys.miss.count(), shelf: !!shelf }
  },
})
