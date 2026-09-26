/*
 * command-confirm.spec.mjs — a `confirm: human` command asks the person at
 * the page before it runs.
 *
 * `fli gui` runs a command in its own process, where nobody is at the terminal
 * it was started from, so the runtime refuses a `confirm: human` run that
 * arrives without `approved` (`test/effects.test.js`). The page is where the
 * person is, so the page asks and sends `approved` only on a yes. No shipped
 * command declares `confirm`, so the command here is metadata handed to the
 * form, and `stream` is replaced to catch what a run would have posted.
 */
export const name = 'a confirm: human command asks before it runs'

export async function run(t) {
  const attempt = (answer) => t.evaluate(`
    const meta = { title: 'probe:send', description: 'Send a probe',
                   effects: 'sends a message to a customer', confirm: 'human', flags: {} };
    activeCommand = meta;
    document.getElementById('cmd-form').innerHTML = buildForm(meta);
    let asked = null, posted = null;
    const realConfirm = window.confirm, realStream = stream;
    window.confirm = (text) => { asked = text; return ${answer}; };
    stream = async (title, body) => { posted = body; };
    try { await runCommand(); }
    finally { window.confirm = realConfirm; stream = realStream; activeCommand = null; }
    return { asked, posted, banner: document.getElementById('cmd-effects')?.textContent ?? null };
  `)

  const no = await attempt(false)
  t.ok(/sends a message to a customer · a person confirms each run/.test(no.banner ?? ''),
    `the form says what the command does — "${no.banner}"`)
  t.ok(/probe:send sends a message to a customer/.test(no.asked ?? ''), 'Run asks, naming the effect')
  t.is(no.posted, null, 'a no posts nothing')

  const yes = await attempt(true)
  t.is(yes.posted?.flags?.approved, true, 'a yes posts approved: true')
}
