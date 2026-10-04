/*
 * display.spec.mjs — the display tier's long tail.
 *
 * Thirteen components that a render test already proves emit the right
 * classes. What it cannot prove is that they DRAW: a Sparkline's path is
 * computed from data, a Bar's fill is a percentage, an AvatarGroup overlaps
 * and truncates, a Steps list changes axis with `orientation`. Every one of
 * those is a number the component worked out, and a wrong number renders a
 * component that looks plausible and says something false.
 *
 * The ones with behavior — CopyButton, Tag, a clickable Steps — are driven
 * rather than inspected.
 */
export const name = 'display tier'
export const covers = [
  'display/Sparkline', 'display/Chart', 'display/Bar', 'display/Avatar', 'display/AvatarGroup',
  'display/CopyButton', 'display/Dot', 'display/Kbd', 'display/Mono',
  'display/Divider', 'display/Tag', 'display/Steps', 'display/AccountStatus',
  'display/Callout',
]

export async function run(t) {
  await t.mount('display')

  /* ── Sparkline ───────────────────────────────────────────────────────── */

  // The path is the component: [1,4,2,8,5] has to become five points inside
  // the box, and an empty or NaN-bearing `d` still renders an <svg> that
  // occupies space.
  // The polyline, not the area fill beneath it: the fill closes the shape
  // with two baseline corners, so counting its points counts the geometry
  // rather than the data.
  const spark = await t.evaluate(`
    const svg = document.querySelector('#probe-sparkline svg');
    const d = svg.querySelector('polyline').getAttribute('points');
    const r = svg.getBoundingClientRect();
    return { d, w: r.width, h: r.height, label: svg.getAttribute('aria-label') || svg.querySelector('title')?.textContent };
  `)
  t.ok(spark.d && !/NaN|Infinity/.test(spark.d), 'the sparkline computes a path with no NaN in it')
  t.is((spark.d.match(/[\d.]+[ ,][\d.]+/g) ?? []).length, 5, 'one point per value')
  t.ok(spark.w > 0 && spark.h > 0, 'and the svg occupies its declared box')
  t.match(spark.label, /Signups/, 'a labeled sparkline is announced rather than decorative')

  // …AND IT REDRAWS WHEN THE DATA MOVES, which nothing here had ever asked.
  // Every derived value in the component is a plain `const` — `normalized`,
  // `pointsStr`, `areaPath` — so the body reads like one that runs once per
  // instance, and the whole point of a sparkline is data that changes. It does
  // recompute; this row is what says so, and what would notice if a change to
  // the compiler or to the component stopped it. The point COUNT is asserted
  // on both sides as well as the path, because a redraw that threw the data
  // away would also change the path.
  const before = await t.evaluate(
    `return document.querySelector('#probe-sparkline-live polyline').getAttribute('points')`)
  await t.clickAt('#grow-sparkline')
  const after = await t.evaluate(
    `return document.querySelector('#probe-sparkline-live polyline').getAttribute('points')`)

  t.is((before.match(/[\d.]+[ ,][\d.]+/g) ?? []).length, 5, 'five values before')
  t.is((after.match(/[\d.]+[ ,][\d.]+/g)  ?? []).length, 7, 'and seven after two more arrive')
  t.ok(before !== after, 'the path actually moved')

  /* ── Chart ───────────────────────────────────────────────────────────── */

  // Every bar is a path computed from a value against a zero baseline, so a
  // negative month must hang BELOW the zero line rather than rise from the
  // floor, and a NaN anywhere draws nothing while looking like a chart.
  const chart = await t.evaluate(`
    const svg = document.querySelector('#probe-chart svg');
    const bars = [...svg.querySelectorAll('.fjs-chart-bar')].map(p => p.getBBox());
    const zero = svg.querySelector('.fjs-chart-zero').getAttribute('y1');
    return {
      label: svg.getAttribute('aria-label'),
      ds: [...svg.querySelectorAll('.fjs-chart-bar')].map(p => p.getAttribute('d')),
      bars: bars.map(b => ({ top: b.y, bottom: b.y + b.height, w: b.width })),
      zero: Number(zero),
      values: [...svg.querySelectorAll('.fjs-chart-value')].map(t => t.textContent),
      hits: svg.querySelectorAll('.fjs-chart-hit[tabindex="0"]').length,
    };
  `)
  t.is(chart.label, 'Net per month', 'the chart is a labeled group')
  t.ok(chart.ds.length === 3 && chart.ds.every(d => d && !/NaN|Infinity/.test(d)), 'one bar per row, with no NaN in any path')
  t.ok(chart.bars.every(b => b.w <= 24), 'no bar is thicker than 24 units')
  t.ok(Math.abs(chart.bars[1].bottom - chart.zero) < 0.5 && chart.bars[1].top < chart.zero, 'a positive bar rises from the zero line')
  t.ok(Math.abs(chart.bars[2].top - chart.zero) < 0.5 && chart.bars[2].bottom > chart.zero, 'a negative bar hangs below it')
  t.is(JSON.stringify(chart.values), JSON.stringify(['50 u', '-10 u']), 'only the largest and the last value are labeled, through format')
  t.is(chart.hits, 3, 'one focusable hit target per row')

  // The readout: a real pointer on a band, then the keyboard onto the next.
  const tip = () => t.evaluate(`return {
    value: document.querySelector('#probe-chart .fjs-chart-tip-value')?.textContent ?? null,
    at:    document.querySelector('#probe-chart .fjs-chart-tip-label')?.textContent ?? null,
  }`)
  await t.clickAt('#probe-chart .fjs-chart-hit[data-index="0"]')
  const hovered = await tip()
  t.ok(hovered.value === '30 u' && hovered.at === 'Jan', 'pointing at a band reads out its category and value')
  await t.press('Tab')
  const tabbed = await tip()
  t.ok(tabbed.value === '50 u' && tabbed.at === 'Feb', 'Tab moves the readout to the next mark')

  // And it redraws when the rows change.
  await t.clickAt('#grow-chart')
  t.is(await t.evaluate(`return document.querySelectorAll('#probe-chart .fjs-chart-bar').length`), 4, 'a fourth row draws a fourth bar')

  /* ── Bar ─────────────────────────────────────────────────────────────── */

  // Bar is a native <progress>, so the fill is the UA's and the value is the
  // component's. Reading the property rather than the attribute is the point:
  // an attribute that never became a property renders an empty track.
  t.ok(await t.evaluate(`
    const p = document.querySelector('#probe-bar progress.progress');
    const r = p.getBoundingClientRect();
    return p.value === 74 && p.max === 100 && r.width > 0;
  `), 'the bar carries the value it was given, as a real <progress>')
  t.ok(await t.evaluate(`return !!byText('#probe-bar', '74');`), 'and shows the number with its unit')

  /* ── Avatar / AvatarGroup ────────────────────────────────────────────── */

  t.is(await t.evaluate(`
    return document.querySelector('#probe-avatar .avatar').textContent.trim();
  `), 'AL', 'an Avatar with no src falls back to initials')

  t.ok(await t.evaluate(`
    const wrap = document.querySelector('#probe-avatar .fjs-avatar-wrap');
    const dot  = wrap.querySelector('.fjs-avatar-status');
    const wr = wrap.getBoundingClientRect(), dr = dot.getBoundingClientRect();
    return dr.width > 0 && dr.right <= wr.right + 1 && dr.bottom <= wr.bottom + 1;
  `), 'a status marker is pinned inside the avatar\'s own corner')

  // max={4} over six users: four avatars and a +2.
  t.is(await t.evaluate(`return document.querySelectorAll('#probe-avatars .avatar').length;`), 5,
    'AvatarGroup shows max avatars plus the overflow counter')
  t.ok(await t.evaluate(`return !!byText('#probe-avatars', '+2');`),
    'the counter names how many are hidden')

  // Overlap is the whole visual idea of a group, and it is a negative margin
  // — the one thing a class assertion cannot see.
  t.ok(await t.evaluate(`
    const [a, b] = [...document.querySelectorAll('#probe-avatars .avatar')];
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return rb.left < ra.right;
  `), 'the avatars overlap')

  /* ── CopyButton ──────────────────────────────────────────────────────── */

  // The clipboard needs a permission headless Chrome does not grant, so the
  // callback and the acknowledgement are what is asserted — a component that
  // copies and never says so is the failure users report.
  await t.clickAt('#probe-copy button')
  await t.eventually(`document.querySelector('#copied').textContent`, '1',
    'CopyButton reports what it copied')
  t.ok(await t.evaluate(`
    await new Promise(r => setTimeout(r, 60));
    return document.querySelector('#probe-copy').textContent.trim() !== 'Copy id';
  `), 'and acknowledges the copy on the button itself')

  /* ── the small ones ──────────────────────────────────────────────────── */

  t.ok(await t.evaluate(`
    // The solid dot, not the ping ring beside it — the ring is sized by the
    // keyframe and is deliberately not square at rest.
    const dot = document.querySelector('#probe-dot .feed-dot:not(.fjs-dot-ping)');
    const r = dot.getBoundingClientRect();
    return r.width > 0 && r.width === r.height;
  `), 'a Dot is square, so it renders as a circle rather than an ellipse')
  t.is(await t.evaluate(`return document.querySelectorAll('#probe-kbd .kbd').length;`), 2,
    'Kbd gives each key its own badge')
  t.match(await t.evaluate(`
    return getComputedStyle(document.querySelector('#probe-mono code, #probe-mono .code-inline')).fontFamily;
  `), /mono/i, 'Mono renders in the monospace face')
  t.ok(await t.evaluate(`return !!byText('#probe-divider', 'or');`),
    'a labeled Divider shows its label')
  t.ok(await t.evaluate(`
    const s = document.querySelector('#probe-account');
    return s.textContent.includes('12 days left') && !!s.querySelector('.feed-dot');
  `), 'AccountStatus pairs a dot with its secondary line')
  t.ok(await t.evaluate(`
    const c = document.querySelector('#probe-callout');
    return c.textContent.includes('Nearly there') && c.querySelector('.callout, .alert, .card') !== null;
  `), 'a Callout renders its title and body')

  /* ── Tag ─────────────────────────────────────────────────────────────── */

  await t.clickAt('#probe-tag .pill-close')
  await t.eventually(`document.querySelector('#removed').textContent`, '1',
    'a Tag\'s dismiss button calls onremove')

  /* ── Steps ───────────────────────────────────────────────────────────── */

  t.ok(await t.evaluate(`
    const marks = [...document.querySelectorAll('#probe-steps li')];
    return marks.length === 3;
  `), 'Steps renders one item per step')

  // A completed step, not a pending one: `clickable` deliberately does not
  // offer a control for a step nobody has reached yet, so clicking "Confirm"
  // reports nothing and would read as a broken callback.
  await t.evaluate(`
    byText('#probe-steps li', 'Cart').querySelector('button').click();
    return true;
  `)
  await t.eventually(`document.querySelector('#stepped').textContent`, 'cart',
    'a clickable Steps reports a completed step by id')
  t.ok(await t.evaluate(`
    return !byText('#probe-steps li', 'Confirm').querySelector('button');
  `), 'and offers no control for a step that has not been reached')

  // Orientation is a layout fact and nothing else: the same markup, the same
  // classes, laid out along the other axis.
  const horizontal = await t.evaluate(`
    const [a, b] = [...document.querySelectorAll('#probe-steps li')];
    return { sameRow: Math.abs(a.getBoundingClientRect().top - b.getBoundingClientRect().top) < 4 };
  `)
  t.ok(horizontal.sameRow, 'horizontal Steps sit on one row')

  await t.mount('display', { orientation: 'vertical' })
  const vertical = await t.evaluate(`
    const [a, b] = [...document.querySelectorAll('#probe-steps li')];
    return { stacked: b.getBoundingClientRect().top > a.getBoundingClientRect().top + 4 };
  `)
  t.ok(vertical.stacked, 'orientation="vertical" stacks them — the mode nothing had rendered')
}
