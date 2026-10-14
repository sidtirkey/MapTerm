// Links between devices: drawing one from a device's menu, and the interface-name form.
import { ask } from './dialog.js';
import { cy, setMode, realNodes, uid, save } from './map.js';

// Drawing a link: a dashed line follows the pointer from the source device until
// the pointer is released over another device (click or drag both work).
let draw = null;

function nodeAt(p) {
  return realNodes().filter((n) => {
    const b = n.boundingBox({ includeLabels: false });
    return p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2;
  }).last();
}

export function startLinkDraw(src, pos) {
  setMode('link');
  const tip = cy.add({ group: 'nodes', classes: 'ghost', data: { id: '__tip' }, position: { ...pos } });
  cy.add({ group: 'edges', classes: 'ghost', data: { id: '__line', source: src.id(), target: tip.id() } });
  draw = { src, tip };
  src.addClass('pick');
  cy.autoungrabify(true); cy.userPanningEnabled(false); cy.boxSelectionEnabled(false);
}

export function endLinkDraw() {
  if (!draw) return;
  cy.remove('.ghost'); cy.nodes().removeClass('pick');
  cy.autoungrabify(false); cy.userPanningEnabled(true); cy.boxSelectionEnabled(true);
  draw = null;
}

// Name of the interface a link uses on the given end node.
const ifOn = (e, node) => (e.data('source') === node.id() ? e.data('srcIf') : e.data('dstIf')) || '';
function ifInUse(node, name, skip) {
  if (!name) return false;
  return node.connectedEdges().some((e) => e !== skip && ifOn(e, node).toLowerCase() === name.toLowerCase());
}

// Asks for the interface on each end; an interface can only be used once per device.
export async function askLink(src, dst, edge) {
  let v = { srcIf: edge?.data('srcIf') || '', dstIf: edge?.data('dstIf') || '' }, title = edge ? 'Edit link' : 'New link';
  for (;;) {
    v = await ask(title, [
      { key: 'srcIf', label: `${src.data('name')} interface`, value: v.srcIf, placeholder: 'e.g. Gi0/1' },
      { key: 'dstIf', label: `${dst.data('name')} interface`, value: v.dstIf, placeholder: 'e.g. Gi0/1' },
    ], edge ? 'Save' : 'Add link');
    if (!v) return null;
    v.srcIf = v.srcIf.trim(); v.dstIf = v.dstIf.trim();
    const clash = ifInUse(src, v.srcIf, edge) ? [src, v.srcIf] : ifInUse(dst, v.dstIf, edge) ? [dst, v.dstIf] : null;
    if (!clash) return v;
    title = `${clash[1]} is already used on ${clash[0].data('name')}`;
  }
}

export function initLinks() {
  cy.on('mousemove tapdrag', (evt) => {
    if (!draw) return;
    draw.tip.position(evt.position);
    const over = nodeAt(evt.position);
    cy.nodes().not(draw.src).removeClass('pick');
    if (over.length && over.id() !== draw.src.id()) over.addClass('pick');
  });
  cy.on('tapend', (evt) => {
    if (!draw) return;
    const src = draw.src, dst = nodeAt(evt.position);
    if (dst.length && dst.id() === src.id()) return; // released on the source: keep drawing
    // Defer so the tap that follows this tapend still sees link mode and is ignored.
    setTimeout(async () => {
      setMode('select');
      if (!dst.length) return;
      const v = await askLink(src, dst);
      if (v) { cy.add({ group: 'edges', data: { id: uid(), source: src.id(), target: dst.id(), ...v } }); save(); }
    });
  });
}
