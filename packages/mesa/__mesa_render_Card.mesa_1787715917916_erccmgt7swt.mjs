
import * as $$runtime from '@frontierjs/mesa/runtime.js';
var $$tpl0 = $$runtime.template(`<tr><td><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><><tr><td><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tbody></tbody></table></td></tr></table></td></tr>`, 0);
var $$tpl1 = $$runtime.template(`
      
      <tr>
        <td> </td>
      </tr>
      `, 0);
export default function Card(__anchor, __props, __block) {
  $$runtime.push_component();
  const $$option = { props: __props };
  const $$slots = $$runtime.makeSlots(__block);
  const $$sig_heading = $$runtime.track($$option.props?.heading !== undefined ? $$option.props.heading : '', void 0, void 0, __block);
  const $$set_heading = (v) => $$runtime.set($$sig_heading, v);
  $$runtime.makeExternalProperty('heading', $$sig_heading, $$set_heading);
  const $$sig_headingColor = $$runtime.track($$option.props?.headingColor !== undefined ? $$option.props.headingColor : '#38993a', void 0, void 0, __block);
  const $$set_headingColor = (v) => $$runtime.set($$sig_headingColor, v);
  $$runtime.makeExternalProperty('headingColor', $$sig_headingColor, $$set_headingColor);
  const $$sig_headingSize = $$runtime.track($$option.props?.headingSize !== undefined ? $$option.props.headingSize : 18, void 0, void 0, __block);
  const $$set_headingSize = (v) => $$runtime.set($$sig_headingSize, v);
  $$runtime.makeExternalProperty('headingSize', $$sig_headingSize, $$set_headingSize);
  const $$sig_bgcolor = $$runtime.track($$option.props?.bgcolor !== undefined ? $$option.props.bgcolor : '#ffffff', void 0, void 0, __block);
  const $$set_bgcolor = (v) => $$runtime.set($$sig_bgcolor, v);
  $$runtime.makeExternalProperty('bgcolor', $$sig_bgcolor, $$set_bgcolor);
  const $$sig_border = $$runtime.track($$option.props?.border !== undefined ? $$option.props.border : '#eeeeee', void 0, void 0, __block);
  const $$set_border = (v) => $$runtime.set($$sig_border, v);
  $$runtime.makeExternalProperty('border', $$sig_border, $$set_border);
  const $$sig_borderWidth = $$runtime.track($$option.props?.borderWidth !== undefined ? $$option.props.borderWidth : 2, void 0, void 0, __block);
  const $$set_borderWidth = (v) => $$runtime.set($$sig_borderWidth, v);
  $$runtime.makeExternalProperty('borderWidth', $$sig_borderWidth, $$set_borderWidth);
  const $$sig_radius = $$runtime.track($$option.props?.radius !== undefined ? $$option.props.radius : 8, void 0, void 0, __block);
  const $$set_radius = (v) => $$runtime.set($$sig_radius, v);
  $$runtime.makeExternalProperty('radius', $$sig_radius, $$set_radius);
  const $$sig_padding = $$runtime.track($$option.props?.padding !== undefined ? $$option.props.padding : 16, void 0, void 0, __block);
  const $$set_padding = (v) => $$runtime.set($$sig_padding, v);
  $$runtime.makeExternalProperty('padding', $$sig_padding, $$set_padding);
  const $$onMount   = $$runtime.onMount;
  const $$onDestroy = $$runtime.onDestroy;
  const $$onCleanup = $$runtime.onCleanup;
  {
    const $$parentElement = $$tpl0();
    var el0 = $$runtime.child($$parentElement, true);
    var el1 = $$runtime.child(el0, true);
    var $$_skip0 = $$runtime.child(el1);
    var el4 = $$runtime.sibling($$_skip0);
    var $$t0 = $$runtime.child(el4);
    var $$t1 = $$runtime.child($$t0);
    var el5 = $$runtime.child($$t1, true);
    $$runtime.render((__prev) => {
      var __a = `padding:${$$runtime.get($$sig_padding)}px;`;
      if (__prev.a !== __a) $$runtime.set_attribute(el0, 'style', __prev.a = __a);
    }, { a: null });
    $$runtime.bindAttribute(el1, 'style', () => (`
        border-collapse:collapse;
        border-radius:${$$runtime.get($$sig_radius)}px;
        border:${$$runtime.get($$sig_borderWidth)}px solid ${$$runtime.get($$sig_border)};
        background-color:${$$runtime.get($$sig_bgcolor)};
        overflow:hidden;
      `));
    $$runtime.ifBlock(el4, () => ($$runtime.get($$sig_heading)) ? 0 : null, [$$runtime.makeBlock($$tpl1, ($$parentElement) => {
        var $$_skip0 = $$runtime.child($$parentElement);
        var $$t0 = $$runtime.sibling($$_skip0);
        var $$_skip1 = $$runtime.child($$t0);
        var el2 = $$runtime.sibling($$_skip1);
        var el3 = $$runtime.child(el2, true);
        $$runtime.bindAttribute(el2, 'style', () => (`
          padding:10px 16px;
          font-family:Helvetica,Arial,sans-serif;
          font-size:${$$runtime.get($$sig_headingSize)}px;
          font-weight:800;
          color:${$$runtime.get($$sig_headingColor)};
          border-bottom:${$$runtime.get($$sig_borderWidth)}px solid ${$$runtime.get($$sig_border)};
          border-radius:${$$runtime.get($$sig_radius)}px ${$$runtime.get($$sig_radius)}px 0 0;
        `));
        $$runtime.bindText(el3, () => (`
          ${$$runtime.get($$sig_heading)}
        `));
      })]
    );
    $$runtime.addBlock(el5, $$runtime.attachNamedSlot(__block, 'default', null));
    $$runtime.append(__anchor, $$parentElement);
  }
  $$runtime.pop_component();
}