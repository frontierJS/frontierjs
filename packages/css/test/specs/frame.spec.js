/*
 * frame.spec.js — the shell chrome, and the one measurement that catches it.
 *
 * `.topbar` and `.cluster` are paired in this package's own frame
 * documentation and in the guide's shell demo, and the pairing was broken:
 * a cluster is `flex-wrap: wrap`, a topbar was a fixed `block-size` with
 * `align-items: center`, so a bar holding more than fits laid a SECOND ROW
 * inside a fixed box and centered both — drawing half its contents above the
 * bar and half below it, over the page.
 *
 * Nothing overflowed horizontally at any width, so the usual smell test —
 * does the page scroll sideways — missed it entirely, and it was found by
 * reading coordinates in a real browser rather than by looking (`FJS-338`).
 *
 * So these assert GEOMETRY, not declarations. A rule check would have passed
 * against the broken version: every property in it was doing what it said.
 */

/* A bar with more in it than a narrow viewport can fit on one line. */
function overfullBar(inlineSize) {
  return el(
    '<div class="shell" style="inline-size:' + inlineSize + '">' +
      '<header class="topbar">' +
        '<div class="cluster">' +
          '<button class="btn">Menu</button>' +
          '<span>a-workspace-with-a-long-name</span>' +
        '</div>' +
        '<div class="cluster">' +
          '<span>somebody@an-organization.example</span>' +
          '<button class="btn">Sign out</button>' +
        '</div>' +
      '</header>' +
    '</div>',
    '.topbar'
  );
}

/* ── The bar contains what is in it ───────────────────────────────── */

test('frame: an overfull topbar grows rather than spilling over the page', function () {
  var bar  = overfullBar('320px');
  var box  = bar.getBoundingClientRect();
  var kids = bar.querySelectorAll('.cluster > *');

  assert.ok(kids.length === 4, 'fixture should have four items, got ' + kids.length);

  for (var i = 0; i < kids.length; i++) {
    var r = kids[i].getBoundingClientRect();
    assert.ok(
      r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5,
      'item ' + i + ' (' + kids[i].textContent.trim().slice(0, 20) + ') is outside the bar — ' +
      'bar ' + Math.round(box.top) + '–' + Math.round(box.bottom) + ', ' +
      'item ' + Math.round(r.top) + '–' + Math.round(r.bottom)
    );
  }

  cleanup();
});

test('frame: --topbar-height is a floor, so a bar that fits keeps it', function () {
  /*
   * The other half of the same change. Making the height a minimum must not
   * make every ordinary topbar taller: box-sizing is border-box package-wide,
   * so the padding that gives a wrapped row breathing room sits inside the
   * floor rather than adding to it.
   */
  var bar = el(
    '<div class="shell" style="inline-size:1200px">' +
      '<header class="topbar"><div class="cluster"><span>x</span></div></header>' +
    '</div>',
    '.topbar'
  );

  var want = parseFloat(style(bar, '--topbar-height')) * 16;
  var got  = bar.getBoundingClientRect().height;

  assert.ok(Math.abs(got - want) < 1.5,
    'a topbar that fits should be --topbar-height (' + want + 'px), got ' + got + 'px');

  cleanup();
});

test('frame: and it is still a floor, not a ceiling', function () {
  var narrow = overfullBar('320px').getBoundingClientRect().height;
  var floor  = parseFloat(style(document.body, '--topbar-height')) * 16;

  assert.ok(narrow > floor,
    'an overfull bar should be taller than the floor — floor ' + floor + 'px, got ' + narrow + 'px');

  cleanup();
});

/* ── A button and a control on one row ────────────────────────────── */

test('controls: a .btn and a .field on one row are the same height', function () {
  /*
   * Measured, not declared. The two rules had the same font-size, the same
   * line-height and the same border and DIFFERENT vertical padding — a button
   * at --space-xs, a control at --space-sm — so nothing about either rule read
   * as wrong on its own. In basecamp's filter bar that was three controls at
   * 38px and a submit at 34px, and .cluster centers, so the button sat 2px
   * below the row it belonged to (`FJS-347`).
   */
  var row = el(
    '<div class="cluster">' +
      '<input class="field" style="--field-inline-size:auto">' +
      '<select class="field" style="--field-inline-size:auto"><option>a</option></select>' +
      '<button class="btn">Search</button>' +
    '</div>'
  );

  var input  = row.querySelector('input.field').getBoundingClientRect();
  var select = row.querySelector('select.field').getBoundingClientRect();
  var button = row.querySelector('button.btn').getBoundingClientRect();

  assert.ok(Math.abs(button.height - input.height) < 1,
    'a .btn and an <input class="field"> should be one height — ' +
    'input ' + input.height + 'px, button ' + button.height + 'px');
  assert.ok(Math.abs(button.height - select.height) < 1,
    'and a <select class="field"> too — ' +
    'select ' + select.height + 'px, button ' + button.height + 'px');

  cleanup();
});

test('controls: and .cluster therefore lines their edges up', function () {
  /*
   * The height is the cause; this is the thing anybody actually sees. Equal
   * heights inside a centering row means equal tops and equal bottoms.
   */
  var row = el(
    '<div class="cluster">' +
      '<input class="field" style="--field-inline-size:auto">' +
      '<button class="btn">Search</button>' +
    '</div>'
  );

  var a = row.querySelector('.field').getBoundingClientRect();
  var b = row.querySelector('.btn').getBoundingClientRect();

  assert.ok(Math.abs(a.top - b.top) < 1,
    'tops disagree by ' + Math.abs(a.top - b.top).toFixed(1) + 'px');
  assert.ok(Math.abs(a.bottom - b.bottom) < 1,
    'bottoms disagree by ' + Math.abs(a.bottom - b.bottom).toFixed(1) + 'px');

  cleanup();
});

test('controls: one token moves both, so they cannot drift apart again', function () {
  /*
   * The point of a shared token rather than two rules that happen to agree:
   * an app retuning control height retunes both, and nothing can move one.
   */
  var row = el(
    '<div class="cluster" style="--control-padding-block: 1rem">' +
      '<input class="field" style="--field-inline-size:auto">' +
      '<button class="btn">Search</button>' +
    '</div>'
  );

  var a = row.querySelector('.field').getBoundingClientRect();
  var b = row.querySelector('.btn').getBoundingClientRect();

  assert.ok(Math.abs(a.height - b.height) < 1,
    'retuned, they still agree — field ' + a.height + 'px, button ' + b.height + 'px');
  assert.ok(a.height > 48,
    'and the retune actually moved them — got ' + a.height + 'px');

  cleanup();
});

/* ── The rail ─────────────────────────────────────────────────────── */

/*
 * A rail in a sidebar-first Shell, transitions off so a read straight after
 * focus() sees the end state rather than the first frame of the move. A
 * peeking one is opened by focus, because :hover cannot be driven from a
 * page; the two states share every declaration. :focus-visible matches a
 * programmatic focus() here — see focus.spec.js.
 */
function rail(extra) {
  var shell = el(
    '<div class="shell sidebar-first" style="inline-size:1000px">' +
      '<style>.t-rail, .t-rail * { transition: none !important; }</style>' +
      '<header class="topbar">Leads</header>' +
      '<nav class="sidebar rail t-rail' + (extra ? ' ' + extra : '') + '" aria-label="Main">' +
        '<div class="navlist-label">Workspace</div>' +
        '<ul class="navlist">' +
          '<li><a class="navlink" href="#a"><span class="icon" aria-hidden="true"></span>' +
            '<span class="navlink-text">Leads and their long label</span></a></li>' +
          '<li><a class="navlink" href="#b"><span class="icon" aria-hidden="true"></span>' +
            '<span class="navlink-text">Jobs</span></a></li>' +
        '</ul>' +
      '</nav>' +
      '<main class="screen">The page.</main>' +
    '</div>'
  );
  return {
    shell:  shell,
    rail:   shell.querySelector('.rail'),
    screen: shell.querySelector('.screen'),
    link:   shell.querySelector('.navlink'),
    icon:   shell.querySelector('.icon'),
    text:   shell.querySelector('.navlink-text'),
    label:  shell.querySelector('.navlist-label'),
  };
}

function railPx(node, token) {
  /* The frame tokens are rem; a length on an element is how to read one in px. */
  var probe = document.createElement('div');
  probe.style.inlineSize = 'var(' + token + ')';
  node.appendChild(probe);
  var w = probe.getBoundingClientRect().width;
  probe.remove();
  return w;
}

test('frame: a closed rail is --rail-width, and the Screen starts where it ends', function () {
  var r    = rail();
  var want = railPx(r.shell, '--rail-width');
  var box  = r.rail.getBoundingClientRect();

  assert.ok(Math.abs(box.width - want) < 1,
    'a closed rail should be --rail-width (' + want + 'px), got ' + box.width + 'px');
  assert.ok(Math.abs(r.screen.getBoundingClientRect().left - box.right) < 1,
    'the Screen should start at the rail\'s edge');

  cleanup();
});

test('frame: the icon sits centred in the closed rail', function () {
  /*
   * The navlink's padding is computed from --rail-width rather than read
   * off its box, so this is the check that the calc's terms are the rail's
   * real padding and border. One term wrong and the icon is a few px off
   * centre, which nobody sees until two apps' rails sit side by side.
   */
  var r      = rail();
  var box    = r.rail.getBoundingClientRect();
  var icon   = r.icon.getBoundingClientRect();
  var inside = box.left + (box.width - parseFloat(style(r.rail, 'border-inline-end-width'))) / 2;
  var mid    = icon.left + icon.width / 2;

  assert.ok(icon.width > 0, 'the fixture icon should have a size');
  /* Chrome lays out in 1/64px, and the border term alone is half a pixel. */
  assert.ok(Math.abs(mid - inside) < 0.25,
    'icon centre ' + mid.toFixed(1) + 'px, rail centre ' + inside.toFixed(1) + 'px');

  cleanup();
});

test('frame: closed, the labels are transparent and still there', function () {
  /*
   * Opacity, not display. A navlink whose label is display:none has an
   * aria-hidden glyph for its only content and therefore no name.
   */
  var r = rail();

  assert.equal(style(r.text, 'opacity'), '0', 'a closed rail hides .navlink-text');
  assert.equal(style(r.label, 'opacity'), '0', 'and .navlist-label');
  assert.notEqual(style(r.text, 'display'), 'none', 'by opacity, never by display');
  assert.ok(r.link.textContent.indexOf('Leads') !== -1, 'the label is the link\'s text');

  cleanup();
});

test('frame: a rail without .peek stays shut with the keyboard in it', function () {
  /*
   * The control that collapses a rail usually sits inside it, so a rail
   * that opened under the focus or pointer that just collapsed it would
   * look as if the click did nothing.
   */
  var r    = rail();
  var want = railPx(r.shell, '--rail-width');

  r.link.focus();

  assert.ok(Math.abs(r.rail.getBoundingClientRect().width - want) < 1,
    'a plain rail should stay --rail-width (' + want + 'px) with focus in it, got ' +
    r.rail.getBoundingClientRect().width + 'px');
  assert.equal(style(r.text, 'opacity'), '0', 'and its labels stay faded');

  r.link.blur();
  cleanup();
});

test('frame: the Sidebar carries the width transition, so a rail moves both ways', function () {
  /*
   * A transition is read from the state being entered. Declared on .rail
   * alone, collapsing moved and expanding back to a Sidebar jumped. The
   * harness turns transitions off, so this reads the rule.
   */
  var found = allRules().filter(function (r) {
    return r.selectorText === '.sidebar' && /transition/.test(r.cssText);
  });
  assert.equal(found.length, 1, 'exactly one .sidebar rule declares a transition');
  ['inline-size', 'padding', 'margin-inline-end'].forEach(function (prop) {
    assert.ok(new RegExp('\\b' + prop + '\\s+var\\(--motion-').test(found[0].cssText),
      '.sidebar transitions ' + prop + ' on a motion token: ' + found[0].cssText);
  });
  assert.ok(!allRules().some(function (r) {
    return /\.rail/.test(r.selectorText || '') && /(^|[;{\s])transition\s*:/.test(r.cssText) &&
      !/navlink-text|navlist-label/.test(r.selectorText);
  }), 'no .rail rule redeclares the transition, which would make one direction differ');
});

test('frame: an open rail is --sidebar-width over the page, and the page does not move', function () {
  var r      = rail('peek');
  var before = r.screen.getBoundingClientRect().left;
  var iconX  = r.icon.getBoundingClientRect().left;

  r.link.focus();

  var want = railPx(r.shell, '--sidebar-width');
  var box  = r.rail.getBoundingClientRect();

  assert.ok(Math.abs(box.width - want) < 1,
    'an open rail should be --sidebar-width (' + want + 'px), got ' + box.width + 'px');
  assert.ok(Math.abs(r.screen.getBoundingClientRect().left - before) < 1,
    'the Screen moved from ' + before + 'px to ' + r.screen.getBoundingClientRect().left + 'px — ' +
    'the end margin must give back what the open width takes');
  assert.ok(Math.abs(r.icon.getBoundingClientRect().left - iconX) < 1,
    'the icon should stay where it was as the rail opens');
  assert.equal(style(r.text, 'opacity'), '1', 'and the labels show');
  assert.equal(style(r.rail, 'z-index'), style(document.documentElement, '--z-sidebar'),
    'and it sits on the --z-sidebar rung, above a sticky Topbar');

  r.link.blur();
  cleanup();
});

test('frame: a group label carrying an icon keeps it in the closed rail, centred', function () {
  /*
   * A <summary> that opens its group is a .navlist-label with a glyph, and
   * that glyph is the group's only mark while the rail is closed. Fading the
   * whole label, as a bare-text one is faded, left an invisible control.
   */
  var nav = el(
    '<div class="shell sidebar-first" style="inline-size:1000px">' +
      '<nav class="sidebar rail" aria-label="Main" style="transition:none">' +
        '<details open><summary class="navlist-label" style="display:flex;gap:var(--space-sm)">' +
          '<span class="icon" aria-hidden="true"></span><span class="navlink-text">Fleet</span>' +
        '</summary></details>' +
      '</nav>' +
      '<main class="screen">The page.</main>' +
    '</div>',
    '.rail'
  );
  var label = nav.querySelector('.navlist-label');
  var box   = nav.getBoundingClientRect();
  var icon  = nav.querySelector('.icon').getBoundingClientRect();
  var mid   = box.left + (box.width - parseFloat(style(nav, 'border-inline-end-width'))) / 2;

  assert.equal(style(label, 'opacity'), '1', 'the label itself stays opaque');
  assert.equal(style(nav.querySelector('.navlink-text'), 'opacity'), '0', 'and its words fade');
  assert.ok(Math.abs(icon.left + icon.width / 2 - mid) < 0.25,
    'its icon sits where a navlink\'s does — off by ' + Math.abs(icon.left + icon.width / 2 - mid).toFixed(2) + 'px');

  cleanup();
});

test('frame: with no hover, a rail gets the drawer toggle above md and a sidebar does not', function () {
  /*
   * Nothing on a touch screen opens a rail: no pointer hovers it and a tap
   * is not :focus-visible, so the drawer is the only place its names are
   * written out. Headless Chrome answers (hover: none), so this page is
   * that screen.
   */
  assert.ok(matchMedia('(hover: none) and (min-width: 768px)').matches,
    'this page should be a no-hover screen above md, or the test measures nothing');
  function toggleIn(sidebarClass) {
    return el(
      '<div class="shell sidebar-first">' +
        '<header class="topbar"><button class="btn sidebar-toggle" aria-label="Open navigation">=</button></header>' +
        '<nav class="' + sidebarClass + '" aria-label="Main"></nav>' +
      '</div>',
      '.sidebar-toggle'
    );
  }

  assert.notEqual(style(toggleIn('sidebar rail'), 'display'), 'none', 'beside a rail the toggle is drawn');
  cleanup();
  assert.equal(style(toggleIn('sidebar'), 'display'), 'none', 'beside a sidebar, which shows every name, it is not');
  cleanup();
});

/* ── The sidebar foot ─────────────────────────────────────────────── */

/*
 * A full-height Sidebar whose Screen is taller than its nav, with a foot
 * after the links. Measured from the foot's bottom edge to the Sidebar's
 * content box, since the Sidebar's padding is what a foot sits inside.
 */
function footedSidebar(sidebarClass, footed) {
  var shell = el(
    '<div class="shell sidebar-first" style="inline-size:1000px;min-block-size:600px">' +
      '<style>.t-foot, .t-foot * { transition: none !important; }</style>' +
      '<header class="topbar">Leads</header>' +
      '<nav class="' + sidebarClass + ' t-foot" aria-label="Main">' +
        '<ul class="navlist"><li><a class="navlink" href="#a"><span class="navlink-text">Leads</span></a></li></ul>' +
        (footed ? '<div class="sidebar-footer"><span class="navlink-text">Sam, signed in</span></div>' : '') +
      '</nav>' +
      '<main class="screen" style="min-block-size:500px">The page.</main>' +
    '</div>'
  );
  return {
    sidebar: shell.querySelector('.sidebar'),
    list:    shell.querySelector('.navlist'),
    foot:    shell.querySelector('.sidebar-footer'),
  };
}

function footGap(f) {
  var pad = parseFloat(style(f.sidebar, 'padding-bottom'));
  return f.sidebar.getBoundingClientRect().bottom - pad - f.foot.getBoundingClientRect().bottom;
}

test('frame: a sidebar-footer sits at the bottom of a full-height sidebar', function () {
  var f = footedSidebar('sidebar', true);

  assert.ok(Math.abs(footGap(f)) < 1,
    'the foot should end at the Sidebar\'s content edge, got ' + footGap(f) + 'px short');
  assert.ok(f.foot.getBoundingClientRect().top > f.list.getBoundingClientRect().bottom + 100,
    'and the links stay at the top, with the gap between them');

  cleanup();
});

test('frame: and so does it in a rail, closed or open', function () {
  var f = footedSidebar('sidebar rail', true);

  assert.ok(Math.abs(footGap(f)) < 1, 'closed, the foot should be at the bottom, got ' + footGap(f) + 'px short');
  f.list.querySelector('.navlink').focus();
  assert.ok(Math.abs(footGap(f)) < 1, 'open, the foot should be at the bottom, got ' + footGap(f) + 'px short');

  f.list.querySelector('.navlink').blur();
  cleanup();
});

test('frame: a sidebar with no foot lays out as it always did', function () {
  var f = footedSidebar('sidebar', false);

  assert.equal(style(f.sidebar, 'display'), 'block', 'no foot, no flex column');
  assert.ok(f.list.getBoundingClientRect().top < f.sidebar.getBoundingClientRect().top + 100,
    'and the links stay at the top');

  cleanup();
});
