
import * as $runtime from '../src/runtime.js';
import L from './SlotLayout.mjs';
import Page from './Page.mjs';
var $tpl0 = $runtime.template(`<>`, 1);
export default function E4(__anchor, __props, __block) {
  $runtime.push_component();
  const $option = { props: __props };
  const $slots = $runtime.makeSlots(__block);
  const $onMount   = $runtime.$onMount;
  const $onDestroy = $runtime.$onDestroy;
  const $onCleanup = $runtime.$onCleanup;
  {
    const $parentElement = $tpl0();
    var el1 = $runtime.child($parentElement, true);
    const $$snippet_s = (__anchor) => {
      const $$frag = ($runtime.makeBlock($tpl0, ($parentElement) => {
        var el0 = $runtime.child($parentElement, true);
        Page(el0, {}, null);
      })
      )();
      __anchor.before($$frag.$dom ?? $$frag);
    };
    L(el1, {children: $$snippet_s}, null);
    $runtime.registerComponentAnchor(el1);
    $runtime.createEffect(() => { $runtime.pushProps(el1, {children: $$snippet_s}); });
    $runtime.append(__anchor, $parentElement);
  }
  $runtime.pop_component();
}