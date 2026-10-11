/*
 * copy-button.spec.mjs -- CopyButton's fallback, where `navigator.clipboard`
 * is refused: a plain-HTTP origin, an older browser.
 *
 * `FJS-2601`: the textarea the fallback selects was put on <body>, which a
 * modal <dialog> makes inert -- the select is refused, `execCommand('copy')`
 * copies an empty selection and the button said Copied! anyway. On the page
 * the textarea took focus and was removed holding it, so focus fell to <body>.
 * Only a real browser has inert and a top layer, so only a drive can see it.
 */
export const name   = 'CopyButton fallback'
export const covers = ['display/CopyButton']

// Refuse the async clipboard so the fallback runs, and record what each
// `execCommand('copy')` saw selected and what it answered.
const refuse = `
  navigator.clipboard.writeText = () => Promise.reject(new Error('refused'));
  window.__copies = [];
  const real = document.execCommand.bind(document);
  document.execCommand = (cmd, ...rest) => {
    const el = document.activeElement;
    const selected = el && 'selectionStart' in el && el.value != null
      ? el.value.slice(el.selectionStart, el.selectionEnd) : String(getSelection());
    const answer = (window.__answer ?? real)(cmd, ...rest);
    window.__copies.push([cmd, answer, selected]);
    return answer;
  };
  return true;
`
// The page outlives the spec, so a stub left behind refuses the next spec's copy.
const restore = `
  delete navigator.clipboard.writeText;
  delete document.execCommand;
  delete window.__answer;
  return true;
`
const last    = `window.__copies.at(-1)`
const copied  = (where) => `document.querySelector('${where} button').classList.contains('success')`

export async function run(t) {
  await t.mount('copy-button')
  await t.evaluate(refuse)
  try {
    await drive(t)
  } finally {
    await t.evaluate(restore)
  }
}

async function drive(t) {
  /* -- on the page --------------------------------------------------------- */

  await t.clickAt('#on-page button')
  await t.eventually(copied('#on-page'), true, 'a fallback copy on the page acknowledges')
  t.is(await t.evaluate(`return JSON.stringify(${last});`), JSON.stringify(['copy', true, 'page-text']),
    'and the text was what was selected when it copied')
  t.is(await t.evaluate(`return document.activeElement === document.querySelector('#on-page button');`), true,
    'focus is back on the button, not dropped to <body>')

  /* -- inside a Modal ------------------------------------------------------ */

  await t.clickAt('#stage #open-modal')
  await t.evaluate(`await waitFor(() => document.querySelector('dialog[open]')); return true;`)
  await t.evaluate(`return await waitVisible('#in-modal button');`)

  await t.clickAt('#in-modal button')
  await t.eventually(`window.__copies.length`, 2, 'the copy inside a modal ran')
  t.is(await t.evaluate(`return JSON.stringify(${last});`), JSON.stringify(['copy', true, 'modal-text']),
    'the text was selected inside the modal, where the inert document cannot reach')
  await t.eventually(copied('#in-modal'), true, 'and the button acknowledges a copy that happened')
  t.is(await t.evaluate(`return document.activeElement === document.querySelector('#in-modal button');`), true,
    'focus is back on the button inside the modal')

  /* -- a copy the browser refuses ----------------------------------------- */

  await t.evaluate(`window.__answer = () => false; return true;`)
  await t.evaluate(`await new Promise(r => setTimeout(r, 2100)); return true;`)
  await t.clickAt('#in-modal button')
  await t.eventually(`window.__copies.length`, 3, 'the refused copy ran')
  t.is(await t.evaluate(`await new Promise(r => setTimeout(r, 60)); return ${copied('#in-modal')};`), false,
    'a copy execCommand refused does not say Copied!')
  t.is(await t.evaluate(`return document.querySelector('#copies').textContent;`), '2',
    'and does not report a copy to oncopy')
}
