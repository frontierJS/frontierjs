
import * as $$runtime from '@frontierjs/mesa/runtime.js';
var $$tpl0 = $$runtime.template(`<tr><td colspan="2"><table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="border-collapse:collapse;"><tr><td>&nbsp;</td></tr></table></td></tr>`, 0);
export default function Divider(__anchor, __props, __block) {
  $$runtime.push_component();
  const $$option = { props: __props };
  const $$slots = $$runtime.makeSlots(__block);
  const $$sig_color = $$runtime.track($$option.props?.color !== undefined ? $$option.props.color : '#eeeeee', void 0, void 0, __block);
  const $$set_color = (v) => $$runtime.set($$sig_color, v);
  $$runtime.makeExternalProperty('color', $$sig_color, $$set_color);
  const $$sig_height = $$runtime.track($$option.props?.height !== undefined ? $$option.props.height : 1, void 0, void 0, __block);
  const $$set_height = (v) => $$runtime.set($$sig_height, v);
  $$runtime.makeExternalProperty('height', $$sig_height, $$set_height);
  const $$sig_margin = $$runtime.track($$option.props?.margin !== undefined ? $$option.props.margin : 8, void 0, void 0, __block);
  const $$set_margin = (v) => $$runtime.set($$sig_margin, v);
  $$runtime.makeExternalProperty('margin', $$sig_margin, $$set_margin);
  const $$sig_width = $$runtime.track($$option.props?.width !== undefined ? $$option.props.width : '90%', void 0, void 0, __block);
  const $$set_width = (v) => $$runtime.set($$sig_width, v);
  $$runtime.makeExternalProperty('width', $$sig_width, $$set_width);
  const $$onMount   = $$runtime.onMount;
  const $$onDestroy = $$runtime.onDestroy;
  const $$onCleanup = $$runtime.onCleanup;
  {
    const $$parentElement = $$tpl0();
    var el0 = $$runtime.child($$parentElement, true);
    var el1 = $$runtime.child(el0, true);
    var $$t0 = $$runtime.child(el1);
    var el2 = $$runtime.child($$t0, true);
    $$runtime.render((__prev) => {
      var __a = `padding:${$$runtime.get($$sig_margin)}px 0;font-size:0;line-height:0;`;
      if (__prev.a !== __a) $$runtime.set_attribute(el0, 'style', __prev.a = __a);
      var __b = `${$$runtime.get($$sig_width)}`;
      if (__prev.b !== __b) $$runtime.set_attribute(el1, 'width', __prev.b = __b);
    }, { a: null, b: null });
    $$runtime.bindAttribute(el2, 'style', () => (`
          background-color:${$$runtime.get($$sig_color)};
          height:${$$runtime.get($$sig_height)}px;
          font-size:0;
          line-height:0;
        `));
    $$runtime.append(__anchor, $$parentElement);
  }
  $$runtime.pop_component();
}