// "Run commands": choose devices on the map, enter commands, confirm changes, and follow
// the run in the progress panel. The server does the work (src/server/batch.js).
import { $, wsUrl, getJSON, postJSON, plural, remembered } from './dom.js';
import { ask } from './dialog.js';
import { cy, setMode, realNodes } from './map.js';
import { pickFolder } from './settings.js';
import { currentMapId } from './maps.js';
import { credOptions, credSet } from './credentials.js';
import { credCache } from './sessions.js';
import { classify } from './commands.js';

let run = null; // the current or last run: { ws, done, dir }

const lastCommands = remembered('commands'), lastLayout = remembered('layout'), lastCred = remembered('cred');
const LAYOUTS = { device: 'One file per device', command: 'One file per command (a folder per device)' };

export const runInProgress = () => !!run && !run.done;

export function updatePickbar() {
  const n = cy.nodes('.chosen').length;
  $('#pickcount').textContent = `${plural(n, 'device')} selected`;
  $('#pNext').disabled = !n;
}

// Asks before running commands that may change devices; optionally tests on one device first.
// Resolves to { canary } to go ahead, or null.
async function confirmChanges(commands, nodes) {
  const flagged = commands.map((c) => [c, classify(c)]).filter(([, k]) => k !== 'read');
  if (!flagged.length) return { canary: false };
  const n = nodes.length, first = nodes[0].data('name');
  const explain = (error) => {
    const el = document.createElement('div');
    if (error) { const e = document.createElement('span'); e.className = 'err'; e.textContent = error; el.append(e); }
    const ul = document.createElement('ul'); ul.className = 'cmdlist';
    flagged.forEach(([c, k]) => { const li = document.createElement('li'); li.textContent = c; if (k === 'disruptive') li.className = 'disruptive'; ul.append(li); });
    el.append(`${plural(flagged.length, 'command')} may change ${n === 1 ? 'the device' : 'the devices'}:`, ul, `They will run on ${plural(n, 'device')}.`);
    return el;
  };
  const how = { key: 'how', label: 'How to run', value: 'canary', options: { canary: `Test on ${first} first, then decide on the rest`, all: `Run on all ${n} devices at once` } };
  let note = explain();
  for (;;) {
    const v = await ask('Confirm changes', [...(n > 1 ? [how] : []), { key: 'confirm', label: `Type ${n} to confirm`, placeholder: String(n) }], 'Run', note);
    if (!v) return null;
    if (v.confirm.trim() === String(n)) return { canary: n > 1 && v.how === 'canary' };
    if (v.how) how.value = v.how;
    note = explain(`Type ${n}, the number of devices, to confirm.`);
  }
}

async function askRun() {
  const nodes = cy.nodes('.chosen');
  const about = `Runs on ${plural(nodes.length, 'device')}: ${nodes.map((n) => n.data('name')).join(', ')}`;
  const credChoices = { device: "Each device's own credentials", ...credOptions(), type: 'Type them in for this run' };
  const mapId = currentMapId(), map = await getJSON(`/api/maps/${mapId}`); // results go to this map's folder
  let v = { commands: lastCommands.get(), layout: lastLayout.get() || 'device', cred: lastCred.get() || 'device', runDir: map.runDir || map.suggestRunDir };
  let note = about, typed = null;
  for (;;) {
    v = await ask('Run commands', [
      { key: 'commands', label: 'Commands, one per line', value: v.commands, textarea: true, placeholder: 'show version\nshow ip interface brief' },
      { key: 'cred', label: 'Credentials', value: v.cred, options: credChoices },
      { key: 'runDir', label: 'Save results in', value: v.runDir, browse: (x) => pickFolder(x, 'run') },
      { key: 'layout', label: 'Save output as', value: v.layout, options: LAYOUTS },
    ], 'Next', note);
    if (!v) return;
    const commands = v.commands.split('\n').map((c) => c.trimEnd()).filter((c) => c.trim());
    if (!commands.length) { note = `Enter at least one command.\n${about}`; continue; }
    const r = await postJSON(`/api/maps/${mapId}`, { runDir: v.runDir }, 'PATCH');
    if (!r.ok) { note = `${r.error}\n${about}`; continue; }

    // Work out each device's credentials.
    if (v.cred === 'type') {
      const u = [...new Set(nodes.map((n) => n.data('username') || ''))];
      typed = await ask('Credentials for this run', [
        { key: 'username', label: 'Username', value: typed?.username ?? (u.length === 1 ? u[0] : '') },
        { key: 'password', label: 'Password', type: 'password', value: typed?.password },
        { key: 'enable', label: 'Enable password (optional)', type: 'password', value: typed?.enable },
      ], 'Next', `Used for all ${plural(nodes.length, 'device')} and not saved.`);
      if (!typed) continue;
      if (!typed.username || !typed.password) { note = `Enter a username and password.\n${about}`; continue; }
    }
    const devices = [], missing = [];
    nodes.forEach((n) => {
      const d = n.data(), dev = { id: n.id(), name: d.name, protocol: d.protocol || 'ssh', host: d.host, port: d.port };
      if (v.cred === 'type') Object.assign(dev, { username: typed.username, password: typed.password, enable: typed.enable });
      else if (v.cred !== 'device') dev.credId = v.cred;
      else if (credSet(d.credId)) dev.credId = d.credId;
      else if (credCache.has(n.id())) Object.assign(dev, credCache.get(n.id()));
      else missing.push(d.name);
      devices.push(dev);
    });
    if (missing.length) { note = `No saved credentials for ${missing.join(', ')}. Give them a credential set, or choose one above.\n${about}`; continue; }

    const go = await confirmChanges(commands, nodes);
    if (!go) continue;
    lastCommands.set(v.commands); lastLayout.set(v.layout); lastCred.set(v.cred);
    setMode('select');
    return startRun(mapId, devices, commands, v.layout, go.canary);
  }
}

function startRun(mapId, devices, commands, layout, canary) {
  const rows = {};
  $('#runlist').replaceChildren(...devices.map((d) => {
    const li = document.createElement('li');
    li.innerHTML = '<i></i><span></span><small>Waiting</small>';
    li.querySelector('span').textContent = d.name;
    return (rows[d.id] = li);
  }));
  $('#runtitle').textContent = `Running on ${plural(devices.length, 'device')}…`;
  $('#rundir').textContent = '';
  $('#runStop').style.display = ''; $('#runStop').disabled = false; $('#runOpen').style.display = 'none'; $('#runGo').style.display = 'none';
  $('#runnote').style.display = 'none';
  $('#runpanel').classList.add('on');

  const ws = new WebSocket(wsUrl('/ssh'));
  const r = run = { ws, done: false, dir: null };
  const finish = (title) => {
    if (r.done) return;
    r.done = true; ws.close();
    $('#runtitle').textContent = title;
    $('#runStop').style.display = 'none'; $('#runGo').style.display = 'none'; $('#runnote').style.display = 'none';
    $('#runOpen').style.display = r.dir ? '' : 'none';
  };
  const labels = { connecting: 'Connecting…', running: 'Logged in', done: 'Done', warn: 'Done', failed: 'Failed' };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'batch', mapId, devices, commands, layout, canary }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'batch-started') {
      r.dir = m.dir; $('#rundir').textContent = m.dir;
      if (m.canary) $('#runtitle').textContent = `Testing on ${devices[0].name} first…`;
    } else if (m.type === 'batch-paused') {
      // First device done: wait for the user to check it before touching the rest.
      $('#runtitle').textContent = m.ok ? `Tested on ${m.name}` : `Test on ${m.name} failed`;
      const others = m.remaining === 1 ? 'the other device' : `the other ${m.remaining} devices`;
      $('#runnote').textContent = m.ok ? `Check its output (Open folder), then continue on ${others} or stop.`
        : `${m.detail}. ${others[0].toUpperCase() + others.slice(1)} ${m.remaining === 1 ? 'has' : 'have'} not been touched.`;
      $('#runnote').style.display = 'block';
      $('#runGo').textContent = m.ok ? `Continue on ${plural(m.remaining, 'device')}` : 'Continue anyway';
      $('#runGo').style.display = ''; $('#runOpen').style.display = '';
      $('#runpanel').classList.add('on');
    } else if (m.type === 'batch-status' && rows[m.id]) {
      const li = rows[m.id], small = li.querySelector('small');
      li.className = m.state; small.textContent = small.title = m.detail || labels[m.state] || '';
    } else if (m.type === 'batch-done') finish(`Finished: ${m.ok} succeeded${m.failed ? `, ${m.failed} failed` : ''}`);
    else if (m.type === 'batch-error') finish(m.message);
  };
  ws.onclose = () => finish('Lost connection to the MapTerm server');
}

export function initRun() {
  $('#bRun').onclick = () => (run && !run.done ? $('#runpanel').classList.add('on') : setMode('pick'));
  $('#pAll').onclick = () => { realNodes().addClass('chosen'); updatePickbar(); };
  $('#pClear').onclick = () => { cy.nodes().removeClass('chosen'); updatePickbar(); };
  $('#pCancel').onclick = () => setMode('select');
  $('#pNext').onclick = () => askRun();

  $('#runStop').onclick = () => {
    if (!run || run.done) return;
    run.ws.send(JSON.stringify({ type: 'batch-stop' }));
    $('#runStop').disabled = true; $('#runtitle').textContent = 'Stopping…';
  };
  $('#runOpen').onclick = async () => {
    if (!run || !run.dir) return;
    const r = await postJSON('/api/open-folder', { path: run.dir });
    if (!r.ok) { $('#runnote').textContent = r.error; $('#runnote').style.display = 'block'; }
  };
  $('#runGo').onclick = () => {
    if (!run || run.done) return;
    run.ws.send(JSON.stringify({ type: 'batch-continue' }));
    $('#runGo').style.display = 'none'; $('#runOpen').style.display = 'none'; $('#runnote').style.display = 'none';
    $('#runtitle').textContent = 'Running on the rest…';
  };
  $('#runX').onclick = () => $('#runpanel').classList.remove('on');
}
