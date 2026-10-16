/*
 * layout-ids.spec.mjs -- FJS-2610. Display and layout components whose state
 * or ids were shared by instances that must not share them.
 */
export const name = 'Layout ids · Pagination · Avatar'
export const covers = ['layout/Tabs', 'layout/Tab', 'layout/TabPanel', 'layout/TabList', 'layout/Accordion', 'layout/AccordionItem', 'display/Pagination', 'display/Avatar']

export async function run(t) {
  await t.mount('layout-ids')

  /* ── two strips, one set of tab names ─────────────────────────────────── */

  t.is(await t.evaluate(`
    const ids = [...document.querySelectorAll('#strip-a [id], #strip-b [id]')].map(e => e.id);
    return ids.length - new Set(ids).size;
  `), 0, 'two strips naming their tabs alike share no element id')
  t.ok(await t.evaluate(`
    return ['#strip-a', '#strip-b'].every(s => {
      const tab = document.querySelector(s + ' [role=tab]');
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      return !!panel && panel.closest(s) !== null && panel.getAttribute('aria-labelledby') === tab.id;
    });
  `), 'and each tab controls the panel in its own strip')

  // A quote in an id broke the selector the arrow walk used to find the next tab.
  await t.clickAt('#strip-q [role=tab][data-tab-id="plain"]')
  await t.press('ArrowLeft')
  await t.eventually(`document.activeElement?.getAttribute?.('data-tab-id')`, 'a"b',
    'a tab id holding a quote is reached by the arrow walk')

  /* ── an Accordion whose items state no id ─────────────────────────────── */

  await t.clickAt('#acc details:nth-of-type(1) .disclosure-summary')
  await t.eventually(`[...document.querySelectorAll('#acc details')].map(d => d.open).join()`, 'true,false',
    'an item with no id opens alone')
  t.is(await t.evaluate(`
    const ids = [...document.querySelectorAll('#acc summary')].map(e => e.id);
    return new Set(ids).size === ids.length && ids.every(Boolean);
  `), true, 'and its header id is its own')

  // The browser opens a <details> with no click (find-in-page, a URL hash).
  await t.evaluate(`document.querySelectorAll('#acc details')[1].open = true; return true;`)
  await t.eventually(`[...document.querySelectorAll('#acc details')].map(d => d.open).join()`, 'false,true',
    'a details the browser opened is adopted: exclusive mode closes the other')
  await t.clickAt('#acc details:nth-of-type(2) .disclosure-summary')
  await t.eventually(`[...document.querySelectorAll('#acc details')].map(d => d.open).join()`, 'false,false',
    'and the next click closes it, rather than reading closed and opening it again')

  /* ── a page that is a string ──────────────────────────────────────────── */

  await t.clickAt('#pager [aria-label="Next page"]')
  await t.eventually(`document.getElementById('seen').textContent`, '4',
    'Next from the string page "3" goes to 4, not "31"')

  /* ── an image that failed ─────────────────────────────────────────────── */

  await t.eventually(`!!document.querySelector('#avatar .avatar:not(img)')`, 'true',
    'an avatar whose image fails falls back to initials')
  await t.clickAt('#new-src')
  await t.eventually(`!!document.querySelector('#avatar img.avatar')`, 'true',
    'and tries again when given another image')
}
