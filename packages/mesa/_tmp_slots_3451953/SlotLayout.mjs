
import * as $runtime from '../src/runtime.js';
var $tpl0 = $runtime.template(`<div class="a mztntfp9zlo"></div>`, 0);
export default function SlotLayout(__anchor, __props, __block) {
  $runtime.push_component();
  const $option = { props: __props };
  const $slots = $runtime.makeSlots(__block);
  const $onMount   = $runtime.$onMount;
  const $onDestroy = $runtime.$onDestroy;
  const $onCleanup = $runtime.$onCleanup;
  {
    const $parentElement = $tpl0();
    let el0 = $parentElement;
    $runtime.addBlock(el0, $runtime.attachNamedSlot(__block, 'default', null));
    $runtime.append(__anchor, $parentElement);
  }
  $runtime.pop_component();
}