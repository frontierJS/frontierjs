// ai/index.ts
// An app's named AI doors, on `app.ai`. A door is `@frontierjs/toolbelt/ask`'s
// contract: `(question, { model, signal }) → Reply`, never throws, never retries.
//
// ── There is no vendor in here ────────────────────────────────────────────
//
// Junction holds the names and the lookup, never a model. A vendor's API bump
// would otherwise ship a junction release to every app, and its dependencies
// would sit in front of every junction user (`FJS-D153`: the boundary owns the
// mechanism, never the vendor). The adapters are doors built elsewhere:
// `claudeDoor` (`@frontierjs/claude`, the local program signed in as the
// developer) and `anthropicDoor` (`@frontierjs/conduit-anthropic`, the Messages
// API with a key). An app moves between them without changing a call.
//
//   app.configure(ai({ doors: {
//     claude: claudeDoor(),
//     brief:  anthropicDoor({ send, maxTokens: 200 }),
//   } }))
//
//   const reply = await app.ai.ask('brief', { prompt: 'Summarize this lead.' })
//   if (reply.ok) use(reply.answer)
//
// A token cap or a temperature is a door's own option, not a question's: the
// local program honors no cap, so a field for one on the question would be a
// lie on that door. A caller wanting a cap names a door registered with one.

import type { AskOptions, Door, Question, Reply } from '@frontierjs/toolbelt/ask'
import { unanswered } from '@frontierjs/toolbelt/ask'

export interface AIDoors {
  /**
   * Ask the door registered as `name`. A name nothing registered is an
   * `Unanswered` (`not_set_up`) naming the doors that are, never a throw: the
   * failure is almost always a spelling, and an empty registry and a typo are
   * different mistakes.
   */
  ask(name: string, question: Question, opts?: AskOptions): Promise<Reply>
  names(): string[]
}

// The battery fills its own slot (`FJS-D640`); augment, never redeclare `App.ai`.
declare module '../core/app.ts' {
  interface AppAI extends AIDoors {}
}

function aiDoors(doors: Record<string, Door>): AIDoors {
  const registered = new Map(Object.entries(doors))
  const names = () => Array.from(registered.keys())
  return {
    names,
    async ask(name, question, opts) {
      const door = registered.get(name)
      if (!door) return {
        ok:      false,
        failure: unanswered('not_set_up',
          `AI door "${name}" not registered. ` +
          (registered.size ? `Registered: ${names().join(', ')}` : 'No doors are registered.')),
        door:    name,
        model:   opts?.model ?? name,
        ms:      0,
      }
      return door(question, opts)
    },
  }
}

/**
 * Install the app's doors: `app.configure(ai({ doors }))` puts them on
 * `app.ai`, the way `mail({ mailer })` puts a mailer on `app.mail`.
 */
export function ai({ doors }: { doors: Record<string, Door> }): import('../core/app.ts').Plugin {
  return {
    name: 'ai',
    register(app: import('../core/app.ts').App): void {
      app.own('ai', aiDoors(doors))
    },
  }
}
