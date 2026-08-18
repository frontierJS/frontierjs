
import * as $runtime from '../src/runtime.js';
import L from './SlotLayout.mjs';
import Page from './Page.mjs';
var $tpl0 = $runtime.template(`<>`, 1);
export default function E1(__anchor, __props, __block) {
  $runtime.push_component();
  const $option = { props: __props };
  const $slots = $runtime.makeSlots(__block);
  const $onMount   = $runtime.$onMount;
  const $onDestroy = $runtime.$onDestroy;
  const $onCleanup = $runtime.$onCleanup;
  {
    const $parentElement = $tpl0();
    var el0 = $runtime.child($parentElement, true);
    L(el0, {}, {
      default: $runtime.makeBlock($tpl0, ($parentElement) => {
        var el1 = $runtime.child($parentElement, true);
        Page(el1, {}, null);
      })
    });
    $runtime.append(__anchor, $parentElement);
  }
  $runtime.pop_component();
}