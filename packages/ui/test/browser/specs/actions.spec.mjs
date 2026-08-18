/*
 * actions.spec.mjs — Button, Label, Card.
 *
 * Three components nothing had opened. Two of them look like markup and one
 * of them is not: `Button` reads `$context.form` and disables itself while a
 * submit is in flight, which is behaviour with no render-time symptom at all.
 */
export const name = 'Button · Label · Card'
export const covers = ['forms/Button', 'forms/Label', 'layout/Card']

const classesOf = (sel) => `[...document.querySelector(${JSON.stringify(sel)}).classList].sort().join(' ')`

export async function run(t) {
  await t.mount('actions')

  /* ── the default ──────────────────────────────────────────────────────── */

  t.is(await t.evaluate(`return ${classesOf('#b-default')};`), 'btn primary',
    'a default Button is a primary .btn')

  // A real button with a real type — a submit by accident inside a form is a
  // page reload.
  t.is(await t.evaluate(`return document.querySelector('#b-default').type;`),
    'button', 'and it does not submit unless asked to')

  /* ── tone and treatment compose ───────────────────────────────────────── */

  // The split that closed the old six-value `variant`: a tone and a treatment
  // are different kinds of class, so `outlined danger` needs no third entry.
  t.is(await t.evaluate(`return ${classesOf('#b-tone')};`), 'btn danger outlined',
    'a treatment in variant leaves the tone to the tone prop')
  t.is(await t.evaluate(`return ${classesOf('#b-ghost')};`), 'btn ghost',
    'and a treatment alone takes no tone at all')
  t.is(await t.evaluate(`return ${classesOf('#b-square')};`), 'btn primary square',
    'square is the icon-only shape')

  // A tone has to reach the paint, not just the class list. This is the
  // assertion that survives a class being renamed in the design system.
  const painted = await t.evaluate(`
    const bg = (sel) => getComputedStyle(document.querySelector(sel)).color;
    return { danger: bg('#b-tone'), plain: bg('#b-ghost') };
  `)
  t.ok(painted.danger !== painted.plain,
    `a tone paints something different from an untoned button (${painted.danger} vs ${painted.plain})`)

  /* ── href ─────────────────────────────────────────────────────────────── */

  t.is(await t.evaluate(`return document.querySelector('#b-link').tagName;`), 'A',
    'an href renders an anchor')
  t.is(await t.evaluate(`return document.querySelector('#b-link').getAttribute('role');`), null,
    'with no role="button" on it — it navigates, and saying otherwise misleads')
  // A disabled <a> is not a thing, so the component has to fall back to a
  // button rather than render a link that still navigates.
  t.is(await t.evaluate(`return document.querySelector('#b-link-off').tagName;`), 'BUTTON',
    'a disabled href falls back to a button')
  t.is(await t.evaluate(`return document.querySelector('#b-link-off').disabled;`), true,
    'which is actually disabled')

  /* ── snippets ─────────────────────────────────────────────────────────── */

  t.is(await t.evaluate(`
    return document.querySelector('#b-icons').textContent.replace(/\\s+/g, ' ').trim();
  `), '« Wrapped »', 'leading and trailing snippets sit either side of the label')

  /* ── loading ──────────────────────────────────────────────────────────── */

  await t.clickAt('#b-loading')
  await t.eventually(`document.querySelector('#runs').textContent`, '1', 'a button runs its onclick')

  await t.clickAt('#toggle-loading')
  await t.eventually(`document.querySelector('#b-loading').getAttribute('aria-busy')`, 'true',
    'loading is announced, not just drawn')
  t.ok(await t.evaluate(`return document.querySelector('#b-loading').classList.contains('loading');`),
    'and drawn as well')
  // Disabled rather than pointer-events: a pointer guard still lets the
  // keyboard through, which is the second submit nobody sees coming.
  t.is(await t.evaluate(`return document.querySelector('#b-loading').disabled;`), true,
    'a loading button is disabled, so a keyboard cannot fire it either')
  await t.evaluate(`document.querySelector('#b-loading').click(); return true;`)
  await t.eventually(`document.querySelector('#runs').textContent`, '1',
    'and a click while loading runs nothing')
  await t.clickAt('#toggle-loading')

  /* ── a submit reports the form's state ────────────────────────────────── */

  // Button's one hidden behaviour, and the reason it reads $context.form.
  t.is(await t.evaluate(`return document.querySelector('#b-submit').getAttribute('aria-busy');`), null,
    'a submit button is not busy while the form is idle')

  await t.clickAt('#b-submit')
  await t.eventually(`document.querySelector('#submits').textContent`, '1', 'clicking it submits')
  await t.eventually(`document.querySelector('#b-submit').getAttribute('aria-busy')`, 'true',
    'and while the submit is in flight the button says so without being told')
  t.is(await t.evaluate(`return document.querySelector('#b-submit').disabled;`), true,
    'and refuses a second submit')

  // Scoped to type="submit" deliberately: the Cancel beside it has to stay
  // live while the save runs, or a slow request traps the user in the form.
  t.is(await t.evaluate(`return document.querySelector('#b-cancel').disabled;`), false,
    'the button beside it stays live — Cancel is how you leave a slow save')

  await t.clickAt('#release')
  await t.eventually(`document.querySelector('#b-submit').getAttribute('aria-busy')`, 'null',
    'and it comes back when the submit settles')

  /* ── Label ────────────────────────────────────────────────────────────── */

  t.is(await t.evaluate(`
    return document.querySelector('#labels label').getAttribute('for');
  `), 'ctl-a', 'a Label points at the control it was given')
  // for="" points at nothing, and a label that points at nothing is worse
  // than one that reads as plain text — a screen reader announces a broken
  // association rather than none.
  t.is(await t.evaluate(`
    return document.querySelectorAll('#labels label')[1].getAttribute('for');
  `), null, 'and drops `for` entirely when there is no id')

  t.is(await t.evaluate(`
    return document.querySelector('#labels label').textContent.replace(/\\s+/g, ' ').trim();
  `), 'Customer (Optional)', 'an unspecified field is badged Optional, not starred required')
  t.is(await t.evaluate(`
    return document.querySelectorAll('#labels label')[2].textContent.replace(/\\s+/g, ' ').trim();
  `), 'Agreed', 'a checkbox suppresses it — an unticked box is not an empty field')
  t.is(await t.evaluate(`
    return document.querySelectorAll('#labels label')[3].textContent.replace(/\\s+/g, ' ').trim();
  `), 'Plan', 'a required field says nothing extra')
  t.is(await t.evaluate(`
    return document.querySelectorAll('#labels label')[4].textContent.replace(/\\s+/g, ' ').trim();
  `), 'Key (Beta)', 'an explicit badge wins over both')

  // The help text is in the title AND in a visually-hidden span: a title is
  // not announced reliably and cannot be reached on touch, so a help
  // affordance living only there is no help at all.
  const help = await t.evaluate(`
    const l = document.querySelectorAll('#labels label')[5];
    const span = l.querySelector('[title]');
    return { title: span?.getAttribute('title'), hidden: l.querySelector('.visually-hidden')?.textContent };
  `)
  t.is(help.title, 'Charged per seat, per month.', 'help is on the affordance')
  t.is(help.hidden, 'Charged per seat, per month.', 'and readable by something that cannot hover')

  /* ── Card ─────────────────────────────────────────────────────────────── */

  t.is(await t.evaluate(`return document.querySelector('#card-plain').tagName;`), 'ARTICLE',
    'a Card is an <article> — a unit you could lift out')
  t.is(await t.evaluate(`return ${classesOf('#card-plain')};`), 'card',
    'and a plain one is just the surface')
  t.is(await t.evaluate(`return ${classesOf('#card-full')};`), 'card danger raised',
    'a tone and a treatment compose on it too')

  // The header and footer bleed to the card edges through negative margins in
  // cards.css, which only works while they are DIRECT children.
  t.ok(await t.evaluate(`
    const card = document.querySelector('#card-full');
    return card.querySelector(':scope > .surface-header > #card-head') !== null
        && card.querySelector(':scope > .surface-footer > #card-foot') !== null;
  `), 'header and footer are direct children of the card')
  // First class only: a scoped style adds a content-addressed hash class, and
  // asserting on the whole className would pin a value that is meant to change
  // when the source does.
  t.is(await t.evaluate(`
    const kids = [...document.querySelector('#card-full').children].map(el => el.classList[0] || el.id);
    return kids.join(',');
  `), 'surface-header,card-body,surface-footer', 'in that order, with the body between them')

  t.ok(await t.evaluate(`
    const px = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).paddingTop);
    return px('#card-full') > px('#card-plain');
  `), 'padding="lg" is bigger than the default it overrides')
}
