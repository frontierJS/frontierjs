/*
 * tail.spec.mjs — the last ten components nothing had opened.
 *
 * Badge, Pill, Stat, StatCard, Breadcrumbs, EmptyState, SectionHeader,
 * Progress, Spinner, Skeleton. They were called "mostly static markup", and
 * that is the reason to ask a browser rather than a renderer: what static
 * markup gets wrong is what it ANNOUNCES and what it PAINTS, and both are
 * invisible to a string comparison of the HTML.
 *
 * So the assertions here are deliberately not class lists. A tone is asked for
 * as a painted color, a loading state as `aria-busy`, a heading level as a
 * tag name, and a decorative glyph as `aria-hidden`.
 */
export const name = 'the display and feedback tail'
export const covers = [
  'display/Badge', 'display/Pill', 'display/Stat', 'display/StatCard',
  'display/Breadcrumbs', 'display/EmptyState', 'display/SectionHeader',
  'feedback/Progress', 'feedback/Spinner', 'feedback/Skeleton',
]

const text = (sel) => `document.querySelector(${JSON.stringify(sel)})?.textContent?.replace(/\\s+/g,' ').trim()`

export async function run(t) {
  await t.mount('tail')

  /* ── Badge and Pill ───────────────────────────────────────────────────── */

  // A tone is only real if it reaches the paint. Comparing two instances
  // rather than asserting a literal color keeps this true across all eleven
  // themes and any future palette change.
  const toned = await t.evaluate(`
    const c = (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor;
    return { plain: c('#badge-plain'), danger: c('#badge-danger') };
  `)
  t.ok(toned.plain !== toned.danger,
    `a toned Badge paints differently from an untoned one (${toned.plain} vs ${toned.danger})`)

  t.is(await t.evaluate(`return ${text('#pill-plan')};`), 'Enterprise',
    'a Pill with a plan states the plan, overriding its own children')
  const planTone = await t.evaluate(`
    const c = (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor;
    return c('#pill-plan') !== c('#pill-plain');
  `)
  t.ok(planTone, 'and carries the tone that plan implies')

  // The dot is drawn in currentColor so it tracks the auto-contrast text
  // color rather than restating the tone — and it is decorative, so it must
  // not be announced.
  const dot = await t.evaluate(`
    const el = document.querySelector('#pill-dot > [aria-hidden=true]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, ink: getComputedStyle(el.parentElement).color };
  `)
  t.ok(dot && dot.bg === dot.ink, 'a Pill dot is drawn in the text color it sits in')
  t.is(await t.evaluate(`return ${text('#pill-dot')};`), 'Live',
    'and adds nothing to what is read out')

  /* ── Stat ─────────────────────────────────────────────────────────────── */

  t.is(await t.evaluate(`return ${text('#stat-up')};`), 'Revenue £12,400 ↑ +8% on last month',
    'a Stat reads label, value, then the delta')
  t.ok(await t.evaluate(`
    return document.querySelector('#stat-up .tile-delta span').getAttribute('aria-hidden') === 'true';
  `), 'the trend arrow is decorative — the words beside it carry the meaning')
  t.ok(await t.evaluate(`
    return document.querySelector('#stat-up .tile-delta').classList.contains('success');
  `), 'and an up trend takes a tone without being given one')
  t.is(await t.evaluate(`return document.querySelectorAll('#stat-bare .tile-delta').length;`), 0,
    'a Stat with no trend and no sub renders no delta row at all')

  /* ── StatCard ─────────────────────────────────────────────────────────── */

  // A real anchor, not a div with role="button": the div loses middle-click,
  // open-in-new-tab and the status bar showing where it goes.
  t.is(await t.evaluate(`return document.querySelector('#tile-link').tagName;`), 'A',
    'a StatCard with an href is a link')
  t.is(await t.evaluate(`return document.querySelector('#tile-link').getAttribute('href');`), '/orders/',
    'that points somewhere')

  t.is(await t.evaluate(`
    return document.querySelector('#tile-loading [aria-busy=true]') !== null;
  `), true, 'a loading StatCard announces itself busy rather than just drawing gray boxes')

  /* ── Breadcrumbs ──────────────────────────────────────────────────────── */

  t.is(await t.evaluate(`
    return document.querySelector('#trail-all nav').getAttribute('aria-label');
  `), 'Breadcrumb', 'the trail is a named landmark')
  t.is(await t.evaluate(`return document.querySelectorAll('#trail-all li').length;`), 5,
    'every item is a list item')
  t.is(await t.evaluate(`
    return document.querySelectorAll('#trail-all a').length;
  `), 4, 'all but the last are links')
  t.is(await t.evaluate(`
    return ${text('#trail-all [aria-current=page]')};
  `), 'INV-204', 'and the last is the current page')
  t.is(await t.evaluate(`
    return document.querySelector('#trail-all [aria-current=page]').tagName;
  `), 'SPAN', 'never a link to where you already are')

  // Truncation decides which item IS last, so both answers have to come from
  // one pass — a template re-deriving "last" against the original length marks
  // the wrong item.
  t.is(await t.evaluate(`return document.querySelectorAll('#trail-cut li').length;`), 4,
    'maxItems collapses the middle')
  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#trail-cut li')].map(li => li.textContent.trim()).join('|');
  `), 'Home|…|Invoices|INV-204', 'keeping the first, the last N, and an ellipsis between')
  t.is(await t.evaluate(`
    return ${text('#trail-cut [aria-current=page]')};
  `), 'INV-204', 'and the current page is still the current page after the cut')
  t.is(await t.evaluate(`
    return document.querySelectorAll('#trail-cut [aria-current=page]').length;
  `), 1, 'exactly one of them')

  /* ── EmptyState and SectionHeader ─────────────────────────────────────── */

  t.is(await t.evaluate(`return ${text('#empty .empty-title')};`), 'No invoices yet',
    'an EmptyState titles itself')
  t.is(await t.evaluate(`return document.querySelector('#empty .empty-title').tagName;`), 'H3',
    'as a real heading')
  t.ok(await t.evaluate(`
    return document.querySelector('#empty .empty-icon').getAttribute('aria-hidden') === 'true';
  `), 'with a decorative icon')
  await t.clickAt('#empty-cta')
  await t.eventually(`document.querySelector('#actions').textContent`, '1',
    'and its action snippet is live, not a picture of a button')

  // The outline belongs to the caller's document, which is why level is a prop
  // and not a font-weight.
  t.is(await t.evaluate(`
    return document.querySelector('#head-default h2')?.textContent?.trim();
  `), 'Team', 'a SectionHeader defaults to an h2')
  t.is(await t.evaluate(`
    return document.querySelector('#head-h4 h4')?.textContent?.trim();
  `), 'Danger zone', 'and takes the level it is given')
  t.ok(await t.evaluate(`
    return document.querySelector('#head-h4 #head-action') !== null;
  `), 'its action snippet renders')
  t.ok(await t.evaluate(`
    const cs = getComputedStyle(document.querySelector('#head-h4'));
    return parseFloat(cs.borderBlockEndWidth) > 0;
  `), 'and border draws an actual rule')

  /* ── Progress ─────────────────────────────────────────────────────────── */

  // Native <progress>, so role, value and max are the platform's — there is no
  // ARIA here to keep in sync, which is the point worth pinning.
  const bar = await t.evaluate(`
    const el = document.querySelector('#progress-determinate progress');
    return { tag: el.tagName, value: el.value, max: el.max, role: el.getAttribute('role') };
  `)
  t.is(bar.tag, 'PROGRESS', 'Progress is a native <progress>')
  t.is(bar.value, 30, 'carrying its value')
  t.is(bar.max, 100, 'and its max')
  t.is(bar.role, null, 'with no hand-written role to drift from it')
  // Read the label row, not the whole block: a <progress> carries legacy
  // fallback text for engines without the element, so textContent of the
  // container says the percentage twice.
  t.is(await t.evaluate(`return ${text('#progress-determinate .split')};`), 'Uploading 30%',
    'showLabel prints the percentage beside the label')

  await t.clickAt('#advance')
  await t.eventually(`document.querySelector('#progress-determinate progress').value`, '75',
    'and it follows the value it is given')
  await t.eventually(`${text('#progress-determinate .split')}`, 'Uploading 75%', 'label included')

  // An indeterminate bar must carry NO value attribute: value={undefined}
  // still renders a determinate bar at zero in some engines, which reads as
  // "stuck at 0%" rather than "working".
  t.is(await t.evaluate(`
    return document.querySelector('#progress-indeterminate progress').hasAttribute('value');
  `), false, 'an indeterminate bar has no value at all')
  t.is(await t.evaluate(`
    return document.querySelector('#progress-indeterminate progress').getAttribute('aria-label');
  `), 'Working', 'and is named, since it has no percentage to read')

  t.ok(await t.evaluate(`
    const h = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).blockSize);
    return h('#progress-toned progress') > h('#progress-determinate progress');
  `), 'size is a real block-size, not a class that lands nowhere')

  /* ── Spinner ──────────────────────────────────────────────────────────── */

  // The whole accessibility contract for this component is the split: a
  // decorative ring, and a live region that says what is happening.
  const spinner = await t.evaluate(`
    const ring = document.querySelector('#spin .spinner');
    const live = document.querySelector('#spin [role=status]');
    return {
      hidden: ring.getAttribute('aria-hidden'),
      says: live?.textContent?.trim(),
      liveHidden: live?.classList.contains('visually-hidden'),
    };
  `)
  t.is(spinner.hidden, 'true', 'the ring itself is decorative')
  t.is(spinner.says, 'Saving…', 'and a live region announces the label')
  t.is(spinner.liveHidden, true, 'without printing it on screen')

  t.ok(await t.evaluate(`
    const px = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).fontSize);
    return px('#spin-lg .spinner') > px('#spin .spinner');
  `), 'size is a font-size, so a spinner matches the text it sits beside')

  /* ── Skeleton ─────────────────────────────────────────────────────────── */

  t.is(await t.evaluate(`
    return getComputedStyle(document.querySelector('#sk-text')).inlineSize
      === getComputedStyle(document.querySelector('#skeletons')).inlineSize;
  `), false, 'a width on a Skeleton is applied, not ignored')
  t.ok(await t.evaluate(`
    const cs = getComputedStyle(document.querySelector('#sk-avatar'));
    return parseFloat(cs.borderRadius) > 0 && cs.inlineSize === cs.blockSize;
  `), 'an avatar skeleton is a circle of equal sides')
  // A screenful of gray boxes announced as content is worse than nothing,
  // which is why the composite variants carry the busy state themselves.
  t.ok(await t.evaluate(`
    return document.querySelector('#skeletons article.card[aria-busy=true]') !== null;
  `), 'a card skeleton marks itself busy')
}
