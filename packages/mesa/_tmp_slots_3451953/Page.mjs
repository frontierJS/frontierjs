
import * as $runtime from '../src/runtime.js';
var $tpl0 = $runtime.template(`<h1>page</h1>`, 0);
export default function Page(__anchor, __props, __block) {
  $runtime.push_component();
  const $option = { props: __props };
  const $slots = $runtime.makeSlots(__block);
  const $onMount   = $runtime.$onMount;
  const $onDestroy = $runtime.$onDestroy;
  const $onCleanup = $runtime.$onCleanup;
  {
    const $parentElement = $tpl0();
    $runtime.append(__anchor, $parentElement);
  }
  $runtime.pop_component();
}