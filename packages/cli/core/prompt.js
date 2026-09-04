// ─── prompt.js — asking a person a question, over a TTY or a pipe ────────────
//
// One owner, because the two engines that existed disagreed about the thing
// that matters and both wrote down their reasoning. `commands/make/command.md`
// used readline per prompt on a TTY; `commands/make/service.md` refused readline
// outright — "readline emits buffered lines eagerly, so with piped or scripted
// input every answer after the first is dropped". Both are right about their own
// half, which is why this splits on `isTTY` instead of choosing.
//
//   TTY   → readline, one question at a time, so characters echo as typed
//   Pipe  → buffer ALL of stdin to `end`, then hand out one line per question
//
// Three things this adds that neither copy had, each because a tutorial needs
// it and every other caller wanted it too:
//
//   `yes: true`   answers every question with its default and NEVER OPENS STDIN.
//                 The pipe branch resolves on `end`, so a non-interactive run
//                 with stdin inherited and nothing to read waits for ever — a
//                 CI hang with no output, which is the worst failure a
//                 non-interactive flag exists to prevent.
//   an explicit   `confirm(q, { default })`. The two copies disagreed about what
//   default       a bare Enter means — one read it as no, the other as yes —
//                 so it is stated per question rather than settled globally.
//                 Absent, it is `false`: a refusal is the safe reading of a
//                 person who did not answer.
//   injectable    `input`/`output`, so both branches are testable without a
//   streams       terminal.
// ─────────────────────────────────────────────────────────────────────────────

import { createInterface } from 'readline'

// ─── the source ───────────────────────────────────────────────────────────────
// Opened LAZILY, on the first question that is really asked. Constructing the
// prompts must not touch stdin: a caller that answers everything from flags
// would otherwise block on a stream nobody is going to write to.

function openSource(input, output) {
  return new Promise((resolve) => {
    if (input.isTTY) {
      resolve({ tty: true, rl: createInterface({ input, output, terminal: true }) })
      return
    }
    let buf = ''
    input.setEncoding('utf8')
    input.on('data', (chunk) => { buf += chunk })
    input.once('end', () => resolve({
      tty:    false,
      lines:  buf.split('\n').map(l => l.trim()),
      cursor: 0,
    }))
  })
}

// ─── createPrompts ────────────────────────────────────────────────────────────
//
//   const p = createPrompts({ yes: flag.yes })
//   const name = await p.ask('App name › ', flag.name)
//   if (await p.confirm('Write it?', { default: true })) …
//   p.close()
//
// `ask(prompt, fallback)` returns `fallback` WITHOUT asking when one is given
// and non-empty. That is the flag-supplied-answer path every scaffold here
// wants: a declared `--description` skips its question rather than pre-filling
// it.

export function createPrompts({ yes = false, input = process.stdin, output = process.stdout } = {}) {
  let opening = null
  const source = () => (opening ??= openSource(input, output))

  const write = (text) => output.write(text)

  const next = async (prompt) => {
    const src = await source()
    if (src.tty) return new Promise(r => src.rl.question(prompt, a => r(a.trim())))
    // Piped: the prompt still goes out, so a transcript reads the way the
    // session did. An exhausted buffer answers '' — the same thing Enter does,
    // so EOF and a bare Enter cannot mean two different things.
    write(prompt + '\n')
    return src.lines[src.cursor++] ?? ''
  }

  const listOptions = (options) => {
    for (const [i, o] of options.entries()) write(`  ${i + 1}) ${o}\n`)
  }

  return {
    async ask(prompt, fallback) {
      if (fallback !== undefined && fallback !== '') return fallback
      if (yes) return null
      return (await next(prompt)) || null
    },

    async confirm(prompt, { default: fallback = false } = {}) {
      if (yes) return fallback
      const hint   = fallback ? '(Y/n)' : '(y/n)'
      const answer = (await next(`${prompt} ${hint} › `)).toLowerCase()
      if (answer === '') return fallback
      return answer === 'y' || answer === 'yes'
    },

    async choose(prompt, options, { default: fallback = 0 } = {}) {
      if (yes) return options[fallback]
      listOptions(options)
      const answer = await next(`  ${prompt} › `)
      if (answer === '') return options[fallback]
      // A number outside the list is not a choice. Falling back to the default
      // is what both copies did and it is right here: the list is on screen, so
      // a mistyped index is a slip rather than an instruction.
      const idx = parseInt(answer, 10) - 1
      return options[idx] ?? options[fallback]
    },

    // "Look at this, then carry on." A no-op with no terminal, so a lesson does
    // not stop dead in CI waiting for somebody to press a key.
    async pause(text = 'Press enter to continue') {
      if (yes || !input.isTTY) return
      await next(`  ${text} › `)
    },

    close() {
      if (!opening) return
      opening.then((src) => { if (src.tty) src.rl.close() }).catch(() => {})
    },
  }
}
