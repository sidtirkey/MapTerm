// Credential sets: the Credentials window and the edit form. Secrets never come back to
// the page; the server keeps them in the OS keychain and only reports names and usernames.
import { $, getJSON, postJSON, plural } from './dom.js';
import { ask } from './dialog.js';
import { realNodes, save, flushSave } from './map.js';

let credSets = [], credInfo = {};

export const credSet = (id) => id && credSets.find((c) => c.id === id);
export const credOptions = () => Object.fromEntries(credSets.map((c) => [c.id, `${c.name} (${c.username})`]));

async function loadCreds() {
  const r = await getJSON('/api/credentials').catch(() => null);
  if (r) { credSets = r.sets; credInfo = r; }
}

const credSummary = (c) => `${c.username} · ${c.auth === 'key' ? 'SSH key' : 'password'}${c.hasEnable ? ' · enable password' : ''}`;

function renderCreds() {
  $('#credstore').textContent = credInfo.persistent
    ? `Passwords are kept in your ${credInfo.store}, not in MapTerm's files.`
    : `Passwords are kept in ${credInfo.store || 'memory only'}.`;
  const list = $('#credlist');
  list.replaceChildren();
  if (!credSets.length) { list.innerHTML = '<li id="credempty">No credential sets yet. Add one, then choose it in a device\'s Edit form.</li>'; return; }
  credSets.forEach((c) => {
    const li = document.createElement('li');
    const used = c.used; // devices using it, in all maps
    li.innerHTML = '<div class="who"><b></b><small></small></div><button>Edit</button><button class="danger">Delete</button>';
    li.querySelector('b').textContent = c.name;
    li.querySelector('small').textContent = `${credSummary(c)} · ${plural(used, 'device')}`;
    const [edit, del] = li.querySelectorAll('button');
    edit.onclick = async () => { await editCred(c); renderCreds(); };
    del.onclick = async () => {
      if (!(await ask(`Delete "${c.name}"?`, [], 'Delete', used === 1 ? '1 device uses it; it will ask for credentials when connecting.' : used ? `${used} devices use it; they will ask for credentials when connecting.` : ''))) return;
      await fetch('/api/credentials/' + c.id, { method: 'DELETE' });
      realNodes().filter((n) => n.data('credId') === c.id).forEach((n) => n.data('credId', ''));
      save(); await loadCreds(); renderCreds();
    };
    list.appendChild(li);
  });
}

// Create (c = null) or edit a set. Blank secret fields on an edit keep the saved values.
async function editCred(c) {
  let v = { name: c?.name || '', username: c?.username || '', auth: c?.auth || 'password', keyPath: c?.keyPath || '' };
  let note = c ? 'Leave password fields blank to keep the saved ones.' : '';
  for (;;) {
    const fields = [
      { key: 'name', label: 'Name', value: v.name, placeholder: 'e.g. Core switches' },
      { key: 'username', label: 'Username', value: v.username },
      { key: 'auth', label: 'Sign in with', value: v.auth, options: { password: 'Password', key: 'SSH key' } },
      { key: 'password', label: 'Password', type: 'password', value: v.password, showIf: ['auth', 'password'] },
      { key: 'keyPath', label: 'Private key file', value: v.keyPath, placeholder: '~/.ssh/id_ed25519', showIf: ['auth', 'key'] },
      { key: 'passphrase', label: 'Key passphrase (if the key has one)', type: 'password', value: v.passphrase, showIf: ['auth', 'key'] },
      { key: 'enable', label: c?.hasEnable ? 'Enable password (blank keeps the saved one)' : 'Enable password (optional)', type: 'password', value: v.enable },
    ];
    if (c?.hasEnable) fields.push({ key: 'clearEnable', label: 'Saved enable password', value: v.clearEnable || '', options: { '': 'Keep it', yes: 'Remove it' } });
    const r0 = await ask(c ? `Edit "${c.name}"` : 'New credential set', fields, 'Save', note);
    if (!r0) return null;
    v = r0;
    const r = await postJSON('/api/credentials', { ...r0, id: c?.id, clearEnable: r0.clearEnable === 'yes' });
    if (r.ok) { await loadCreds(); return r.set; }
    note = r.error;
  }
}

async function openCreds() { await flushSave(); await loadCreds(); renderCreds(); $('#credmodal').style.display = 'flex'; $('#credAdd').focus(); }

export function initCredentials() {
  loadCreds();
  $('#bCreds').onclick = openCreds;
  $('#credAdd').onclick = async () => { await editCred(null); renderCreds(); };
  $('#credClose').onclick = () => { $('#credmodal').style.display = 'none'; };
}
