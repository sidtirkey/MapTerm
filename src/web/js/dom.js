// Small DOM, network and storage helpers shared by the page's modules.

export const $ = (s) => document.querySelector(s);

export const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export const wsUrl = (path) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;

export const getJSON = (url) => fetch(url).then((r) => r.json());
export const postJSON = (url, body, method = 'POST') => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then((r) => r.json()).catch(() => ({ error: 'Could not reach the MapTerm server.' }));

// A value remembered in this browser between visits (e.g. the last commands run).
// Keys were "netmap.*" under the project's earlier name; those values are still read.
export const remembered = (name) => ({
  get() { try { return localStorage.getItem('mapterm.' + name) ?? localStorage.getItem('netmap.' + name) ?? ''; } catch { return ''; } },
  set(v) { try { localStorage.setItem('mapterm.' + name, v); } catch {} },
});
