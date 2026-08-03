/*
 * harness.js — the in-page assertion library.
 *
 * This file is inlined into the generated test page as a classic <script>,
 * not loaded as a module: file:// module resolution is subject to CORS and
 * this keeps the harness dependency-free. Everything below lands on the
 * global scope, which is what the spec files call.
 *
 * ── Why this exists ────────────────────────────────────────────────────
 *
 * The v0.6 cycle verified its invariants with throwaway HTML files that were
 * deleted afterwards, so every claim in PROJECT_STATE.md had to be re-derived
 * by hand. Worse, roughly a third of the failures that cycle were bugs in the
 * assertions rather than in the CSS. Both problems are addressed here: the
 * harness is checked in, and meta.spec.js tests the harness itself.
 *
 * ── Reading computed styles honestly ──────────────────────────────────
 *
 * The traps that produced false failures in v0.6, and what is done about
 * them:
 *
 *   - color-mix() computes to `color(xyz-d65 …)`, not `rgb()`. Comparing
 *     the string against "rgb(…)" fails even when the pixels match, so
 *     every color goes through toRGB() before comparison.
 *   - `inline-flex` blockifies to `flex` on a flex/grid item, so asserting
 *     the authored value fails. Assert what the box actually does.
 *   - `margin: auto` reports a used pixel value, not "auto".
 *   - Every CSSStyleRule has a truthy but empty `.cssRules`, so walking the
 *     stylesheet by duck-typing finds phantom groups. Use `.type` or
 *     `instanceof`.
 */
(function () {
  'use strict';

  var tests = [];
  var only = [];

  window.test = function (name, fn) {
    tests.push({ name: name, fn: fn, file: window.__FJS_CURRENT_SPEC__ });
  };
  window.test.only = function (name, fn) {
    only.push({ name: name, fn: fn, file: window.__FJS_CURRENT_SPEC__ });
  };

  /* ── Mounting ──────────────────────────────────────────────────────
   *
   * Nodes go into a real, visible container. Not `display:none`, not
   * `visibility:hidden` — a hidden subtree still computes styles, but it
   * does not lay out, so anything reading geometry silently reads zero.
   * The container is parked off-screen instead.
   */
  var root = null;
  function container() {
    if (!root) {
      root = document.createElement('div');
      root.id = 'fjs-test-root';
      root.style.cssText = 'position:absolute;inset-inline-start:-10000px;inline-size:1200px';
      document.body.appendChild(root);
    }
    return root;
  }

  /*
   * el(html) mounts a fragment and returns its first element child.
   * el(html, selector) returns the first match inside it instead.
   */
  window.el = function (html, selector) {
    var host = document.createElement('div');
    host.innerHTML = html.trim();
    var node = host.firstElementChild;
    container().appendChild(node);
    return selector ? node.querySelector(selector) : node;
  };

  /* Mount into a themed wrapper. Themes are a class on an ancestor. */
  window.themed = function (themeName, html, selector) {
    var wrap = document.createElement('div');
    wrap.className = 'theme-' + themeName;
    wrap.innerHTML = html.trim();
    container().appendChild(wrap);
    var node = wrap.firstElementChild;
    return selector ? node.querySelector(selector) : node;
  };

  window.cleanup = function () {
    if (root) root.innerHTML = '';
  };

  /* ── Reading style ─────────────────────────────────────────────────*/

  window.style = function (node, prop) {
    return getComputedStyle(node).getPropertyValue(prop).trim();
  };

  /*
   * Custom properties are only readable this way when they are *set*.
   * A guaranteed-invalid property reads as "", which is how the tone
   * fallbacks are supposed to behave — so "" is a meaningful result here,
   * not a failure to read.
   */
  window.prop = function (node, name) {
    return getComputedStyle(node).getPropertyValue(name).trim();
  };

  /*
   * Normalise any CSS color — rgb(), color(xyz-d65 …), oklch(), color-mix()
   * output, a named color — to [r, g, b, a] with r/g/b as 0–255 sRGB bytes.
   *
   * It paints one pixel and reads it back, because that is the only step
   * that performs a real conversion. Canvas `fillStyle` looks like it
   * normalises — it does turn "red" into "#ff0000" — but it passes every
   * modern color syntax straight through:
   *
   *   fillStyle = 'color(xyz-d65 0.17 0.17 0.59)'  →  same string back
   *   fillStyle = 'oklch(0.7 0.1 200)'             →  same string back
   *
   * Parsing that string by hand would mean reimplementing the color spaces.
   * getImageData on an sRGB-backed canvas has the browser do it instead.
   *
   * Parse failures are the other trap: an unparseable value leaves
   * fillStyle at its previous value, so a typo silently returns whatever
   * was measured last. Two different sentinels turn that into a throw —
   * one sentinel is not enough, because a value that legitimately resolves
   * to the sentinel color would be indistinguishable from a failure.
   */
  var ctx = null;
  var SENTINEL_A = '#010203';
  var SENTINEL_B = '#040506';

  window.toRGB = function (value) {
    if (!ctx) {
      var canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    }
    if (value === 'transparent' || value === 'rgba(0, 0, 0, 0)') return [0, 0, 0, 0];

    ctx.fillStyle = SENTINEL_A;
    ctx.fillStyle = value;
    if (ctx.fillStyle === SENTINEL_A) {
      ctx.fillStyle = SENTINEL_B;
      ctx.fillStyle = value;
      if (ctx.fillStyle === SENTINEL_B) {
        throw new Error('toRGB: browser refused to parse ' + JSON.stringify(value));
      }
    }

    /* `copy` so the pixel is replaced rather than composited over what is
       already there — otherwise a translucent color reads as blended. */
    var prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'copy';
    ctx.fillRect(0, 0, 1, 1);
    ctx.globalCompositeOperation = prev;

    var d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };

  /* WCAG 2.x relative luminance + contrast ratio. */
  function luminance(rgb) {
    var c = rgb.slice(0, 3).map(function (v) {
      var s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  window.contrast = function (fg, bg) {
    var a = luminance(toRGB(fg));
    var b = luminance(toRGB(bg));
    var hi = Math.max(a, b);
    var lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  };

  /*
   * Does this element paint a focus indicator a sighted user can see?
   *
   * Deliberately medium-agnostic: it accepts an outline OR a non-inset
   * box-shadow ring, because the point of the focus tests is "is there a
   * ring", not "is it drawn with property X". The unification tests assert
   * the property separately.
   */
  window.hasVisibleRing = function (node) {
    var cs = getComputedStyle(node);
    var outlineW = parseFloat(cs.outlineWidth) || 0;
    var hasOutline = outlineW > 0 && cs.outlineStyle !== 'none' &&
      toRGB(cs.outlineColor)[3] > 0;
    var shadow = cs.boxShadow;
    var hasShadow = shadow && shadow !== 'none' && !/rgba\(0, 0, 0, 0\)/.test(shadow);
    return hasOutline || hasShadow;
  };

  /* ── Stylesheet introspection ──────────────────────────────────────*/

  /*
   * Flatten every rule reachable from the document's sheets, descending
   * into @layer / @media / @supports groups.
   *
   * `rule.cssRules` is truthy-but-empty on a plain CSSStyleRule, so
   * duck-typing on it walks phantom groups. Grouping rules are identified
   * by constructor instead.
   */
  window.allRules = function () {
    var out = [];
    function walk(list) {
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        out.push(r);
        var isGroup =
          (window.CSSLayerBlockRule && r instanceof CSSLayerBlockRule) ||
          (window.CSSMediaRule && r instanceof CSSMediaRule) ||
          (window.CSSSupportsRule && r instanceof CSSSupportsRule) ||
          (window.CSSContainerRule && r instanceof CSSContainerRule);
        if (isGroup && r.cssRules) walk(r.cssRules);
        if (r.styleSheet && r.styleSheet.cssRules) walk(r.styleSheet.cssRules);
      }
    }
    for (var s = 0; s < document.styleSheets.length; s++) {
      try {
        walk(document.styleSheets[s].cssRules);
      } catch (e) {
        throw new Error('stylesheet ' + s + ' unreadable: ' + e.message);
      }
    }
    return out;
  };

  /* ── Assertions ────────────────────────────────────────────────────*/

  function fail(msg, actual, expected) {
    var e = new Error(
      msg + '\n      expected: ' + JSON.stringify(expected) +
      '\n      actual:   ' + JSON.stringify(actual)
    );
    e.isAssertion = true;
    throw e;
  }

  window.assert = {
    ok: function (v, msg) {
      if (!v) fail(msg || 'expected truthy', v, 'truthy');
    },
    notOk: function (v, msg) {
      if (v) fail(msg || 'expected falsy', v, 'falsy');
    },
    equal: function (a, b, msg) {
      if (a !== b) fail(msg || 'values differ', a, b);
    },
    notEqual: function (a, b, msg) {
      if (a === b) fail(msg || 'values should differ', a, 'not ' + b);
    },
    /* Colors compare by resolved sRGB, never by string. */
    sameColor: function (a, b, msg) {
      var ra = toRGB(a), rb = toRGB(b);
      var close = [0, 1, 2].every(function (i) { return Math.abs(ra[i] - rb[i]) <= 1; }) &&
        Math.abs(ra[3] - rb[3]) < 0.01;
      if (!close) fail(msg || 'colors differ', a + ' → ' + ra, b + ' → ' + rb);
    },
    differentColor: function (a, b, msg) {
      var ra = toRGB(a), rb = toRGB(b);
      var close = [0, 1, 2].every(function (i) { return Math.abs(ra[i] - rb[i]) <= 1; }) &&
        Math.abs(ra[3] - rb[3]) < 0.01;
      if (close) fail(msg || 'colors should differ', a + ' → ' + ra, 'not ' + b);
    },
    atLeast: function (a, b, msg) {
      if (!(a >= b)) fail(msg || 'value too low', a, '>= ' + b);
    },
    /* Asserts fn() throws an assertion — used by meta.spec.js. */
    throws: function (fn, msg) {
      var threw = false;
      try { fn(); } catch (e) { threw = true; }
      if (!threw) fail(msg || 'expected a throw', 'no throw', 'throw');
    },
  };

  /* ── Runner ────────────────────────────────────────────────────────*/

  window.__FJS_RUN__ = function () {
    var queue = only.length ? only : tests;
    var results = [];
    for (var i = 0; i < queue.length; i++) {
      var t = queue[i];
      var entry = { file: t.file, name: t.name, ok: true, error: null };
      try {
        t.fn();
      } catch (e) {
        entry.ok = false;
        entry.error = e && e.message ? e.message : String(e);
        if (e && !e.isAssertion && e.stack) entry.error += '\n      (threw: ' + e.stack.split('\n')[0] + ')';
      }
      cleanup();
      results.push(entry);
    }
    return { results: results, filtered: only.length > 0 };
  };
})();
