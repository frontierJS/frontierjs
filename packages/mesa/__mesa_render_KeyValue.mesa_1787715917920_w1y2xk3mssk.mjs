
import * as $$runtime from '@frontierjs/mesa/runtime.js';
var $$tpl0 = $$runtime.template(`<tr><td><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr><td> </td><td><><></td></tr></table></td></tr>`, 0);
var $$tpl1 = $$runtime.template(`
            
          `, 1);
const $$shared = {
  transition: $$runtime.transition, entrance: $$runtime.entrance,
  fade: $$runtime.fade, slide: $$runtime.slide, fly: $$runtime.fly,
  onMount: $$runtime.onMount, onDestroy: $$runtime.onDestroy,
  onCleanup: $$runtime.onCleanup, tick: $$runtime.tick,
};
export default function KeyValue(__anchor, __props, __block) {
  $$runtime.push_component();
  const $$option = { props: __props };
  const $$slots = $$runtime.makeSlots(__block);
  const $$sig_label = $$runtime.track($$option.props?.label !== undefined ? $$option.props.label : '', void 0, void 0, __block);
  const $$set_label = (v) => $$runtime.set($$sig_label, v);
  $$runtime.makeExternalProperty('label', $$sig_label, $$set_label);
  const $$sig_value = $$runtime.track($$option.props?.value !== undefined ? $$option.props.value : '', void 0, void 0, __block);
  const $$set_value = (v) => $$runtime.set($$sig_value, v);
  $$runtime.makeExternalProperty('value', $$sig_value, $$set_value);
  const $$sig_labelColor = $$runtime.track($$option.props?.labelColor !== undefined ? $$option.props.labelColor : '#888888', void 0, void 0, __block);
  const $$set_labelColor = (v) => $$runtime.set($$sig_labelColor, v);
  $$runtime.makeExternalProperty('labelColor', $$sig_labelColor, $$set_labelColor);
  const $$sig_valueColor = $$runtime.track($$option.props?.valueColor !== undefined ? $$option.props.valueColor : '#222222', void 0, void 0, __block);
  const $$set_valueColor = (v) => $$runtime.set($$sig_valueColor, v);
  $$runtime.makeExternalProperty('valueColor', $$sig_valueColor, $$set_valueColor);
  const $$sig_size = $$runtime.track($$option.props?.size !== undefined ? $$option.props.size : 14, void 0, void 0, __block);
  const $$set_size = (v) => $$runtime.set($$sig_size, v);
  $$runtime.makeExternalProperty('size', $$sig_size, $$set_size);
  const $$sig_bold = $$runtime.track($$option.props?.bold !== undefined ? $$option.props.bold : false, void 0, void 0, __block);
  const $$set_bold = (v) => $$runtime.set($$sig_bold, v);
  $$runtime.makeExternalProperty('bold', $$sig_bold, $$set_bold);
  const $$sig_padding = $$runtime.track($$option.props?.padding !== undefined ? $$option.props.padding : '6px 16px', void 0, void 0, __block);
  const $$set_padding = (v) => $$runtime.set($$sig_padding, v);
  $$runtime.makeExternalProperty('padding', $$sig_padding, $$set_padding);
  const $$sig_border = $$runtime.track($$option.props?.border !== undefined ? $$option.props.border : false, void 0, void 0, __block);
  const $$set_border = (v) => $$runtime.set($$sig_border, v);
  $$runtime.makeExternalProperty('border', $$sig_border, $$set_border);
  const $$onMount   = $$runtime.onMount;
  const $$onDestroy = $$runtime.onDestroy;
  const $$onCleanup = $$runtime.onCleanup;
  const $ = Object.create($$shared);
  $.slots = $$slots;
  const $slots = $$slots;
  {
    const $$parentElement = $$tpl0();
    var el0 = $$runtime.child($$parentElement, true);
    var $$t0 = $$runtime.child(el0);
    var $$t1 = $$runtime.child($$t0);
    var el1 = $$runtime.child($$t1, true);
    var el2 = $$runtime.child(el1, true);
    $$runtime.pop(el1);
    var el3 = $$runtime.sibling(el1);
    var $$_skip0 = $$runtime.child(el3);
    var el6 = $$runtime.sibling($$_skip0);
    $$runtime.bindAttribute(el0, 'style', () => (`
    padding:${$$runtime.get($$sig_padding)};
    font-family:Helvetica,Arial,sans-serif;
    font-size:${$$runtime.get($$sig_size)}px;
    ${$$runtime.get($$sig_border) ? 'border-bottom:1px solid #eeeeee;' : ''}
  `));
    $$runtime.bindAttribute(el1, 'style', () => (`
          color:${$$runtime.get($$sig_labelColor)};
          font-size:${$$runtime.get($$sig_size)}px;
          white-space:nowrap;
          padding-right:16px;
          vertical-align:top;
        `));
    $$runtime.render((__prev) => {
      var __a = `${$$runtime.get($$sig_label)}`;
      if (__prev.a !== __a) $$runtime.set_text(el2, __prev.a = __a);
    }, { a: ' ' });
    $$runtime.bindAttribute(el3, 'style', () => (`
          color:${$$runtime.get($$sig_bold) ? '#111111' : $$runtime.get($$sig_valueColor)};
          font-weight:${$$runtime.get($$sig_bold) ? 700 : 400};
          font-size:${$$runtime.get($$sig_size)}px;
          text-align:right;
          vertical-align:top;
        `));
    $$runtime.ifBlock(el6, () => ($slots.default) ? 0 : 1, [$$runtime.makeBlock($$tpl1, ($$parentElement) => {
        var el4 = $$runtime.child($$parentElement, true);
        $$runtime.insertBlock(el4, $$runtime.attachNamedSlot(__block, 'default', null));
      }), $$runtime.makeBlock($$runtime.createTextNode(` `), ($$parentElement) => {
        let el5 = $$parentElement;
        $$runtime.bindText(el5, () => (`
            ${$$runtime.get($$sig_value)}
          `));
      })]
    );
    $$runtime.append(__anchor, $$parentElement);
  }
  $$runtime.pop_component();
}