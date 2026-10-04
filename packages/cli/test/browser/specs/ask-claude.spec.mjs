/*
 * ask-claude.spec.mjs — the output panel handed to Claude Code, on screen.
 *
 * `test/ask-claude.test.js` covers the argv, the prompt and the stream reading
 * against a fake `claude`; `test/server.test.js` the endpoint's refusals. What
 * is here is the page: what it SENDS — a follow-up must carry only the lines
 * since the last ask and none Claude wrote, or the session reads its own answer
 * back as evidence — and that the reply is drawn by rules that exist in the
 * stylesheet. The endpoint is scripted, because the real one costs money and
 * needs a login on whatever machine runs this.
 */
export const name = 'ask-claude'

const SESSION = '5acea7bb-3850-44cf-81dc-97688510acda'

export async function run(t) {
  const out = await t.evaluate(`
    const sse = events => events.map(e => 'data: ' + JSON.stringify(e) + '\\n\\n').join('');
    const sent = [];
    let reply = () => new Response(sse([
      { type: 'session', id: ${JSON.stringify(SESSION)} },
      { type: 'tool', text: 'Bash git status --short' },
      { type: 'text', text: 'The snapshots are stale; rerun ws:atlas.' },
      { type: 'result', ok: true, stop: 'success', cost: 0.04, turns: 2, denied: 1 },
      { type: 'done', code: 0 },
    ]));
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => {
      if (String(url).endsWith('/api/ask-claude') && opts?.method === 'POST') { sent.push(JSON.parse(opts.body)); return reply() }
      return realFetch(url, opts);
    };
    const lines = () => [...document.querySelectorAll('#output-lines .gui-line')];
    const stored = () => { try { return localStorage.getItem('fli-ask-rules') } catch { return 'unreadable' } };
    try { localStorage.removeItem('fli-ask-rules') } catch {}
    try {
      newAsk();
      clearOutput();
      appendOutput('$ fli test:done', 'info');
      appendOutput('✗ snapshots  repo-atlas.snapshot.html no longer matches', 'output');

      const form = document.getElementById('ask-form');
      const wasHidden = form.hidden;
      await toggleAsk();
      const shown = !form.hidden;
      const rulesBox = document.getElementById('ask-rules');
      const offered = {
        question: document.getElementById('ask-q').value,
        selected: document.getElementById('ask-q').selectionEnd - document.getElementById('ask-q').selectionStart,
        help:     document.getElementById('ask-help').textContent,
        rules:    rulesBox.value,
        state:    document.getElementById('ask-rules-state').textContent,
      };
      document.getElementById('ask-q').value = 'why did this fail?';
      rulesBox.value = 'Answer in one sentence.';
      saveAskRules();
      const edited = { state: document.getElementById('ask-rules-state').textContent, stored: stored() };
      await askClaude();

      const answer = lines().find(el => el.classList.contains('claude'));
      const style  = answer && getComputedStyle(answer);
      const first  = {
        answer:   answer?.textContent.trim() ?? null,
        from:     answer?.dataset.from ?? null,
        border:   style?.borderInlineStartWidth ?? null,
        font:     style?.fontFamily ?? null,
        token:    getComputedStyle(document.documentElement).getPropertyValue('--font-primary'),
        resume:   lines().some(el => el.textContent.includes('claude --resume ' + ${JSON.stringify(SESSION)})),
        summary:  lines().find(el => /claude · answered/.test(el.textContent))?.textContent.trim() ?? null,
        newShown: !document.getElementById('ask-new').hidden,
        grows:    getComputedStyle(document.getElementById('ask-q')).flexGrow,
        cleared:  document.getElementById('ask-q').value,
        button:   document.getElementById('ask-send').textContent,
      };

      appendOutput('later line', 'output');
      await askClaude();

      newAsk();
      resetAskRules();
      const reset = { state: document.getElementById('ask-rules-state').textContent, stored: stored() };
      await askClaude();

      reply = () => new Response(JSON.stringify({ error: 'Claude is still answering' }), { status: 409 });
      await askClaude();
      const refused = lines().at(-1).textContent.trim();

      return { wasHidden, shown, offered, edited, reset, sent, first, refused };
    } finally {
      window.fetch = realFetch;
      newAsk();
      clearOutput();
      resetAskRules();
      document.getElementById('ask-q').value = '';
      document.getElementById('ask-form').hidden = true;
    }
  `)

  t.is(out.wasHidden, true, 'the question row is closed until asked for')
  t.is(out.shown, true, 'and the button opens it')

  t.ok(/What does this output say/.test(out.offered.question), `the default question is in the field (${out.offered.question})`)
  t.is(out.offered.selected, out.offered.question.length, 'selected, so typing replaces it')
  t.ok(/git status/.test(out.offered.help) && /Read-only/.test(out.offered.help) && /\$2/.test(out.offered.help), `the help says what is sent and what Claude may do (${out.offered.help})`)
  t.ok(/read-only here/.test(out.offered.rules), 'the instructions box holds the server\'s default instructions')
  t.ok(/default/.test(out.offered.state), 'and says they are the default')
  t.ok(/edited/.test(out.edited.state), 'an edit is labeled as one')
  t.is(out.edited.stored, 'Answer in one sentence.', 'and kept for the next visit')
  t.ok(/default/.test(out.reset.state) && out.reset.stored === null, 'reset goes back to the default and forgets the edit')

  const [first, follow, fresh] = out.sent
  t.is(first.question, 'why did this fail?', 'the question typed is the question sent')
  t.ok(first.output.includes('$ fli test:done') && first.output.includes('✗ snapshots'), 'the first ask sends the whole panel')
  t.is(first.session, null, 'and starts a session')
  t.ok(first.context && first.context.panel, `with where the page is (${JSON.stringify(first.context)})`)
  t.is(first.rules, 'Answer in one sentence.', 'and the edited instructions')

  t.is(out.first.answer, 'The snapshots are stale; rerun ws:atlas.', 'the reply is drawn in the panel')
  t.is(out.first.from, 'claude', 'and marked as Claude\'s')
  t.is(out.first.border, '2px', 'set apart by a rule the stylesheet has (.gui-line.claude)')
  // The field theme's prose face IS a monospace, so the claim is that the
  // rule reaches the token, not that the face differs from the output's.
  const face = f => String(f).replace(/["']/g, '').replace(/\s+/g, '')
  t.is(face(out.first.font), face(out.first.token), `in the theme's prose face (${out.first.font})`)
  t.ok(out.first.resume, 'the session id is offered for a terminal')
  t.ok(out.first.summary && /2 turn/.test(out.first.summary) && /refused/.test(out.first.summary), `the run is summed up, refusals included (${out.first.summary})`)
  t.is(out.first.newShown, true, 'a conversation in progress can be dropped')
  t.is(out.first.grows, '1', 'the question field takes the row')
  t.is(out.first.cleared, '', 'the field is emptied for the next question')
  t.is(out.first.button, 'ask', 'and the button is back to ask once the answer is in')

  t.is(follow.session, '5acea7bb-3850-44cf-81dc-97688510acda', 'a follow-up resumes the session')
  t.is(follow.output, 'later line', 'and sends only what arrived since — none of the old output, none of the reply')
  t.ok(!follow.question, 'an empty question is left for the server to fill')
  t.is(follow.rules, null, 'the session already has the instructions')

  t.is(fresh.session, null, '"new" starts over')
  t.is(fresh.rules, null, 'with the default instructions once reset, which the server supplies')
  t.ok(fresh.output.includes('$ fli test:done') && fresh.output.includes('later line'), 'and sends the whole panel again')
  t.ok(!fresh.output.includes('stale; rerun'), 'still without Claude\'s own lines')

  t.ok(/still answering/.test(out.refused), `a refusal is said in the panel (${out.refused})`)

  // A next-up row handed over: the issue lands in the output and the question
  // waits in the field. Nothing may be SENT by the press, since a click that
  // spends money without a second look is the one this row must not have.
  const about = await t.evaluate(`
    const kept = nextBody;
    let posted = 0;
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => { if (opts?.method === 'POST') posted++; return realFetch(url, opts) };
    try {
      await loadNext();
      const buttons = document.querySelectorAll('#next-rows [data-next]').length;
      const asks    = document.querySelectorAll('#next-rows [data-next] [data-ask]').length;
      clearOutput();
      nextBody = { ready: [{ id: 'FJS-9999', severity: 'S2', pkg: ['litestone'], file: 'ISSUES.md', line: 76, title: 'a gate answers yes', probeFirst: true }] };
      await askAboutNext(0);
      return {
        buttons, asks, posted,
        output:   document.getElementById('output-lines').textContent,
        question: document.getElementById('ask-q').value,
        open:     !document.getElementById('ask-form').hidden,
      };
    } finally {
      window.fetch = realFetch;
      nextBody = kept;
      clearOutput();
      document.getElementById('ask-q').value = '';
      document.getElementById('ask-form').hidden = true;
    }
  `)
  t.is(about.asks, about.buttons, `every next-up row has an ask button (${about.asks} of ${about.buttons})`)
  t.ok(about.output.includes('FJS-9999 · S2 · litestone · ISSUES.md:76') && about.output.includes('a gate answers yes'), 'the issue lands in the output with where it is filed')
  t.ok(about.output.includes('stale?'), 'and a register that doubts it says so')
  t.ok(about.open && /FJS-9999 \(ISSUES\.md:76\)/.test(about.question), `the question about it waits in the field (${about.question})`)
  t.is(about.posted, 0, 'and nothing is sent until ask is pressed')
}
