// Device icons for the map: Cisco-style symbols drawn as inline SVG.
const BLUE = { top: '#4a90d9', front: '#2565a8', side: '#1a4c80', line: '#0f2f52' };
const BRICK = { top: '#e07a5f', front: '#c4553a', side: '#9a3f2a', line: '#5c2416' };
const r2 = (v) => Math.round(v * 100) / 100;
function arrow(x1, y1, x2, y2, h = 5) {
  const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  const bx = x2 - ux * h, by = y2 - uy * h, w = h * 0.7;
  return `<path d="M${r2(x1)} ${r2(y1)}L${r2(bx)} ${r2(by)}" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>`
    + `<path d="M${r2(x2)} ${r2(y2)}L${r2(bx - uy * w)} ${r2(by + ux * w)}L${r2(bx + uy * w)} ${r2(by - ux * w)}Z" fill="#fff"/>`;
}
// 2.5D box: front face rect plus top and right faces offset by (dx, -dy)
function box(c, x, y, w, h, dx, dy) {
  const s = `stroke="${c.line}" stroke-width="1.5" stroke-linejoin="round"`;
  return `<path d="M${x} ${y}L${x + dx} ${y - dy}H${x + w + dx}L${x + w} ${y}Z" fill="${c.top}" ${s}/>`
    + `<path d="M${x + w} ${y}L${x + w + dx} ${y - dy}V${y + h - dy}L${x + w} ${y + h}Z" fill="${c.side}" ${s}/>`
    + `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c.front}" ${s}/>`;
}
const routerArrows = () => {
  const p = (lx, ly) => [32 + lx, 24 + ly * 0.36]; // project onto the cylinder's top ellipse
  return [[4, -4, 19, -19], [-4, 4, -19, 19], [-19, -19, -4, -4], [19, 19, 4, 4]]
    .map(([a, b, c, d]) => arrow(...p(a, b), ...p(c, d), 4.5)).join('');
};
const brickLines = () => {
  let d = 'M6 29H44M6 38H44M6 47H44';
  [[20, [19, 32]], [29, [12.5, 25.5, 38.5]], [38, [19, 32]], [47, [12.5, 25.5, 38.5]]]
    .forEach(([y, xs]) => xs.forEach((x) => { d += `M${x} ${y}V${y + 9}`; }));
  return `<path d="${d}" stroke="#f6ddd3" stroke-width="1.6"/>`;
};
const waves = () => [7, 13, 19].map((r) => {
  const k = r * Math.SQRT1_2;
  return `<path d="M${r2(32 - k)} ${r2(38 - k)}A${r} ${r} 0 0 1 ${r2(32 + k)} ${r2(38 - k)}" fill="none" stroke="${BLUE.front}" stroke-width="3" stroke-linecap="round"/>`;
}).join('');

export const DEVICE_TYPES = {
  router: { label: 'Router', svg: () => {
    const c = BLUE;
    return `<path d="M6 24v16a26 9 0 0 0 52 0V24" fill="${c.front}" stroke="${c.line}" stroke-width="1.5"/>`
      + `<ellipse cx="32" cy="24" rx="26" ry="9" fill="${c.top}" stroke="${c.line}" stroke-width="1.5"/>` + routerArrows();
  } },
  switch: { label: 'Switch', svg: () => box(BLUE, 4, 26, 44, 22, 12, 10) + arrow(9, 32, 43, 32) + arrow(43, 42, 9, 42) },
  l3switch: { label: 'Layer 3 switch', svg: () => box(BLUE, 6, 20, 38, 38, 12, 10)
    + arrow(25, 35, 25, 24) + arrow(25, 43, 25, 54) + arrow(21, 39, 10, 39) + arrow(29, 39, 40, 39) },
  firewall: { label: 'Firewall', svg: () => box(BRICK, 6, 20, 38, 36, 10, 8) + brickLines() },
  server: { label: 'Server', svg: () => box(BLUE, 16, 12, 26, 46, 8, 6)
    + [18, 24, 30].map((y) => `<rect x="20" y="${y}" width="18" height="3" rx="1" fill="#fff"/>`).join('')
    + `<circle cx="34" cy="50" r="2" fill="#fff"/>` },
  pc: { label: 'PC / workstation', svg: () => {
    const c = BLUE, s = `stroke="${c.line}" stroke-width="1.5" stroke-linejoin="round"`;
    return `<path d="M27 44h10l2 8H25z" fill="${c.side}" ${s}/><rect x="18" y="51" width="28" height="6" rx="2" fill="${c.front}" ${s}/>`
      + `<rect x="6" y="8" width="52" height="36" rx="3" fill="${c.front}" ${s}/><rect x="10" y="12" width="44" height="28" rx="1" fill="#cfe3f7"/>`;
  } },
  ap: { label: 'Wireless AP', svg: () => {
    const c = BLUE;
    return `<path d="M8 44v6a24 6 0 0 0 48 0v-6" fill="${c.front}" stroke="${c.line}" stroke-width="1.5"/>`
      + `<ellipse cx="32" cy="44" rx="24" ry="6" fill="${c.top}" stroke="${c.line}" stroke-width="1.5"/>`
      + waves() + `<circle cx="32" cy="38" r="2.5" fill="${c.front}"/>`;
  } },
  cloud: { label: 'Cloud / WAN', svg: () =>
    `<path d="M15 46A10 10 0 0 1 14 26A14 14 0 0 1 40 20A11 11 0 0 1 55 29A8 8 0 0 1 52 46Z" fill="#f4f7fb" stroke="${BLUE.front}" stroke-width="2.5" stroke-linejoin="round"/>` },
};
const iconCache = {};
export function deviceIcon(type) {
  const t = DEVICE_TYPES[type] ? type : 'router';
  return iconCache[t] ??= 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${DEVICE_TYPES[t].svg()}</svg>`);
}
