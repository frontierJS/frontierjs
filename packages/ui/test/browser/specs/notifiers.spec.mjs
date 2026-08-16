/*
 * notifiers.spec.mjs — Toaster + toastStore, AlertProvider + alertStore.
 *
 * Both are a component plus a module-singleton store, and the seam between
 * them is the thing that breaks: a store writes through `watchProxy` because a
 * bare assignment updates the object and notifies nobody — every toast queued
 * correctly, the array grew, and the stack on screen stayed empty. That is a
 * runtime fact with no compile-time or render-time symptom at all.
 *
 * `max` is asserted because it is the one piece of policy the Toaster owns,
 * and the tone class because a toast whose tone never reached the DOM is an
 * error message painted like a success.
 *
 * The second half is the HANDLE (`FJS-119`). A long action has to be able to
 * say it has started and then say how it went, on one toast — and the only
 * thing that ever took an id back was `remove()`, so every caller either said
 * nothing until the end or left a "Sending…" on screen for good. What makes it
 * testable rather than plausible is node identity: an update that removes the
 * toast and adds another looks identical in a screenshot and loses the
 * reader's place in the stack.
 */
export const name = 'Toaster · AlertProvider'
export const covers = [
  'feedback/Toaster', 'feedback/Toast', 'feedback/AlertProvider', 'feedback/Alert',
]

export async function run(t) {
  await t.mount('notifiers')

  t.is(await t.evaluate(`return document.querySelectorAll('.toast-stack .toast').length;`), 0,
    'the stack starts empty')

  // duration 0 — a toast that dismisses itself mid-assertion is a flake, and
  // the timer is asserted separately below.
  await t.evaluate(`window.toasts.success('File uploaded', 0); return true;`)
  await t.evaluate(`await waitFor(() => document.querySelector('.toast-stack .toast')); return true;`)

  t.ok(await t.evaluate(`return !!byText('.toast-stack .toast', 'File uploaded');`),
    'a queued toast reaches the screen')
  t.ok(await t.evaluate(`
    return document.querySelector('.toast-stack .toast').classList.contains('success');
  `), 'and carries its tone')

  // Each toast must be a DIRECT child of the stack: `.toast-stack > .toast` is
  // what re-statics them, and a wrapper div left every toast `position: fixed`
  // in the same corner, stacked on top of one another.
  t.ok(await t.evaluate(`
    const stack = document.querySelector('.toast-stack');
    return [...stack.children].every(el => el.classList.contains('toast'));
  `), 'every toast is a direct child of the stack')

  await t.evaluate(`
    window.toasts.error('One', 0); window.toasts.warning('Two', 0);
    window.toasts.info('Three', 0); window.toasts.info('Four', 0);
    return true;
  `)
  await t.eventually(`document.querySelectorAll('.toast-stack .toast').length`, 3,
    'max={3} shows three at a time however many are queued')

  await t.evaluate(`window.toasts.clear(); return true;`)
  await t.eventually(`document.querySelectorAll('.toast-stack .toast').length`, 0,
    'clear() empties the stack')

  // The timer is the store's, and it is the only part of the queue an app
  // does not drive itself.
  await t.evaluate(`window.toasts.info('Briefly', 150); return true;`)
  await t.evaluate(`await waitFor(() => byText('.toast-stack .toast', 'Briefly')); return true;`)
  await t.eventually(`document.querySelectorAll('.toast-stack .toast').length`, 0,
    'a toast with a duration removes itself')

  /* ── the handle ──────────────────────────────────────────────────────── */

  await t.evaluate(`window.__h = window.toasts.loading('Sending…'); return true;`)
  await t.evaluate(`await waitFor(() => byText('.toast-stack .toast', 'Sending…')); return true;`)

  t.ok(await t.evaluate(`
    const toast = byText('.toast-stack .toast', 'Sending…');
    return !!toast.querySelector('.spinner');
  `), 'a loading toast carries a spinner rather than an outcome icon')

  t.ok(await t.evaluate(`
    const toast = byText('.toast-stack .toast', 'Sending…');
    return !toast.querySelector('.fjs-toast-drain');
  `), 'and no drain bar — nothing knows how long the work will take')

  // It must still be there after the default lifetime has passed. This is the
  // assertion that a `duration: 0` toast really is not scheduled, rather than
  // scheduled with a value that happens to be long.
  t.ok(await t.evaluate(`
    await new Promise(r => setTimeout(r, 600));
    return !!byText('.toast-stack .toast', 'Sending…');
  `), 'a loading toast does not dismiss itself')

  // Mark the node, settle the toast, and look for the SAME node afterwards.
  await t.evaluate(`byText('.toast-stack .toast', 'Sending…').dataset.mark = 'one'; return true;`)
  await t.evaluate(`window.__h.update('success', 'Sent'); return true;`)

  await t.eventually(`byText('.toast-stack .toast', 'Sent')?.dataset.mark`, 'one',
    'update() edits the toast in place rather than replacing it')
  t.ok(await t.evaluate(`
    const toast = document.querySelector('.toast-stack .toast[data-mark=one]');
    return toast.classList.contains('success') && !toast.querySelector('.spinner');
  `), 'and settles its tone and its icon')

  // Settling gives it the lifetime it did not have. Read off the store rather
  // than waited out: the default is 3.5s, and a spec that sleeps through it
  // adds three and a half seconds to every run to learn one number.
  t.is(await t.evaluate(`
    return window.toasts.items.find(x => x.message === 'Sent')?.duration;
  `), 3500, 'a settled toast takes the default lifetime it did not have')

  // That the timer actually runs is the separate question, asked at a length
  // a test can wait for.
  await t.evaluate(`window.toasts.clear(); window.__s = window.toasts.loading('Saving…'); return true;`)
  await t.evaluate(`await waitFor(() => byText('.toast-stack .toast', 'Saving…')); return true;`)
  await t.evaluate(`window.__s.update('success', 'Saved', 200); return true;`)
  await t.eventually(`document.querySelectorAll('.toast-stack .toast').length`, 0,
    'and then dismisses itself')

  // A reader who closed the toast has closed it. Answering true here — or
  // re-adding the message — is a "Sent" appearing after they dismissed it.
  const gone = await t.evaluate(`
    const h = window.toasts.loading('Working…');
    h.dismiss();
    await new Promise(r => setTimeout(r, 30));
    return { settled: h.update('success', 'Done'), onScreen: document.querySelectorAll('.toast-stack .toast').length };
  `)
  t.is(gone.settled, false, 'settling a dismissed toast answers false')
  t.is(gone.onScreen, 0, 'and does not put it back')

  // Settling twice — a retry that fails and then succeeds — must not leave the
  // first timer running to remove the second message early.
  await t.evaluate(`
    window.__h2 = window.toasts.loading('Retrying…');
    window.__h2.update('error', 'Failed', 400);
    await new Promise(r => setTimeout(r, 150));
    window.__h2.update('success', 'Recovered');
    return true;
  `)
  t.ok(await t.evaluate(`
    await new Promise(r => setTimeout(r, 400));
    const toast = byText('.toast-stack .toast', 'Recovered');
    return !!toast && toast.classList.contains('success');
  `), 'settling twice restarts the lifetime rather than keeping the first timer')
  await t.evaluate(`window.toasts.clear(); return true;`)

  /* ── the alert banner ────────────────────────────────────────────────── */

  await t.evaluate(`window.alert_.success('Changes saved', 0); return true;`)
  t.ok(await t.evaluate(`return await waitVisible('.alert.raised');`),
    'alert.success() shows the floating alert')
  t.ok(await t.evaluate(`return document.querySelector('.alert.raised').classList.contains('success');`),
    'with the tone it was given')

  // A second show() while one is up: the message and the tone both have to
  // change. `message` was missing a watch, so the tone swapped and the
  // previous text stayed on screen — which is the worst of the three states.
  await t.evaluate(`window.alert_.error('Something went wrong', 0); return true;`)
  await t.eventually(`document.querySelector('.alert.raised')?.textContent.trim()`, 'Something went wrong',
    'a second alert replaces the text')
  t.ok(await t.evaluate(`
    const a = document.querySelector('.alert.raised');
    return a.classList.contains('danger') && !a.classList.contains('success');
  `), 'and replaces the tone rather than keeping both')

  await t.evaluate(`window.alert_.hide(); return true;`)
  await t.eventually(`!!document.querySelector('.alert.raised')`, false, 'hide() takes it away')
}
