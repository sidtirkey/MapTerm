// SSH sessions: one terminal tab per device in the dock at the bottom, the tab strip
// (drag to reorder) and the dock itself (minimise, resize).
import { $, wsUrl } from './dom.js';
import { ask } from './dialog.js';
import { cy, save } from './map.js';
import { credSet } from './credentials.js';
import { note, setRec, toggleRec, isRecKey } from './recording.js';

export const sessions = new Map();
export const credCache = new Map(); // credentials typed into "SSH to …"; in memory only, cleared on reload
export let activeId = null;
let seq = 0;
const dock = $('#dock');

function refreshMap() {
  cy.nodes().removeClass('live focus');
  sessions.forEach((s) => { if (s.status === 'live') cy.getElementById(s.nodeId).addClass('live'); });
  if (activeId && sessions.has(activeId)) cy.getElementById(sessions.get(activeId).nodeId).addClass('focus');
}

export function activate(id) {
  activeId = id;
  sessions.forEach((s, k) => { s.tab.classList.toggle('active', k === id); s.pane.classList.toggle('active', k === id); });
  const s = sessions.get(id);
  if (s) { dock.classList.remove('min'); requestAnimationFrame(() => { s.fit.fit(); s.term.focus(); }); }
  refreshMap();
}

function setStatus(s, st) { s.status = st; s.tab.classList.remove('live', 'dead'); if (st !== 'connecting') s.tab.classList.add(st); refreshMap(); }

export async function connectNode(n) {
  // One session per node: reuse a live/connecting one, replace a dead one.
  const existing = [...sessions.values()].find((x) => x.nodeId === n.id());
  if (existing && existing.status !== 'dead') return activate(existing.id);
  if (existing) closeSession(existing.id);
  const d = n.data();
  if (credSet(d.credId)) return openSession(n, { credId: d.credId });
  let c = credCache.get(n.id());
  if (!c) {
    const v = await ask(`SSH to ${d.name}`, [
      { key: 'username', label: 'Username', value: d.username },
      { key: 'password', label: 'Password', type: 'password' },
      { key: 'enable', label: 'Enable password (optional)', type: 'password' },
    ], 'Connect', 'To skip this next time, give the device a credential set (Edit → Credentials).');
    if (!v || !v.username) return;
    c = v; credCache.set(n.id(), c);
    if (c.username !== d.username) { n.data('username', c.username); save(); }
  }
  openSession(n, c);
}

function openSession(n, c) {
  const d = n.data(), id = ++seq;

  const tab = document.createElement('div'); tab.className = 'tab';
  tab.dataset.id = id;
  tab.innerHTML = '<i class="dot"></i><span></span><button class="rec"></button><button class="x" title="Close session">&times;</button>';
  tab.querySelector('span').textContent = d.name;
  const pane = document.createElement('div'); pane.className = 'pane';
  $('#tabs').appendChild(tab); $('#panes').appendChild(pane);
  dock.classList.add('open'); dock.classList.remove('min');

  const term = new Terminal({ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 14, cursorBlink: true, scrollback: 5000,
    theme: { background: '#12161c', foreground: '#d7dde6', cursor: '#7aa2ff', selectionBackground: '#33425e' } });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit);
  const s = { id, nodeId: n.id(), name: d.name, tab, pane, term, fit, ws: null, status: 'connecting', rec: null };
  setRec(s, null);
  sessions.set(id, s);
  pane.classList.add('active'); term.open(pane); fit.fit(); activate(id);

  const ws = new WebSocket(wsUrl('/ssh'));
  s.ws = ws;
  const out = s.out = (t) => ws.readyState === 1 && ws.send(JSON.stringify(t));
  term.writeln(`\x1b[90mConnecting to ${d.host}:${d.port || 22} ...\x1b[0m`);

  ws.onopen = () => out({ type: 'connect', host: d.host, port: d.port, cols: term.cols, rows: term.rows, ...c });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'ready') { setStatus(s, 'live'); term.focus(); }
    else if (m.type === 'data') term.write(m.data);
    else if (m.type === 'log' && m.on) { setRec(s, m.file); note(s, `● Recording to ${m.file}`); }
    else if (m.type === 'log') { setRec(s, null); note(s, `■ Recording saved: ${m.file}`); }
    else if (m.type === 'log-error') { setRec(s, null); note(s, `Recording failed: ${m.message}`, 31); }
    else if (m.type === 'notice') note(s, m.message, m.level === 'warn' ? 33 : 90);
    else if (m.type === 'error') {
      term.writeln(`\r\n\x1b[31mConnection failed: ${m.message}\x1b[0m`);
      if (/authentication/i.test(m.message)) { credCache.delete(n.id()); term.writeln('\x1b[90mSaved password cleared. Open SSH again to retry.\x1b[0m'); }
      setStatus(s, 'dead');
    }
  };
  ws.onclose = () => {
    if (s.rec && s.rec !== 'pending') note(s, `■ Recording saved: ${s.rec}`);
    setRec(s, null);
    if (s.status !== 'dead') term.writeln('\r\n\x1b[90m[session closed]\x1b[0m'); setStatus(s, 'dead');
  };
  term.onData((x) => out({ type: 'data', data: x }));
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && isRecKey(e)) { e.preventDefault(); toggleRec(s); return false; }
    return !isRecKey(e);
  });
  term.onResize(({ cols, rows }) => out({ type: 'resize', cols, rows }));

  tab.onclick = () => activate(id);
  tab.querySelector('.x').onclick = (e) => { e.stopPropagation(); closeSession(id); };
  tab.querySelector('.rec').onclick = (e) => { e.stopPropagation(); toggleRec(s); };
}

function closeSession(id) {
  const s = sessions.get(id); if (!s) return;
  // Like browser tabs: closing the active tab moves to its right-hand neighbour, else the left.
  const near = s.tab.nextElementSibling || s.tab.previousElementSibling;
  s.ws.close(); s.term.dispose(); s.tab.remove(); s.pane.remove(); sessions.delete(id);
  if (activeId === id) {
    const next = near && Number(near.dataset.id);
    activeId = null;
    if (next) activate(next); else { dock.classList.remove('open'); refreshMap(); }
  } else refreshMap();
}

export function initSessions() {
  // Tabs: drag left/right to reorder.
  const tabsEl = $('#tabs');
  tabsEl.addEventListener('pointerdown', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab || e.button !== 0 || e.target.closest('button')) return;
    const startX = e.clientX, grab = e.clientX - tab.getBoundingClientRect().left;
    let dragging = false;
    const move = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 5) return; // below this it is a click
        dragging = true; tab.classList.add('dragging'); tab.setPointerCapture(ev.pointerId);
        activate(Number(tab.dataset.id));
      }
      // Scroll the strip when dragging near its edges.
      const box = tabsEl.getBoundingClientRect();
      if (ev.clientX < box.left + 30) tabsEl.scrollLeft -= 12; else if (ev.clientX > box.right - 30) tabsEl.scrollLeft += 12;
      // Drop the tab before the first other tab whose middle is right of the pointer.
      const ref = [...tabsEl.children].find((t) => t !== tab && (() => { const r = t.getBoundingClientRect(); return ev.clientX < r.left + r.width / 2; })()) || null;
      if (ref !== tab.nextElementSibling) tabsEl.insertBefore(tab, ref);
      // Keep the tab under the pointer, within the strip.
      tab.style.transform = '';
      const slot = tab.getBoundingClientRect(), x = Math.max(box.left, Math.min(box.right - slot.width, ev.clientX - grab));
      tab.style.transform = `translateX(${x - slot.left}px)`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      if (!dragging) return;
      tab.classList.remove('dragging'); tab.style.transform = '';
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  });

  // Dock: minimise, drag-resize, refit the terminal.
  $('#bMin').onclick = () => { dock.classList.toggle('min'); if (!dock.classList.contains('min') && activeId) activate(activeId); };
  $('#grip').addEventListener('pointerdown', (e) => {
    e.target.setPointerCapture(e.pointerId);
    const move = (ev) => { dock.classList.remove('min'); dock.style.height = Math.max(90, Math.min(window.innerHeight - 140, window.innerHeight - ev.clientY)) + 'px'; };
    const up = () => { e.target.removeEventListener('pointermove', move); e.target.removeEventListener('pointerup', up); };
    e.target.addEventListener('pointermove', move); e.target.addEventListener('pointerup', up);
  });
  new ResizeObserver(() => { const s = sessions.get(activeId); if (s && !dock.classList.contains('min')) s.fit.fit(); }).observe($('#panes'));
}
